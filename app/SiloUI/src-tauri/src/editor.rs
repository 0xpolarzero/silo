//! Local editor handoff over MicroSandbox's SSH transport. Guest paths never
//! become host filesystem arguments. SSH keys and configuration stay on host.
use crate::{
    applications,
    runtime::{self, RuntimePaths},
};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

/// Serializes SSH key and configuration file writes only. Never hold it across
/// remote calls, guest commands, probes or editor launches: the desktop viewer
/// and remote authorization wait on it (G-22).
static LOCK: Mutex<()> = Mutex::new(());
const FAILED: &str = "Could not prepare the editor connection.";

/// The guard protects no in-memory state and every file write is atomic, so a
/// panic while holding it leaves nothing inconsistent; recover instead of
/// failing every editor connection until restart (G-23).
fn files_lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn open(app: &AppHandle, name: &str, path: Option<&str>) -> Result<(), String> {
    if let Some((host, vm)) = crate::remote_access::target(name)? {
        let path = path.unwrap_or("/workspace");
        let (alias, _) = prepare_remote(app, &host, &vm, path)?;
        let application = applications::selected_editor(app)?;
        let (executable, zed) = applications::editor_command(&application)?;
        let home = app.path().home_dir().map_err(|_| FAILED)?;
        let mut launch = editor_launch(&executable, zed, &alias, path, &home)?;
        return run(&mut launch, Duration::from_secs(10));
    }
    require_openssh("open VM folders in your editor")?;
    runtime::validate_name(name).map_err(|error| error.to_string())?;
    let path = path.unwrap_or("/workspace");
    validate_path(path)?;
    let application = applications::selected_editor(app)?;
    let (executable, zed) = applications::editor_command(&application)?;
    let paths = runtime::runtime_paths(app)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|error| error.to_string())?;
    if !metadata
        .machines
        .iter()
        .any(|machine| machine.name() == name && machine.is_vm())
    {
        return Err("This sandbox does not support local editor connections.".into());
    }
    let inspected = crate::terminal::running_vm(&paths, name)?;
    let user = crate::working_account::working_user(&inspected.config)?;
    // Validate the exact folder inside the guest, as positional data, before handoff.
    runtime::run_msb(
        &paths,
        &[
            "exec".into(),
            name.into(),
            "--no-start".into(),
            "--user".into(),
            user.into(),
            "--env".into(), format!("USER={user}"),
            "--env".into(), format!("LOGNAME={user}"),
            "--no-tty".into(),
            "--quiet".into(),
            "--timeout".into(),
            "5s".into(),
            "--".into(),
            "test".into(),
            "-d".into(),
            path.into(),
        ],
        Duration::from_secs(8),
    )
    .map_err(|_| "This folder is unavailable inside the VM.")?;
    let user_home = app.path().home_dir().map_err(|_| FAILED)?;
    let (alias, config) = prepare(&paths, &user_home, name)?;
    let mut probe = Command::new("/usr/bin/ssh");
    probe.args(["-F"]).arg(&config).args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        &alias,
        "true",
    ]);
    run(&mut probe, Duration::from_secs(10)).map_err(|_| {
        "Could not connect to this VM over SSH. Retry after checking that it is running."
    })?;
    let mut launch = editor_launch(&executable, zed, &alias, path, &user_home)?;
    run(&mut launch, Duration::from_secs(10)).map_err(|_| {
        "The editor could not be opened. Check its installation and Remote SSH support.".to_string()
    })
}

