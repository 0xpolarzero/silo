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

static LOCK: Mutex<()> = Mutex::new(());
const FAILED: &str = "Could not prepare the editor connection.";

pub(crate) fn open(app: &AppHandle, name: &str, path: Option<&str>) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| FAILED)?;
    if !Path::new("/usr/bin/ssh").is_file() || !Path::new("/usr/bin/ssh-keygen").is_file() {
        return Err("OpenSSH is required to open VM folders in your editor. Install your system's OpenSSH client and retry.".into());
    }
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
    let inspected = runtime::inspect_workspace(&runtime::ProcessRunner, &paths, name)
        .map_err(|_| "Could not check this sandbox.")?;
    runtime::ensure_managed(&inspected).map_err(|error| error.to_string())?;
    if inspected.status != "Running" {
        return Err("Start this VM before opening its files in your editor.".into());
    }
    // Validate the exact folder inside the guest, as positional data, before handoff.
    runtime::run_msb(
        &paths,
        &[
            "exec".into(),
            name.into(),
            "--no-start".into(),
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
    let uri = remote_uri(&alias, path, zed)?;
    let mut launch = Command::new(executable);
    if !zed {
        launch.arg("--folder-uri");
    }
    launch.arg(uri);
    run(&mut launch, Duration::from_secs(10)).map_err(|_| {
        "The editor could not be opened. Check its installation and Remote SSH support.".to_string()
    })
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

fn remote_uri(alias: &str, path: &str, zed: bool) -> Result<String, String> {
    let mut uri = reqwest::Url::parse(&if zed {
        format!("ssh://root@{alias}/")
    } else {
        format!("vscode-remote://ssh-remote+{alias}/")
    })
    .map_err(|_| FAILED)?;
    uri.set_path(path);
    Ok(uri.into())
}

fn private_directory(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(FAILED.into());
        }
    }
    fs::create_dir_all(path).map_err(|_| FAILED)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| FAILED.into())
}

fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
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

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
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

fn key(path: &Path) -> Result<(), String> {
    if !read_regular(path)?.is_empty() {
        return Ok(());
    }
    let mut command = Command::new("/usr/bin/ssh-keygen");
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "Silo", "-f"])
        .arg(path);
    run(&mut command, Duration::from_secs(5))
}

fn public_key(path: &Path) -> Result<String, String> {
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
    let known_hosts = root.join(format!("{name}.known_hosts"));
    write_private(
        &known_hosts,
        format!("{alias} {}\n", public_key(&host_key)?).as_bytes(),
    )?;
    let config = root.join(format!("{name}.conf"));
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
    let content = format!("Host {alias}\n  HostName {alias}\n  User root\n  IdentityFile {}\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  ForwardX11 no\n  UserKnownHostsFile {}\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ProxyCommand {proxy}\n\nHost *\n", ssh_quote(&client)?, ssh_quote(&known_hosts)?);
    write_private(&config, content.as_bytes())?;
    let ssh_root = user_home.join(".ssh");
    private_directory(&ssh_root)?;
    let user_config = ssh_root.join("config");
    let old = read_regular(&user_config)?;
    let include = format!("Include {}\n", ssh_quote(&root.join("*.conf"))?);
    if !old
        .split(|byte| *byte == b'\n')
        .any(|line| line == include.trim_end().as_bytes())
    {
        let mut new = include.into_bytes();
        new.extend_from_slice(&old);
        write_private(&user_config, &new)?;
    }
    Ok((alias, config))
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_paths_stay_in_uri_and_are_encoded() {
        let uri = remote_uri("silo-test-dev", "/workspace/a b/#test?x", true).unwrap();
        assert_eq!(uri, "ssh://root@silo-test-dev/workspace/a%20b/%23test%3Fx");
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
            executable: PathBuf::from("/Applications/Silo.app/Contents/MacOS/msb"),
            home: directory.path().join("runtime"),
            storage_home: None,
            library: PathBuf::from("/Applications/Silo.app/Contents/Frameworks/library"),
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        };
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