/// Explains a missing system OpenSSH client instead of a generic failure.
pub(crate) fn require_openssh(purpose: &str) -> Result<(), String> {
    require_openssh_at(Path::new("/usr/bin/ssh"), Path::new("/usr/bin/ssh-keygen"), purpose)
}
fn require_openssh_at(ssh: &Path, keygen: &Path, purpose: &str) -> Result<(), String> {
    if ssh.is_file() && keygen.is_file() {
        Ok(())
    } else {
        Err(format!("OpenSSH is required to {purpose}. Install your system's OpenSSH client and retry."))
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.len() > 4096
        || path.contains('\0')
        || !(path == "/workspace"
            || path.strip_prefix("/workspace/").is_some_and(|tail| {
                tail.split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
            }))
    {
        return Err("Choose a folder inside /workspace.".into());
    }
    Ok(())
}

/// VS Code profile for every Silo sandbox window, so the settings below and
/// the extensions that can reach the sandbox never mix with the user's own
/// profile (decision 5, G-19). VS Code creates it empty on first use and
/// offers to install Remote - SSH into it.
const VSCODE_PROFILE: &str = "Silo";
/// Carried by a Silo-owned workspace file on the host. Workspace settings
/// apply from the first window, whether or not the profile exists yet, and
/// outrank the "Remote" settings a sandbox can write for itself.
const VSCODE_SETTINGS: [(&str, bool); 4] = [
    // Git in the sandbox cannot borrow the host VS Code's GitHub session.
    ("github.gitAuthentication", false),
    // Sandbox terminals get no askpass handle back to the host VS Code.
    ("git.terminalAuthentication", false),
    // Sandbox ports reach this computer only through Silo's port publishing.
    ("remote.autoForwardPorts", false),
    ("remote.forwardOnOpen", false),
];

/// The editor command for a sandbox folder: Zed receives its SSH URI; VS Code
/// opens the Silo profile with the folder's Silo workspace file.
fn editor_launch(
    executable: &Path,
    zed: bool,
    alias: &str,
    path: &str,
    user_home: &Path,
) -> Result<Command, String> {
    let mut launch = Command::new(executable);
    if zed {
        launch.arg(remote_uri(alias, path, true)?);
    } else {
        launch
            .args(["--profile", VSCODE_PROFILE])
            .arg(vscode_workspace(&user_home.join(".silo"), alias, path)?);
    }
    Ok(launch)
}

/// Writes `~/.silo/editor/<alias>/<path hash>/<folder>.code-workspace`, keeping
/// any other workspace settings the user added and restoring Silo's own.
fn vscode_workspace(silo_root: &Path, alias: &str, path: &str) -> Result<PathBuf, String> {
    use sha2::{Digest, Sha256};
    validate_path(path)?;
    if alias.is_empty() || !alias.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return Err(FAILED.into());
    }
    runtime::prepare_private_directory(silo_root).map_err(|_| FAILED)?;
    let mut directory = silo_root.join("editor");
    private_directory(&directory)?;
    directory.push(alias);
    private_directory(&directory)?;
    directory.push(&format!("{:x}", Sha256::digest(path.as_bytes()))[..12]);
    private_directory(&directory)?;
    let folder: String = path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || " -_.".contains(character) { character } else { '_' }
        })
        .take(64)
        .collect();
    let folder = folder.trim_start_matches('.').trim();
    let file = directory.join(format!(
        "{}.code-workspace",
        if folder.is_empty() { "workspace" } else { folder }
    ));
    let mut document = serde_json::from_slice::<serde_json::Value>(&read_regular(&file)?)
        .ok()
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    document["folders"] = serde_json::json!([{ "uri": remote_uri(alias, path, false)? }]);
    document["remoteAuthority"] = serde_json::json!(format!("ssh-remote+{alias}"));
    if !document["settings"].is_object() {
        document["settings"] = serde_json::json!({});
    }
    for (key, value) in VSCODE_SETTINGS {
        document["settings"][key] = serde_json::json!(value);
    }
    let bytes = serde_json::to_vec_pretty(&document).map_err(|_| FAILED)?;
    write_private(&file, &bytes)?;
    Ok(file)
}

fn remote_uri(alias: &str, path: &str, zed: bool) -> Result<String, String> {
    let mut uri = reqwest::Url::parse(&if zed {
        format!("ssh://{alias}/")
    } else {
        format!("vscode-remote://ssh-remote+{alias}/")
    })
    .map_err(|_| FAILED)?;
    uri.set_path(path);
    Ok(uri.into())
}

pub(crate) fn private_directory(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(FAILED.into());
        }
    }
    fs::create_dir_all(path).map_err(|_| FAILED)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| FAILED.into())
}

pub(crate) fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 1024 * 1024 =>
        {
            fs::read(path).map_err(|_| FAILED.into())
        }
        Ok(_) => Err(
            "The SSH configuration cannot be updated safely. Check its file type and size.".into(),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(FAILED.into()),
    }
}

pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    read_regular(path)?;
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or(FAILED)?).map_err(|_| FAILED)?;
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| FAILED)?;
    file.write_all(bytes).map_err(|_| FAILED)?;
    file.as_file().sync_all().map_err(|_| FAILED)?;
    file.persist(path).map_err(|_| FAILED)?;
    Ok(())
}

pub(crate) fn key(path: &Path) -> Result<(), String> {
    if !read_regular(path)?.is_empty() {
        return Ok(());
    }
    let mut command = Command::new("/usr/bin/ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "Silo", "-f"])
        .arg(path);
    run(&mut command, Duration::from_secs(5))
}

pub(crate) fn public_key(path: &Path) -> Result<String, String> {
    let output = Command::new("/usr/bin/ssh-keygen")
        .args(["-y", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| FAILED)?;
    if !output.status.success() {
        return Err(FAILED.into());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| FAILED)?;
    let mut fields = text.split_whitespace();
    let kind = fields.next().ok_or(FAILED)?;
    let value = fields.next().ok_or(FAILED)?;
    if kind != "ssh-ed25519" || value.len() > 256 {
        return Err(FAILED.into());
    }
    Ok(format!("{kind} {value}"))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn ssh_quote(path: &Path) -> Result<String, String> {
    let text = path.to_str().ok_or(FAILED)?;
    if text.chars().any(char::is_control) {
        return Err(FAILED.into());
    }
    Ok(format!(
        "\"{}\"",
        text.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    ))
}

fn prepare(
    paths: &RuntimePaths,
    user_home: &Path,
    name: &str,
) -> Result<(String, PathBuf), String> {
    let root = paths.home.join("ssh");
    let config = root.join(format!("{name}.conf"));
    let known_hosts = root.join(format!("{name}.known_hosts"));
    let alias = prepare_configuration(paths, name, &config, &known_hosts)?;
    let _guard = files_lock();
    install_include(user_home, &format!("Include {}", ssh_quote(&root.join("*.conf"))?))?;
    Ok((alias, config))
}

fn owned(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.uid() == unsafe { libc::geteuid() }
}

fn manual_include(config: &Path, include: &str) -> String {
    format!(
        "Silo can't safely update {}, which links to a file it can't change. Add this line at the top of that file, then try again: {include}",
        config.display()
    )
}

fn has_line(contents: &[u8], line: &str) -> bool {
    contents.split(|byte| *byte == b'\n').any(|current| current == line.as_bytes())
}

/// Prepends Silo's `Include` to the user's SSH configuration once. Links from
/// dotfile managers (stow, chezmoi) are followed when they lead to a folder or
/// file this account owns; otherwise, such as a read-only home-manager file,
/// the user gets the exact line to add (G-11).
fn install_include(user_home: &Path, include: &str) -> Result<(), String> {
    let link = user_home.join(".ssh");
    let user_config = link.join("config");
    let manual = || manual_include(&user_config, include);
    let ssh_root = match fs::symlink_metadata(&link) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = fs::canonicalize(&link).map_err(|_| manual())?;
            match fs::metadata(&target) {
                Ok(metadata) if metadata.is_dir() && owned(&metadata) => target,
                _ => return Err(manual()),
            }
        }
        _ => {
            private_directory(&link)?;
            link.clone()
        }
    };
    let config = ssh_root.join("config");
    if !fs::symlink_metadata(&config).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        let old = read_regular(&config)?;
        if !has_line(&old, include) {
            let mut new = format!("{include}\n").into_bytes();
            new.extend_from_slice(&old);
            write_private(&config, &new)?;
        }
        return Ok(());
    }
    let target = fs::canonicalize(&config).map_err(|_| manual())?;
    let old = read_regular(&target)?;
    if has_line(&old, include) {
        return Ok(());
    }
    let parent_owned = target
        .parent()
        .and_then(|parent| fs::metadata(parent).ok())
        .is_some_and(|metadata| owned(&metadata));
    if !parent_owned || !fs::metadata(&target).is_ok_and(|metadata| metadata.is_file() && owned(&metadata)) {
        return Err(manual());
    }
    let mut new = format!("{include}\n").into_bytes();
    new.extend_from_slice(&old);
    // Replacing the resolved file keeps the user's link in place.
    replace_file(&target, &new).map_err(|_| manual())
}

/// Atomically replaces a regular file and keeps its permission bits.
fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let mode = fs::metadata(path)?.mode() & 0o666;
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.as_file().set_permissions(fs::Permissions::from_mode(mode))?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// Private connections share the editor's host-only identity, without installing
/// an Include in the user's SSH configuration or changing editor connection files.
pub(crate) fn prepare_private_transport(
    paths: &RuntimePaths,
    name: &str,
    directory: &Path,
) -> Result<(String, PathBuf), String> {
    runtime::validate_name(name).map_err(|error| error.to_string())?;
    private_directory(directory)?;
    let config = directory.join("ssh_config");
    let known_hosts = directory.join("known_hosts");
    let alias = prepare_configuration(paths, name, &config, &known_hosts)?;
    Ok((alias, config))
}

fn prepare_configuration(
    paths: &RuntimePaths,
    name: &str,
    config: &Path,
    known_hosts: &Path,
) -> Result<String, String> {
    let user = crate::working_account::inspect_user(paths, name)?;
    let _guard = files_lock();
    let root = paths.home.join("ssh");
    private_directory(&root)?;
    let client = root.join("silo_ed25519");
    key(&client)?;
    let authorized = root.join("authorized_keys");
    let public = public_key(&client)?;
    let mut contents = read_regular(&authorized)?;
    let text = std::str::from_utf8(&contents).map_err(|_| FAILED)?;
    if !text.lines().any(|line| line == public) {
        if !contents.is_empty() && !contents.ends_with(b"\n") {
            contents.push(b'\n');
        }
        contents.extend_from_slice(format!("{public}\n").as_bytes());
        write_private(&authorized, &contents)?;
    }
    let host_root = paths.home.join("sandboxes").join(name).join("ssh");
    private_directory(&host_root)?;
    let host_key = host_root.join("host_ed25519");
    key(&host_key)?;
    let suffix = paths
        .home
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(FAILED)?;
    let alias = format!("silo-{suffix}-{name}");
    write_private(
        &known_hosts,
        format!("{alias} {}\n", public_key(&host_key)?).as_bytes(),
    )?;
    let proxy = [
        "/usr/bin/env".to_owned(),
        format!("MSB_HOME={}", paths.home.display()),
        format!("MSB_PATH={}", paths.executable.display()),
        format!("MSB_LIBKRUNFW_PATH={}", paths.library.display()),
        paths.executable.to_string_lossy().into_owned(),
        "ssh".into(),
        "serve".into(),
        name.into(),
        "--stdio".into(),
        "--no-start".into(),
        "--no-inactivity-timeout".into(),
    ]
    .iter()
    .map(|part| quote(&part.replace('%', "%%")))
    .collect::<Vec<_>>()
    .join(" ");
    let content = format!("Host {alias}\n  HostName {alias}\n  User {user}\n  IdentityFile {}\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  ForwardX11 no\n  UserKnownHostsFile {}\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ProxyCommand {proxy}\n\nHost *\n", ssh_quote(&client)?, ssh_quote(&known_hosts)?);
    write_private(&config, content.as_bytes())?;
    Ok(alias)
}

fn run(command: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| FAILED)?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(FAILED.into())
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(FAILED.into());
            }
        }
    }
}

pub(crate) fn validate_public_key(public: &str) -> Result<(), String> {
    use base64::Engine;
    let mut parts = public.split(' ');
    if parts.next() != Some("ssh-ed25519") { return Err("Expected an Ed25519 public key.".into()) }
    let encoded = parts.next().ok_or("Missing public key.")?;
    if parts.next().is_some() || encoded.len() > 128 { return Err("Invalid public key.".into()) }
    let data = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "Invalid public key.")?;
    if data.len() != 51 || &data[..19] != b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" {
        return Err("Invalid Ed25519 public key.".into());
    }
    Ok(())
}

pub(crate) fn authorize_remote(paths: &RuntimePaths, name: &str, public: &str, path: &str) -> Result<String, String> {
    crate::runtime::shutdown::ensure_accepting_operations()?;
    validate_public_key(public)?;
    validate_path(path)?;
    let inspected = crate::terminal::running_vm(paths, name)?;
    let user = crate::working_account::working_user(&inspected.config)?;
    runtime::run_msb(paths, &[
        "exec".into(), name.into(), "--no-start".into(), "--user".into(),
        user.into(), "--env".into(), format!("USER={user}"), "--env".into(), format!("LOGNAME={user}"), "--no-tty".into(), "--quiet".into(),
        "--timeout".into(), "5s".into(), "--".into(), "test".into(), "-d".into(), path.into(),
    ], Duration::from_secs(8)).map_err(|_| "This folder is unavailable inside the VM.")?;
    let _guard = files_lock();
    let root = paths.home.join("ssh");
    private_directory(&root)?;
    let authorized = root.join("authorized_keys");
    let mut contents = read_regular(&authorized)?;
    if !std::str::from_utf8(&contents).map_err(|_| FAILED)?.lines().any(|line| line == public) {
        if !contents.is_empty() && !contents.ends_with(b"\n") { contents.push(b'\n'); }
        contents.extend_from_slice(format!("{public}\n").as_bytes());
        write_private(&authorized, &contents)?;
    }
    let host_root = paths.home.join("sandboxes").join(name).join("ssh");
    private_directory(&host_root)?;
    let host_key = host_root.join("host_ed25519");
    key(&host_key)?;
    public_key(&host_key)
}

/// Prepare the pinned guest SSH identity without changing the user's SSH configuration.
pub(crate) fn prepare_remote_private(app: &AppHandle, host: &str, vm: &str, path: &str) -> Result<(String, PathBuf), String> {
    validate_path(path)?;
    uuid::Uuid::parse_str(host).map_err(|_| "Invalid computer identity.")?;
    uuid::Uuid::parse_str(vm).map_err(|_| "Invalid VM identity.")?;
    let home = app.path().home_dir().map_err(|_| FAILED)?;
    crate::runtime::prepare_private_directory(&home.join(".silo")).map_err(|e| e.to_string())?;
    let root = home.join(".silo/desktop-remote/ssh");
    let client = root.join(format!("{host}.key"));
    let client_public = {
        let _guard = files_lock();
        private_directory(&root)?;
        key(&client)?;
        public_key(&client)?
    };
    // The remote call can take minutes; keep the file lock free meanwhile.
    let (host_public, user) = crate::remote_access::prepare(app, host, vm, &client_public, path)?;
    let _guard = files_lock();
    let alias = format!("silo-remote-{host}-{vm}");
    let known_hosts = root.join(format!("{host}-{vm}.known_hosts"));
    write_private(&known_hosts, format!("{alias} {host_public}\n").as_bytes())?;
    let executable = std::env::current_exe().map_err(|_| FAILED)?;
    let executable = executable.to_str().ok_or(FAILED)?;
    let proxy = [executable, "--remote-guest", host, vm].iter()
        .map(|value| quote(&value.replace('%', "%%"))).collect::<Vec<_>>().join(" ");
    let config = root.join(format!("{host}-{vm}.conf"));
    let contents = format!("Host {alias}\n  HostName {alias}\n  User {user}\n  IdentityFile {}\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  ForwardX11 no\n  UserKnownHostsFile {}\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ProxyCommand {proxy}\n\nHost *\n", ssh_quote(&client)?, ssh_quote(&known_hosts)?);
    write_private(&config, contents.as_bytes())?;
    Ok((alias, config))
}

pub(crate) fn prepare_remote(app: &AppHandle, host: &str, vm: &str, path: &str) -> Result<(String, PathBuf), String> {
    let (alias, config) = prepare_remote_private(app, host, vm, path)?;
    let root = config.parent().ok_or(FAILED)?;
    let home = app.path().home_dir().map_err(|_| FAILED)?;
    let _guard = files_lock();
    install_include(&home, &format!("Include {}", ssh_quote(&root.join("*.conf"))?))?;
    Ok((alias, config))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_panic_while_writing_ssh_files_does_not_disable_editor_connections() {
        let _ = std::thread::spawn(|| {
            let _guard = files_lock();
            panic!("simulated failure while holding the SSH file lock");
        })
        .join();
        assert!(LOCK.is_poisoned());
        drop(files_lock());
        let dir = tempfile::tempdir().unwrap();
        let _guard = files_lock();
        private_directory(&dir.path().join("ssh")).unwrap();
    }

    #[test]
    fn a_missing_openssh_client_is_explained() {
        let dir = tempfile::tempdir().unwrap();
        let ssh = dir.path().join("ssh");
        let keygen = dir.path().join("ssh-keygen");
        let error = require_openssh_at(&ssh, &keygen, "view VM desktops").unwrap_err();
        assert_eq!(error, "OpenSSH is required to view VM desktops. Install your system's OpenSSH client and retry.");
        fs::write(&ssh, b"").unwrap();
        assert!(require_openssh_at(&ssh, &keygen, "view VM desktops").is_err());
        fs::write(&keygen, b"").unwrap();
        assert!(require_openssh_at(&ssh, &keygen, "view VM desktops").is_ok());
    }

    #[test]
    fn remote_authorization_accepts_only_plain_ed25519_public_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("controller");
        key(&path).unwrap();
        let public = public_key(&path).unwrap();
        validate_public_key(&public).unwrap();
        for invalid in [format!("command=evil {public}"), format!("{public}\n{public}"), format!("{public} comment"), "ssh-ed25519 YQ==".into()] {
            assert!(validate_public_key(&invalid).is_err());
        }
    }
    #[test]
    fn remote_paths_stay_in_uri_and_are_encoded() {
        let uri = remote_uri("silo-test-dev", "/workspace/a b/#test?x", true).unwrap();
        assert_eq!(uri, "ssh://silo-test-dev/workspace/a%20b/%23test%3Fx");
        assert!(remote_uri("silo-test-dev", "/workspace", false)
            .unwrap()
            .starts_with("vscode-remote://ssh-remote+silo-test-dev/"));
        for invalid in ["/tmp", "/workspace/../tmp", "/workspace/a\0"] {
            assert!(validate_path(invalid).is_err());
        }
    }
    #[test]
    fn shell_and_ssh_paths_are_escaped() {
        assert_eq!(quote("a'b $()"), "'a'\\''b $()'");
        assert_eq!(ssh_quote(Path::new("/a%b\"c")).unwrap(), "\"/a%%b\\\"c\"");
    }
    #[test]
    fn private_writes_preserve_bytes_and_refuse_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("config");
        write_private(&file, b"Host existing\n  User user\n").unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(write_private(&link, b"replace").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"Host existing\n  User user\n");
    }

    fn launch_args(launch: &Command) -> Vec<String> {
        launch.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn vscode_opens_the_silo_profile_with_protective_workspace_settings() {
        let home = tempfile::tempdir().unwrap();
        let code = Path::new("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
        let launch = editor_launch(code, false, "silo-abc-dev", "/workspace/my repo", home.path()).unwrap();
        assert_eq!(launch.get_program(), code);
        let args = launch_args(&launch);
        assert_eq!(args[..2], ["--profile", "Silo"]);
        assert_eq!(args.len(), 3, "no --folder-uri: the workspace file names the folder");
        let file = PathBuf::from(&args[2]);
        assert!(file.starts_with(home.path().join(".silo/editor/silo-abc-dev")));
        assert_eq!(file.file_name().unwrap(), "my repo.code-workspace");
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        let document: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            document["folders"],
            serde_json::json!([{ "uri": "vscode-remote://ssh-remote+silo-abc-dev/workspace/my%20repo" }])
        );
        assert_eq!(document["remoteAuthority"], "ssh-remote+silo-abc-dev");
        assert_eq!(
            document["settings"],
            serde_json::json!({
                "github.gitAuthentication": false,
                "git.terminalAuthentication": false,
                "remote.autoForwardPorts": false,
                "remote.forwardOnOpen": false,
            })
        );
        // Another folder of the same sandbox gets its own workspace file.
        let other = editor_launch(code, false, "silo-abc-dev", "/workspace", home.path()).unwrap();
        assert_ne!(launch_args(&other)[2], args[2]);
        assert!(launch_args(&other)[2].ends_with("/workspace.code-workspace"));
    }

    #[test]
    fn user_workspace_settings_survive_while_silo_settings_are_restored() {
        let home = tempfile::tempdir().unwrap();
        let code = Path::new("/usr/bin/code");
        let args = launch_args(&editor_launch(code, false, "silo-abc-dev", "/workspace", home.path()).unwrap());
        fs::write(
            &args[2],
            br#"{"folders":[{"uri":"file:///elsewhere"}],"settings":{"editor.fontSize":15,"remote.autoForwardPorts":true}}"#,
        )
        .unwrap();
        editor_launch(code, false, "silo-abc-dev", "/workspace", home.path()).unwrap();
        let document: serde_json::Value = serde_json::from_slice(&fs::read(&args[2]).unwrap()).unwrap();
        assert_eq!(document["settings"]["editor.fontSize"], 15);
        assert_eq!(document["settings"]["remote.autoForwardPorts"], false);
        assert_eq!(document["folders"][0]["uri"], "vscode-remote://ssh-remote+silo-abc-dev/workspace");
    }

    #[test]
    fn zed_keeps_its_ssh_uri_and_no_workspace_file() {
        let home = tempfile::tempdir().unwrap();
        let launch = editor_launch(Path::new("/usr/bin/zed"), true, "silo-abc-dev", "/workspace", home.path()).unwrap();
        assert_eq!(launch_args(&launch), ["ssh://silo-abc-dev/workspace"]);
        assert!(!home.path().join(".silo").exists());
    }

    const INCLUDE: &str = "Include \"/home/user/.silo/abc/ssh/*.conf\"";

    #[test]
    fn a_stow_linked_ssh_config_is_updated_through_its_link() {
        let home = tempfile::tempdir().unwrap();
        let dotfiles = home.path().join("dotfiles/ssh");
        fs::create_dir_all(&dotfiles).unwrap();
        fs::write(dotfiles.join("config"), b"Host personal\n  User me\n").unwrap();
        fs::set_permissions(dotfiles.join("config"), fs::Permissions::from_mode(0o644)).unwrap();
        private_directory(&home.path().join(".ssh")).unwrap();
        std::os::unix::fs::symlink("../dotfiles/ssh/config", home.path().join(".ssh/config")).unwrap();
        install_include(home.path(), INCLUDE).unwrap();
        install_include(home.path(), INCLUDE).unwrap();
        let link = home.path().join(".ssh/config");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "the link stays");
        assert_eq!(
            fs::read(&link).unwrap(),
            format!("{INCLUDE}\nHost personal\n  User me\n").as_bytes()
        );
        assert_eq!(fs::metadata(&link).unwrap().permissions().mode() & 0o777, 0o644);
    }

    #[test]
    fn a_linked_ssh_folder_receives_a_new_config_without_replacing_the_link() {
        let home = tempfile::tempdir().unwrap();
        let dotfiles = home.path().join("dotfiles/ssh");
        fs::create_dir_all(&dotfiles).unwrap();
        std::os::unix::fs::symlink(&dotfiles, home.path().join(".ssh")).unwrap();
        install_include(home.path(), INCLUDE).unwrap();
        assert!(fs::symlink_metadata(home.path().join(".ssh")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(dotfiles.join("config")).unwrap(), format!("{INCLUDE}\n").as_bytes());
    }

    #[test]
    fn an_unwritable_linked_config_explains_the_line_to_add() {
        let home = tempfile::tempdir().unwrap();
        let store = home.path().join("store");
        fs::create_dir_all(&store).unwrap();
        fs::write(store.join("config"), b"Host managed\n").unwrap();
        private_directory(&home.path().join(".ssh")).unwrap();
        std::os::unix::fs::symlink(store.join("config"), home.path().join(".ssh/config")).unwrap();
        // Like a read-only home-manager file in the Nix store.
        fs::set_permissions(&store, fs::Permissions::from_mode(0o555)).unwrap();
        let error = install_include(home.path(), INCLUDE).unwrap_err();
        assert!(error.ends_with(&format!("Add this line at the top of that file, then try again: {INCLUDE}")), "{error}");
        assert_eq!(fs::read(store.join("config")).unwrap(), b"Host managed\n");
        // Once the user adds the line, nothing needs to be written.
        fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(store.join("config"), format!("{INCLUDE}\nHost managed\n")).unwrap();
        fs::set_permissions(&store, fs::Permissions::from_mode(0o555)).unwrap();
        install_include(home.path(), INCLUDE).unwrap();
        fs::set_permissions(&store, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_dangling_config_link_is_not_replaced() {
        let home = tempfile::tempdir().unwrap();
        private_directory(&home.path().join(".ssh")).unwrap();
        std::os::unix::fs::symlink("/silo-test-missing/config", home.path().join(".ssh/config")).unwrap();
        assert!(install_include(home.path(), INCLUDE).unwrap_err().contains(INCLUDE));
        assert!(fs::symlink_metadata(home.path().join(".ssh/config")).unwrap().file_type().is_symlink());
    }

    #[test]
    fn ssh_configuration_preserves_user_content_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("user");
        private_directory(&home.join(".ssh")).unwrap();
        let existing =
            b"# personal settings\nServerAliveInterval 37\nHost personal\n  User example\n";
        fs::write(home.join(".ssh/config"), existing).unwrap();
        let paths = RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: directory.path().join("msb"),
            home: directory.path().join("runtime"),
            storage_home: None,
            library: directory.path().join("msb"),
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        };
        crate::working_account::test_runtime(&paths.executable, true);
        let (alias, config) = prepare(&paths, &home, "dev").unwrap();
        let once = fs::read(home.join(".ssh/config")).unwrap();
        prepare(&paths, &home, "dev").unwrap();
        assert_eq!(once, fs::read(home.join(".ssh/config")).unwrap());
        assert!(once.ends_with(existing));
        let output = Command::new("/usr/bin/ssh")
            .arg("-G")
            .arg("-F")
            .arg(config)
            .arg(alias)
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("user silo\n"));
        assert!(text.contains("stricthostkeychecking true"));
        assert!(text.contains("identityagent none"));
        assert!(text.contains("forwardagent no"));
        assert!(text.contains("--no-start"));
        let personal = Command::new("/usr/bin/ssh")
            .arg("-G")
            .arg("-F")
            .arg(home.join(".ssh/config"))
            .arg("personal")
            .output()
            .unwrap();
        assert!(personal.status.success());
        let personal = String::from_utf8(personal.stdout).unwrap();
        assert!(personal.contains("user example\n"));
        assert!(!personal.contains("--no-start"));
        assert!(personal.contains("serveraliveinterval 37\n"));
        let unrelated = Command::new("/usr/bin/ssh")
            .arg("-G")
            .arg("-F")
            .arg(home.join(".ssh/config"))
            .arg("unrelated")
            .output()
            .unwrap();
        assert!(unrelated.status.success());
        assert!(String::from_utf8(unrelated.stdout)
            .unwrap()
            .contains("serveraliveinterval 37\n"));
    }

    #[test]
    #[ignore = "requires an explicitly provided running Silo VM and installs its editor SSH configuration"]
    fn live_editor_transport() {
        let home =
            PathBuf::from(std::env::var("SILO_EDITOR_USER_HOME").expect("explicit user home"));
        let runtime_home = PathBuf::from(
            std::env::var("SILO_EDITOR_RUNTIME_HOME").expect("explicit runtime home"),
        );
        let paths = RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: PathBuf::from(
                std::env::var("SILO_EDITOR_MSB").expect("explicit bundled runtime"),
            ),
            library: PathBuf::from(
                std::env::var("SILO_EDITOR_LIBRARY").expect("explicit runtime library"),
            ),
            home: runtime_home,
            storage_home: None,
            metadata: PathBuf::new(),
            volumes: PathBuf::new(),
        };
        let (alias, config) = prepare(&paths, &home, "dev").unwrap();
        let mut probe = Command::new("/usr/bin/ssh");
        probe.arg("-F").arg(config).args([
            "-o",
            "ConnectTimeout=5",
            &alias,
            "test -d /workspace/silo-files-test-express/test",
        ]);
        run(&mut probe, Duration::from_secs(10)).unwrap();
        // Reproduce editor-server upload: mkdir relative to the SSH login home,
        // then SCP (SFTP) to that relative path, and read it through SSH again.
        let transfer_directory = format!(".silo-editor-test-{}", uuid::Uuid::new_v4().simple());
        let (_, config) = prepare(&paths, &home, "dev").unwrap();
        let mut mkdir = Command::new("/usr/bin/ssh");
        mkdir.arg("-F").arg(&config).arg(&alias).arg(format!(
            "test \"$(pwd)\" = \"$HOME\" && mkdir {transfer_directory}"
        ));
        run(&mut mkdir, Duration::from_secs(10)).unwrap();
        let mut local = tempfile::NamedTempFile::new().unwrap();
        local.write_all(b"silo-editor-transfer-proof").unwrap();
        let mut copy = Command::new("/usr/bin/scp");
        copy.arg("-F")
            .arg(&config)
            .arg(local.path())
            .arg(format!("{alias}:{transfer_directory}/probe"));
        let copied = run(&mut copy, Duration::from_secs(10));
        let mut verify = Command::new("/usr/bin/ssh");
        verify.arg("-F").arg(&config).arg(&alias).arg(format!(
            "test \"$(cat {transfer_directory}/probe)\" = silo-editor-transfer-proof"
        ));
        let verified = run(&mut verify, Duration::from_secs(10));
        let mut cleanup = Command::new("/usr/bin/ssh");
        cleanup.arg("-F").arg(&config).arg(&alias).arg(format!(
            "rm -f {transfer_directory}/probe && rmdir {transfer_directory}"
        ));
        run(&mut cleanup, Duration::from_secs(10)).unwrap();
        copied.unwrap();
        verified.unwrap();
        if std::env::var_os("SILO_EDITOR_OPEN_ZED").is_some() {
            let uri = remote_uri(&alias, "/workspace/silo-files-test-express", true).unwrap();
            let mut command = Command::new("/Applications/Zed.app/Contents/MacOS/cli");
            command.arg(uri);
            run(&mut command, Duration::from_secs(10)).unwrap();
        }
    }
}
