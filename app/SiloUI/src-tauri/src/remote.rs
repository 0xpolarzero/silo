//! App-lifetime remote management. SSH only transports framed requests to the running owner.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::{symlink, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
mod operations;
/// Appends the key read from input to `authorized_keys` once. sshd runs this with the
/// account's login shell, so the POSIX script is handed to `sh` in single quotes, which
/// fish, csh and nushell also pass through unchanged; the script itself has no single quote.
const INSTALL_PUBLIC_KEY: &str = r#"sh -c 'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && key=$(cat) && { grep -qxF -- "$key" ~/.ssh/authorized_keys || printf "\n%s\n" "$key" >> ~/.ssh/authorized_keys; }'"#;
/// Silo's key may only run the bridge and open `-N` tunnels to loopback ports on the owner.
const AUTHORIZED_KEY_OPTIONS: &str = r#"restrict,port-forwarding,permitopen="127.0.0.1:*",command="exec ~/.local/bin/silo-remote --remote-bridge""#;
const SILO_KEY_COMMENT: &str = "Silo remote management";
/// Bridge protocol version; both computers must match. 2 adds the method table, capabilities,
/// changes named by a stable `operationId` that must start within `startWithinMs`, and a
/// preamble before each bridge reply.
const VERSION: u32 = 2;
const LIMIT: usize = 4 * 1024 * 1024;
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static REMOTE_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub address: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    host_id: String,
    enabled: bool,
    hosts: Vec<RemoteHost>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementStatus {
    enabled: bool,
    host_id: String,
    name: String,
    address: String,
    /// Addresses other computers may reach this one at, most likely first.
    addresses: Vec<ManagementAddress>,
    /// Why remote management does not work on this computer right now, if it does not.
    error: Option<String>,
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementAddress {
    address: String,
    /// `name` (local network name), `tailscale`, or `network` (an interface address).
    kind: &'static str,
}
/// `user@…` candidates: the host name (as `.local` when it has no domain, which Bonjour and
/// Avahi resolve), then Tailscale addresses, then other interface addresses.
fn management_addresses(user: &str, name: &str, interfaces: &[String]) -> Vec<ManagementAddress> {
    let entry = |host: &str, kind| ManagementAddress { address: format!("{user}@{host}"), kind };
    let mut list = Vec::new();
    if !name.is_empty() {
        if name.contains('.') {
            list.push(entry(name, "name"));
        } else {
            list.push(entry(&format!("{name}.local"), "name"));
            list.push(entry(name, "name"));
        }
    }
    let usable: Vec<std::net::Ipv4Addr> = interfaces
        .iter()
        .filter_map(|ip| ip.parse().ok())
        .filter(|ip: &std::net::Ipv4Addr| !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified())
        .collect();
    // Tailscale assigns addresses from the carrier-grade NAT range 100.64.0.0/10.
    let tailscale = |ip: &std::net::Ipv4Addr| ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 64;
    list.extend(usable.iter().filter(|ip| tailscale(ip)).map(|ip| entry(&ip.to_string(), "tailscale")));
    list.extend(usable.iter().filter(|ip| !tailscale(ip)).map(|ip| entry(&ip.to_string(), "network")));
    list
}
fn directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Home directory is unavailable.")?;
    directory_in(Path::new(&home))
}
/// `~/.silo/desktop-remote` under `home`, private to this account.
fn directory_in(home: &Path) -> Result<PathBuf, String> {
    let root = home.join(".silo");
    crate::runtime::prepare_private_directory(&root).map_err(|e| e.to_string())?;
    let dir = root.join("desktop-remote");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn read_config() -> Result<Config, String> {
    read_config_in(&directory()?)
}
fn read_config_in(dir: &Path) -> Result<Config, String> {
    match fs::read(dir.join("config.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Remote management settings are damaged.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let config = Config {
                host_id: uuid::Uuid::new_v4().to_string(),
                enabled: false,
                hosts: vec![],
            };
            save_config_in(dir, &config)?;
            Ok(config)
        }
        Err(e) => Err(e.to_string()),
    }
}
fn save_config(config: &Config) -> Result<(), String> {
    save_config_in(&directory()?, config)
}
fn save_config_in(dir: &Path, config: &Config) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(dir.join("config.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
}
/// Whether a bridged method only observes state or changes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Access {
    /// Observes state only; repeating it changes nothing.
    Read,
    /// Changes state on this computer: accepted once per request identity, never replayed.
    Change,
    /// An interactive byte stream, served before request dispatch.
    Stream,
}
/// Every method the bridge serves. A method is reachable only once it is classified here,
/// so a new state change cannot skip the replay record by accident.
const METHODS: &[(&str, Access)] = &[
    ("handshake", Access::Read),
    ("runtime.snapshot", Access::Read),
    ("runtime.logs", Access::Read),
    ("runtime.configuration", Access::Read),
    ("runtime.action", Access::Change),
    ("runtime.upsert", Access::Change),
    ("runtime.delete", Access::Change),
    ("desktop.connect", Access::Read),
    ("desktop.status", Access::Read),
    ("desktop.action", Access::Change),
    ("ssh.access.state", Access::Read),
    ("ssh.access.connection", Access::Read),
    ("ssh.access.save", Access::Change),
    ("files.list", Access::Read),
    ("guest.prepare", Access::Change),
    ("guest.ssh", Access::Stream),
    ("network.state", Access::Read),
    ("network.publish", Access::Change),
    ("repository.push.status", Access::Read),
    ("repository.push.start", Access::Change),
    ("repository.push", Access::Change),
    ("repository.dismiss", Access::Change),
    ("checkpoint.create", Access::Change),
    ("checkpoint.fork", Access::Change),
    ("checkpoint.restore", Access::Change),
];
/// The error an older or newer computer reports for a method it does not serve.
const UNSUPPORTED: &str = "This Silo version does not support that remote operation.";
fn access(method: &str) -> Option<Access> {
    METHODS
        .iter()
        .find(|(name, _)| *name == method)
        .map(|(_, access)| *access)
}
fn name() -> String {
    let mut bytes = [0u8; 256];
    unsafe {
        libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len());
    }
    String::from_utf8_lossy(&bytes)
        .trim_end_matches('\0')
        .to_string()
}
fn status(config: &Config) -> ManagementStatus {
    let name = name();
    let user = std::env::var("USER").unwrap_or_default();
    let addresses = management_addresses(&user, &name, &crate::ssh_access::addresses());
    ManagementStatus {
        enabled: config.enabled,
        host_id: config.host_id.clone(),
        address: addresses
            .first()
            .map(|entry| entry.address.clone())
            .unwrap_or_else(|| format!("{user}@{name}")),
        addresses,
        name,
        error: START_ERROR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    }
}
/// Why remote management is not working although Silo runs, such as another Silo
/// process owning it or a file in the way of the bridge link. Cleared once fixed.
static START_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// True once this process serves the control socket.
static LISTENING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn record_start_error(error: Option<String>) {
    if let Some(error) = &error {
        eprintln!("Remote management is unavailable: {error}");
    }
    *START_ERROR.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = error;
}
#[tauri::command]
pub fn remote_management_status() -> Result<ManagementStatus, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    Ok(status(&read_config()?))
}
/// The executable the bridge link should name: the AppImage file itself when running
/// from one (its mount point changes every launch), else this executable.
fn bridge_target() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    select_bridge_target(std::env::var_os("APPIMAGE").map(PathBuf::from), current)
}
fn select_bridge_target(app_image: Option<PathBuf>, current: PathBuf) -> Result<PathBuf, String> {
    if let Some(app_image) = app_image.filter(|path| {
        path.is_absolute()
            && fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }) {
        return Ok(app_image);
    }
    // macOS runs a quarantined app from a random read-only copy until it is moved.
    if current.components().any(|part| part.as_os_str() == "AppTranslocation") {
        return Err("Move Silo to the Applications folder and open it again before using remote management.".into());
    }
    Ok(current)
}
/// Points `~/.local/bin/silo-remote` under `home` at `target`, replacing only a link
/// Silo made earlier: one to an executable with the same name, a Silo AppImage, or a
/// link whose target is gone (an old AppImage mount or a moved app).
fn link_bridge(home: &Path, target: &Path) -> Result<(), String> {
    let path = home.join(".local/bin/silo-remote");
    fs::create_dir_all(path.parent().ok_or("Home unavailable.")?).map_err(|e| e.to_string())?;
    if let Ok(existing) = fs::symlink_metadata(&path) {
        let previous = fs::read_link(&path).ok();
        let ours = existing.file_type().is_symlink()
            && previous.as_deref().is_some_and(|previous| {
                !previous.exists()
                    || previous.file_name() == target.file_name()
                    || std::env::current_exe().is_ok_and(|current| previous.file_name() == current.file_name())
                    || previous.extension().is_some_and(|extension| extension == "AppImage")
            });
        if !ours {
            return Err("~/.local/bin/silo-remote already exists. Choose a different name for that file before enabling remote management.".into());
        }
        if previous.as_deref() == Some(target) {
            return Ok(());
        }
    }
    let temp = path.with_file_name(format!(".silo-remote-{}", uuid::Uuid::new_v4()));
    symlink(target, &temp).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(temp);
        return Err(error.to_string());
    }
    Ok(())
}
fn link_bridge_for_this_account() -> Result<(), String> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("Home unavailable.")?);
    link_bridge(&home, &bridge_target()?)
}
#[tauri::command]
pub fn set_remote_management(app: AppHandle, enabled: bool) -> Result<ManagementStatus, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    if enabled {
        link_bridge_for_this_account()?;
    }
    let mut config = read_config()?;
    config.enabled = enabled;
    save_config(&config)?;
    REMOTE_ENABLED.store(enabled, std::sync::atomic::Ordering::Release);
    if enabled {
        // The link is in place now; a launch that could not serve remote management tries again.
        let listening = if LISTENING.load(std::sync::atomic::Ordering::Acquire) { Ok(()) } else { listen(app) };
        record_start_error(listening.err());
    }
    Ok(status(&config))
}
#[tauri::command]
pub fn remote_host_list() -> Result<Vec<RemoteHost>, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    Ok(read_config()?.hosts)
}
#[tauri::command]
pub fn remove_remote_host(host_id: String) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    let mut config = read_config()?;
    config.hosts.retain(|h| h.id != host_id);
    save_config(&config)?;
    drop(_guard);
    crate::remote_network::close_host(&host_id);
    crate::desktop_viewer::close_host(&host_id);
    Ok(())
}
fn validate_address(address: &str) -> Result<(), String> {
    let invalid = || {
        "Enter an SSH alias, hostname, IP address, user@hostname, or ssh://user@host:port."
            .to_owned()
    };
    if address.is_empty()
        || address.len() > 255
        || address.starts_with('-')
        || address
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(invalid());
    }
    if address.starts_with("ssh://") {
        if !address
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@._-:[]/".contains(&b))
        {
            return Err(invalid());
        }
        let url = reqwest::Url::parse(address).map_err(|_| invalid())?;
        if url.host_str().is_none()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
            || !url
                .username()
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(invalid());
        }
        return Ok(());
    }
    if !address
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"@._-:[]".contains(&b))
    {
        return Err(invalid());
    }
    Ok(())
}
#[tauri::command]
pub async fn remote_authorize_ssh(app: AppHandle, address: String) -> Result<(), String> {
    // Resolving and launching the terminal can take seconds (application lookup, an
    // AppleScript for Ghostty), so it runs off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let command = authorize_command(address.trim())?;
        let application = crate::applications::selected_terminal(&app)?;
        crate::applications::open_terminal(&app, &application, &command)
    })
    .await
    .map_err(|_| "Could not open the terminal.".to_string())?
}
/// The terminal command that lets the user trust the host key and unlock their SSH key.
fn authorize_command(address: &str) -> Result<String, String> {
    validate_address(address)?;
    Ok([
        "/usr/bin/ssh",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "BatchMode=no",
        "-o",
        "AddKeysToAgent=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        address,
        "true",
    ]
    .iter()
    .map(|arg| crate::terminal::quote(arg))
    .collect::<Vec<_>>()
    .join(" "))
}

fn write_frame(mut writer: impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err("Remote response exceeds the size limit.".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| writer.write_all(&bytes))
        .map_err(|e| e.to_string())
}
/// Marks the start of the bridge's reply on ssh output, so text printed by the other
/// account's shell startup files (an `echo` in `.bashrc`, conda init) is skipped instead of
/// being read as a frame. `\0` occurs only first, so a partial match restarts cleanly.
const REPLY_PREAMBLE: &[u8] = b"\0SILO-BRIDGE-REPLY\n";
/// Shell output skipped before a reply at most.
const REPLY_SEARCH_LIMIT: usize = 64 * 1024;
/// The bridge's reply on its standard output: the preamble, then one frame.
fn write_reply(mut writer: impl Write, value: &Value) -> Result<(), String> {
    writer.write_all(REPLY_PREAMBLE).map_err(|error| error.to_string())?;
    write_frame(&mut writer, value)?;
    writer.flush().map_err(|error| error.to_string())
}
/// Reads the bridge's reply from ssh output, skipping anything printed before it.
fn read_reply(mut reader: impl std::io::BufRead) -> Result<Value, String> {
    let ended = || "The remote Silo connection ended. Check that Silo is running and remote management is enabled.".to_string();
    let (mut matched, mut skipped) = (0, 0);
    while matched < REPLY_PREAMBLE.len() {
        let available = reader.fill_buf().map_err(|_| ended())?;
        let Some(&byte) = available.first() else {
            return Err(ended());
        };
        reader.consume(1);
        if byte == REPLY_PREAMBLE[matched] {
            matched += 1;
        } else {
            skipped += matched + 1;
            matched = usize::from(byte == REPLY_PREAMBLE[0]);
            if skipped > REPLY_SEARCH_LIMIT {
                return Err("The other computer printed unexpected text before Silo's reply. Remove output from its shell startup files, such as echo in .bashrc.".into());
            }
        }
    }
    read_frame(reader)
}
fn copy_raw_stream(mut reader: impl Read, mut writer: impl Write) -> std::io::Result<()> {
    let mut buffer = [0; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => {
                writer.write_all(&buffer[..count])?;
                writer.flush()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}
fn read_frame(mut reader: impl Read) -> Result<Value, String> {
    let mut len = [0; 4];
    reader.read_exact(&mut len).map_err(|_|"The remote Silo connection ended. Check that Silo is running and remote management is enabled.".to_string())?;
    let len = u32::from_be_bytes(len) as usize;
    if len > LIMIT {
        return Err("Remote response exceeds the size limit.".into());
    }
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid remote Silo response.".into())
}
/// Which keys ssh offers the other computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Identity {
    /// Only Silo's key (and keys the user's ssh config names for that host), so a
    /// long agent key list cannot exhaust the server's MaxAuthTries first.
    SiloOnly,
    /// Silo's key and every other key ssh would offer (agent, defaults).
    AnyKey,
}
/// Addresses where only the user's own keys authenticated, so later connections
/// (including tunnels) start with every key instead of Silo's alone.
static ANY_KEY_ADDRESSES: Mutex<std::collections::BTreeSet<String>> =
    Mutex::new(std::collections::BTreeSet::new());
fn silo_key() -> Option<PathBuf> {
    directory()
        .ok()
        .map(|dir| dir.join("id_ed25519"))
        .filter(|key| key.is_file())
}
fn preferred_identity(address: &str) -> Identity {
    let any = ANY_KEY_ADDRESSES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(address);
    if any { Identity::AnyKey } else { Identity::SiloOnly }
}
fn remember_identity(address: &str, identity: Identity) {
    let mut addresses = ANY_KEY_ADDRESSES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match identity {
        Identity::AnyKey => addresses.insert(address.to_owned()),
        Identity::SiloOnly => addresses.remove(address),
    };
}
fn ssh_for_address(address: &str) -> Result<Command, String> {
    ssh_with_identity(address, silo_key().as_deref(), preferred_identity(address))
}
fn ssh_with_identity(address: &str, key: Option<&Path>, identity: Identity) -> Result<Command, String> {
    validate_address(address)?;
    let mut command = Command::new("/usr/bin/ssh");
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=2",
    ]);
    if let Some(key) = key {
        command.arg("-i").arg(key);
        if identity == Identity::SiloOnly {
            command.args(["-o", "IdentitiesOnly=yes"]);
        }
    }
    Ok(command)
}
/// Tries the preferred keys, and after an authentication failure the other choice once.
/// The choice that authenticated is remembered for later connections to `address`.
fn with_identity_fallback(
    address: &str,
    has_silo_key: bool,
    mut attempt: impl FnMut(Identity) -> Result<Value, Failure>,
) -> Result<Value, Failure> {
    let first = preferred_identity(address);
    let result = attempt(first);
    let refused = |result: &Result<Value, Failure>| {
        matches!(result, Err(Failure::Failed(message)) if message == AUTHENTICATION_FAILED)
    };
    if !has_silo_key {
        return result;
    }
    if !refused(&result) {
        remember_identity(address, first);
        return result;
    }
    let second = match first {
        Identity::SiloOnly => Identity::AnyKey,
        Identity::AnyKey => Identity::SiloOnly,
    };
    let retried = attempt(second);
    if !refused(&retried) {
        remember_identity(address, second);
    }
    retried
}
pub(crate) fn ssh_tunnel_command(
    host_id: &str,
    local_port: u16,
    remote_port: u16,
) -> Result<Command, String> {
    if local_port == 0 || remote_port == 0 {
        return Err("Invalid forwarded port.".into());
    }
    let host = read_config()?
        .hosts
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or("Saved computer not found.")?;
    let mut command = ssh_for_address(&host.address)?;
    command.args([
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
        "--",
        &host.address,
    ]);
    Ok(command)
}

#[tauri::command]
pub async fn remote_setup_ssh_key(app: AppHandle, address: String) -> Result<(), String> {
    // ssh-keygen and the terminal launch run off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let address = address.trim();
        let command = key_setup_command(&directory()?, address)?;
        let application = crate::applications::selected_terminal(&app)?;
        crate::applications::open_terminal(&app, &application, &command)?;
        // Offer Silo's key alone again once it is installed there.
        remember_identity(address, Identity::SiloOnly);
        Ok(())
    })
    .await
    .map_err(|_| "Could not open the terminal.".to_string())?
}
/// Creates Silo's key in `dir` if needed and returns the terminal command that installs
/// its restricted `authorized_keys` line for the account at `address`.
fn key_setup_command(dir: &Path, address: &str) -> Result<String, String> {
    validate_address(address)?;
    let key = dir.join("id_ed25519");
    if !key.exists() {
        let status = Command::new("/usr/bin/ssh-keygen")
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "Silo remote management",
                "-f",
            ])
            .arg(&key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Could not create Silo’s SSH key.".into());
        }
    }
    let public = fs::read_to_string(key.with_extension("pub"))
        .map_err(|_| "Could not read Silo’s public SSH key.")?;
    if public.len() > 1024 {
        return Err("Invalid Silo SSH public key.".into());
    }
    let line = authorized_key_line(&public)?;

    let args = [
        "/usr/bin/ssh",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "BatchMode=no",
        "-o",
        "ConnectTimeout=10",
        "--",
        address,
        INSTALL_PUBLIC_KEY,
    ];
    Ok(format!(
        "printf '%s\n' {} | {}",
        crate::terminal::quote(&line),
        args.iter()
            .map(|arg| crate::terminal::quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    ))
}
fn silo_key_blob(public: &str) -> Result<&str, String> {
    let mut parts = public.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("ssh-ed25519"), Some(blob))
            if !blob.is_empty()
                && blob.len() <= 512
                && blob
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')) =>
        {
            Ok(blob)
        }
        _ => Err("Invalid Silo SSH public key.".into()),
    }
}
/// The `authorized_keys` line Silo installs for its remote-management key.
fn authorized_key_line(public: &str) -> Result<String, String> {
    let blob = silo_key_blob(public)?;
    Ok(format!("{AUTHORIZED_KEY_OPTIONS} ssh-ed25519 {blob} {SILO_KEY_COMMENT}"))
}
/// Rewrites the unrestricted line earlier Silo versions installed; other lines are untouched.
fn restrict_authorized_keys(contents: &str, blob: &str) -> Option<String> {
    let unrestricted = format!("ssh-ed25519 {blob} {SILO_KEY_COMMENT}");
    let mut changed = false;
    let rewritten = contents
        .split_inclusive('\n')
        .map(|line| {
            if line.trim() == unrestricted {
                changed = true;
                let ending = if line.ends_with('\n') { "\n" } else { "" };
                format!("{AUTHORIZED_KEY_OPTIONS} {unrestricted}{ending}")
            } else {
                line.to_owned()
            }
        })
        .collect::<String>();
    changed.then_some(rewritten)
}
fn restrict_authorized_keys_file(path: &std::path::Path, public: &str) -> Result<bool, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let blob = silo_key_blob(public)?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    // Leave symlinked or otherwise managed files to their owner.
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    let contents = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let Some(rewritten) = restrict_authorized_keys(&contents, blob) else {
        return Ok(false);
    };
    let temporary = path.with_file_name(".authorized_keys.silo-restrict");
    let _ = fs::remove_file(&temporary);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(metadata.permissions().mode() & 0o7777)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let written = file
        .write_all(rewritten.as_bytes())
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, path));
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(true)
}
/// Owner side: restrict the calling controller's previously installed Silo key.
fn restrict_installed_key(public: &str) -> Result<bool, String> {
    let home = std::env::var_os("HOME").ok_or("Home directory is unavailable.")?;
    restrict_authorized_keys_file(&PathBuf::from(home).join(".ssh/authorized_keys"), public)
}
fn silo_public_key() -> Option<String> {
    let public = fs::read_to_string(directory().ok()?.join("id_ed25519.pub")).ok()?;
    silo_key_blob(&public).ok()?;
    Some(public.trim().to_owned())
}
fn request_timeout(request: &Value) -> Duration {
    if (request["method"] == "runtime.upsert" && request.pointer("/params/machine/desktop").is_some_and(|v| !v.is_null()))
        || (request["method"] == "desktop.action"
            && matches!(request["params"]["action"].as_str(), Some("setup-tools" | "update-streamer" | "setup-lcu")))
    {
        Duration::from_secs(2100)
    } else {
        Duration::from_secs(600)
    }
}
const CONNECTION_HELP: &str = "Cannot connect to Silo over SSH. Verify the address, authorize its host key using SSH, and configure an SSH key or agent. On the other computer, keep Silo running with remote management enabled.";
/// Names the cause of a failed connection from the ssh exit code and stderr, without echoing raw output.
const AUTHENTICATION_FAILED: &str = "SSH authentication failed. Set up Silo's SSH key for this computer, or configure an SSH key or agent.";
fn connection_failure(code: Option<i32>, stderr: &str) -> String {
    let has = |needle: &str| stderr.contains(needle);
    if code == Some(255) {
        let cause = if has("REMOTE HOST IDENTIFICATION HAS CHANGED") {
            "The other computer's SSH host key changed. Verify the computer before trusting its new key (Host key verification failed)."
        } else if has("Host key verification failed") {
            "Host key verification failed. Connect once with SSH in a terminal to verify and trust the other computer's host key."
        } else if has("Permission denied") || has("Too many authentication failures") {
            AUTHENTICATION_FAILED
        } else if has("Could not resolve hostname") {
            "Cannot resolve the computer's address. Check the address and network."
        } else if has("Connection refused") {
            "The other computer refused the SSH connection. Turn on Remote Login (SSH) there."
        } else if has("timed out") {
            "The SSH connection timed out. Check that the other computer is awake and reachable."
        } else {
            CONNECTION_HELP
        };
        return cause.into();
    }
    if has("Silo is not running on this computer.") {
        return "Silo is not running on the other computer. Open Silo there with remote management enabled.".into();
    }
    if code == Some(127) || has("silo-remote: No such file") || has("silo-remote: not found") {
        return "Silo's remote bridge is missing on the other computer. Turn remote management off and on again there.".into();
    }
    CONNECTION_HELP.into()
}
/// The command the bridge runs on the other computer (also forced by Silo's restricted key).
const BRIDGE_COMMAND: &str = "exec ~/.local/bin/silo-remote --remote-bridge";
/// Pauses before sending a change again after its connection was lost.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(4)];
/// Why an exchange with another computer failed.
#[derive(Debug, PartialEq)]
enum Failure {
    /// The other computer answered with this error.
    Reported(String),
    /// The connection was lost; the request may or may not have arrived.
    Lost(String),
    /// Anything else, such as an untrusted host key, failed authentication or a timeout.
    Failed(String),
}
impl Failure {
    fn message(self) -> String {
        match self {
            Self::Reported(message) | Self::Lost(message) | Self::Failed(message) => message,
        }
    }
}
/// An ssh failure that sending the request again may overcome: the connection dropped or
/// could not be made, not a host key, authentication, name or refused-connection problem.
fn lost_connection(code: Option<i32>, stderr: &str) -> bool {
    code == Some(255)
        && ![
            "REMOTE HOST IDENTIFICATION HAS CHANGED",
            "Host key verification failed",
            "Permission denied",
            "Too many authentication failures",
            "Could not resolve hostname",
            "Connection refused",
        ]
        .iter()
        .any(|permanent| stderr.contains(permanent))
}
fn exchange(address: &str, request: &Value, deadline: Instant) -> Result<Value, Failure> {
    validate_address(address).map_err(Failure::Failed)?;
    let key = silo_key();
    // An authentication failure means the request never reached the bridge, so sending
    // it again with other keys cannot repeat a change.
    with_identity_fallback(address, key.is_some(), |identity| {
        let mut command = ssh_with_identity(address, key.as_deref(), identity).map_err(Failure::Failed)?;
        command.args(["--", address, BRIDGE_COMMAND]);
        run_exchange(command, request, deadline)
    })
}
/// Sends one framed request through `command` (ssh running the bridge) and reads the reply.
fn run_exchange(mut command: Command, request: &Value, deadline: Instant) -> Result<Value, Failure> {
    use std::io::{Seek, SeekFrom};
    let failed = |error: std::io::Error| Failure::Failed(error.to_string());
    let stdout = tempfile::tempfile().map_err(failed)?;
    let stderr = tempfile::tempfile().map_err(failed)?;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(stdout.try_clone().map_err(failed)?)
        .stderr(stderr.try_clone().map_err(failed)?)
        .spawn()
        .map_err(failed)?;
    // Input stays open until the reply: the bridge takes its end to mean this computer left.
    // A write error means ssh already failed; its exit status and output say why.
    let mut input = child.stdin.take();
    if input.as_mut().is_some_and(|input| write_frame(input, request).is_err()) {
        input = None;
    }
    let exit = loop {
        if let Some(exit) = child.try_wait().map_err(failed)? {
            break exit;
        }
        if Instant::now() > deadline
            || stdout.metadata().map_err(failed)?.len() > LIMIT as u64 + 4
            || stderr.metadata().map_err(failed)?.len() > 65536
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::Failed("Remote operation timed out. Its outcome is unknown; reconnect and inspect before issuing another change.".into()));
        }
        thread::sleep(Duration::from_millis(40));
    };
    drop(input);
    if !exit.success() {
        let mut stderr = stderr;
        let mut text = String::new();
        let _ = stderr
            .seek(SeekFrom::Start(0))
            .and_then(|_| Read::by_ref(&mut stderr).take(65536).read_to_string(&mut text));
        let message = connection_failure(exit.code(), &text);
        return Err(if lost_connection(exit.code(), &text) {
            Failure::Lost(message)
        } else {
            Failure::Failed(message)
        });
    }
    let mut stdout = stdout;
    stdout.seek(SeekFrom::Start(0)).map_err(failed)?;
    let response = read_reply(std::io::BufReader::new(stdout)).map_err(Failure::Failed)?;
    if let Some(error) = response["error"].as_str() {
        return Err(Failure::Reported(error.into()));
    }
    Ok(response["result"].clone())
}
pub(crate) fn call_remote(
    _app: &AppHandle,
    host_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    crate::runtime::shutdown::ensure_accepting_operations()?;
    let host = {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
        read_config()?
            .hosts
            .into_iter()
            .find(|h| h.id == host_id)
            .ok_or("This computer is no longer connected.")?
    };
    let mut request = json!({"version":VERSION,"hostId":host.id,"method":method,"params":params});
    let deadline = Instant::now() + request_timeout(&request);
    if access(method) != Some(Access::Change) {
        return exchange(&host.address, &request, deadline).map_err(Failure::message);
    }
    request["operationId"] = json!(uuid::Uuid::new_v4().to_string());
    send_change(&mut request, deadline, &RETRY_DELAYS, |request| {
        exchange(&host.address, request, deadline)
    })
}
/// Sends a change, and after a lost connection sends it again with the same
/// `operationId`, so the other computer attaches the retry to the change it already
/// accepted instead of running it twice.
fn send_change(
    request: &mut Value,
    deadline: Instant,
    delays: &[Duration],
    mut send: impl FnMut(&Value) -> Result<Value, Failure>,
) -> Result<Value, String> {
    let mut delays = delays.iter();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        // Queued work must start early enough to finish while this computer still waits.
        request["startWithinMs"] = json!((remaining / 2).as_millis() as u64);
        match send(request) {
            Err(Failure::Lost(message)) => match delays.next() {
                Some(delay) if remaining > *delay => {
                    thread::sleep(*delay);
                    crate::runtime::shutdown::ensure_accepting_operations()?;
                }
                _ => return Err(message),
            },
            result => return result.map_err(Failure::message),
        }
    }
}

fn checkpoint_remote_request(
    vm_id: &str,
    action: &str,
    name: Option<&str>,
    checkpoint_id: Option<&str>,
    new_name: Option<&str>,
) -> Result<(&'static str, Value), String> {
    uuid::Uuid::parse_str(vm_id).map_err(|_| "Invalid sandbox identity.")?;
    let params = match action {
        "create" => ("checkpoint.create", json!({"vmId":vm_id,"name":name.ok_or("Missing checkpoint name.")?})),
        "fork" => ("checkpoint.fork", json!({"vmId":vm_id,"checkpointId":checkpoint_id,"newName":new_name.ok_or("Missing fork name.")?})),
        "restore" => ("checkpoint.restore", json!({"vmId":vm_id,"checkpointId":checkpoint_id.ok_or("Missing checkpoint identity.")?})),
        _ => return Err("Unsupported checkpoint operation.".into()),
    };
    Ok(params)
}

#[tauri::command]
pub async fn remote_checkpoint_action(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    action: String,
    name: Option<String>,
    checkpoint_id: Option<String>,
    new_name: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (method, params) = checkpoint_remote_request(
            &vm_id,
            &action,
            name.as_deref(),
            checkpoint_id.as_deref(),
            new_name.as_deref(),
        )?;
        call_remote(&app, &host_id, method, params).map(|_| ())
    })
    .await
    .map_err(|_| "Remote checkpoint worker failed.".to_string())?
}

#[tauri::command]
pub async fn connect_remote_host(address: String, replace: Option<bool>) -> Result<RemoteHost, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let address = address.trim().to_owned();
        let handshake = json!({"version": VERSION, "method": "handshake", "params": {"sshKey": silo_public_key()}});
        let result = exchange(&address, &handshake, Instant::now() + request_timeout(&handshake))
            .map_err(Failure::message)?;
        if result["version"].as_u64() != Some(VERSION as u64) {
            return Err("Silo versions are incompatible. Update Silo on both computers.".into());
        }
        let id = result["hostId"]
            .as_str()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .ok_or("Invalid computer identity.")?;
        let name = result["name"]
            .as_str()
            .filter(|name| {
                !name.is_empty() && name.len() <= 255 && !name.chars().any(char::is_control)
            })
            .ok_or("Invalid computer name.")?;
        let host = RemoteHost {
            id: id.into(),
            name: name.into(),
            address,
        };
        let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
        save_connected_host(&directory()?, host, &self::name(), replace.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())?
}
/// Shown when a computer's identity is already saved at another address; the connect
/// form offers to replace the saved address after it.
const ALREADY_SAVED: &str = "is already saved at";
/// Saves the computer that answered at `host.address`. The identity is reported by that
/// computer, so it never silently takes over another saved entry: a known identity at a new
/// address is saved only when the user confirmed (`replace`).
fn save_connected_host(dir: &Path, host: RemoteHost, local_name: &str, replace: bool) -> Result<RemoteHost, String> {
    let mut config = read_config_in(dir)?;
    if config.host_id == host.id {
        return Err(if host.name == local_name {
            "This address points to this computer. Its VMs are already available locally.".into()
        } else {
            format!("{} uses this computer's Silo identity, probably because its Silo settings were copied from here. On {}, quit Silo, delete ~/.silo/desktop-remote/config.json, and open Silo again.", host.name, host.name)
        });
    }
    if let Some(saved) = config.hosts.iter().find(|saved| saved.id == host.id) {
        if saved.address != host.address && !replace {
            return Err(format!(
                "{} {ALREADY_SAVED} {}. Use {} for it instead only if that computer moved to this address.",
                saved.name, saved.address, host.address
            ));
        }
    }
    config.hosts.retain(|saved| saved.id != host.id);
    config.hosts.push(host.clone());
    save_config_in(dir, &config)?;
    Ok(host)
}

#[tauri::command]
pub async fn remote_host_snapshot(app: AppHandle, host_id: String, refresh_repositories: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = call_remote(&app, &host_id, "runtime.snapshot", json!({"refreshRepositories": refresh_repositories.unwrap_or(false)}));
        if result
            .as_ref()
            .is_err_and(|error| error != "SILO_SANDBOX_UPDATE_IN_PROGRESS")
        {
            crate::remote_network::close_host(&host_id);
    crate::desktop_viewer::close_host(&host_id);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_workspace_action(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    action: String,
    name: Option<String>,
) -> Result<Value, String> {
    // Elapsed time counts from the command, like a local action.
    let started = std::time::Instant::now();
    let notice_app = app.clone();
    let (notice_id, notice_action) = (vm_id.clone(), action.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        call_remote(
            &app,
            &host_id,
            "runtime.action",
            json!({"vmId":vm_id,"action":action}),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    // The owning computer reports only a state snapshot; the caller's name (or the
    // snapshot) names the sandbox. Without either, the notice says "this sandbox".
    let name = name
        .or_else(|| result.as_ref().ok().and_then(|state| sandbox_name(state, &notice_id)))
        .unwrap_or_else(|| "this sandbox".into());
    let sandbox = crate::notifications::NoticeSandbox { id: notice_id, name: name.clone() };
    let outcome = match &result {
        Ok(_) => crate::notifications::Outcome::Succeeded,
        Err(message) => crate::notifications::Outcome::Failed(message),
    };
    if let Some(notice) = crate::notifications::lifecycle_notice(
        &notice_action,
        &name,
        Some(sandbox),
        started.elapsed(),
        outcome,
    ) {
        crate::notifications::notify_native(&notice_app, notice);
    }
    result
}

/// Display name of one sandbox in a remote application snapshot.
fn sandbox_name(state: &Value, vm_id: &str) -> Option<String> {
    state["workspaces"]
        .as_array()?
        .iter()
        .find(|workspace| workspace["machine"]["id"] == vm_id)
        .and_then(|workspace| workspace["machine"]["name"].as_str())
        .map(str::to_owned)
}
#[tauri::command]
pub async fn remote_upsert_machine(
    app: AppHandle,
    host_id: String,
    machine: crate::runtime::MachineConfiguration,
    expected: Option<crate::runtime::MachineConfiguration>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        call_remote(
            &app,
            &host_id,
            "runtime.upsert",
            json!({"machine":machine,"expected":expected}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_delete_machine(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    expected: crate::runtime::MachineConfiguration,
) -> Result<Value, String> {
    let notice_app = app.clone();
    let deleted = vm_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        call_remote(
            &app,
            &host_id,
            "runtime.delete",
            json!({"vmId":vm_id,"expected":expected}),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    if result.is_ok() {
        // A deleted sandbox has nothing left to open: withdraw its delivered notices.
        crate::notifications::clear_sandbox(&notice_app, &deleted);
    }
    result
}
/// Called before constructing Tauri. A bridge never launches the GUI or runtime.
pub(crate) fn run_bridge() -> Result<(), String> {
    let mut socket = UnixStream::connect(directory()?.join("control.sock"))
        .map_err(|_| "Silo is not running on this computer.".to_string())?;
    let request = read_frame(std::io::stdin().lock())?;
    socket.set_read_timeout(Some(request_timeout(&request))).map_err(|e| e.to_string())?;
    let streaming = request["method"] == "guest.ssh";
    write_frame(&mut socket, &request)?;
    if !streaming {
        watch_controller(std::io::stdin(), socket.try_clone().map_err(|e| e.to_string())?);
    }
    let response = read_frame(&mut socket)?;
    write_reply(std::io::stdout().lock(), &response)?;
    if streaming && response.get("error").is_none() {
        socket.set_read_timeout(None).map_err(|e| e.to_string())?;
        let mut input = socket.try_clone().map_err(|e| e.to_string())?;
        thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
            let _ = input.shutdown(std::net::Shutdown::Write);
        });
        copy_raw_stream(&mut socket, &mut std::io::stdout().lock()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
/// The controller keeps the bridge's input open until it has its reply, so the end of
/// that input means the controller left. Closing the owner connection's write side then
/// tells the owner to drop work that has not started; a reply can still arrive.
fn watch_controller(mut input: impl Read + Send + 'static, owner: UnixStream) {
    thread::spawn(move || {
        let mut sink = [0u8; 256];
        loop {
            match input.read(&mut sink) {
                Ok(0) => break,
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = owner.shutdown(std::net::Shutdown::Write);
    });
}
pub(crate) fn run_remote_stream(host_id: &str, method: &str, params: Value) -> Result<(), String> {
    let host = read_config()?
        .hosts
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or("Saved computer not found.")?;
    validate_address(&host.address)?;
    let mut child = ssh_for_address(&host.address)?
        .args(["--", &host.address, BRIDGE_COMMAND])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut input = child.stdin.take().ok_or("SSH input unavailable.")?;
        let mut output = std::io::BufReader::new(child.stdout.take().ok_or("SSH output unavailable.")?);
        write_frame(
            &mut input,
            &json!({"version":VERSION,"hostId":host.id,"method":method,"params":params}),
        )?;
        let reply = read_reply(&mut output)?;
        if let Some(error) = reply["error"].as_str() {
            return Err(error.to_owned());
        }
        thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
        });
        copy_raw_stream(&mut output, &mut std::io::stdout().lock()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
const ACCEPT_BACKOFF: (Duration, Duration) = (Duration::from_millis(50), Duration::from_secs(2));
/// Accept errors (EMFILE, ECONNABORTED) are transient: keep serving after a bounded backoff.
fn serve_connections<S>(
    incoming: impl Iterator<Item = std::io::Result<S>>,
    (initial, limit): (Duration, Duration),
    mut handle: impl FnMut(S),
) {
    let mut backoff = initial;
    for stream in incoming {
        match stream {
            Ok(stream) => {
                backoff = initial;
                handle(stream);
            }
            Err(error) => {
                eprintln!("Remote management could not accept a connection: {error}");
                thread::sleep(backoff);
                backoff = (backoff * 2).min(limit);
            }
        }
    }
}
/// Holds `control.lock` in `dir`; only one Silo process serves remote management.
fn lease_control(dir: &Path) -> Result<fs::File, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let lease = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("control.lock"))
        .map_err(|e| e.to_string())?;
    if unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another Silo instance owns remote management.".into());
    }
    Ok(lease)
}
/// Binds `control.sock` in `dir` for this account only, replacing a stale socket.
fn bind_control_socket(dir: &Path) -> Result<UnixListener, String> {
    let path = dir.join("control.sock");
    if path.exists() {
        match UnixStream::connect(&path) {
            Ok(_) => return Err("Another Silo instance owns remote management.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Err(error) => {
                return Err(format!(
                    "Could not verify remote management socket ownership: {error}"
                ))
            }
        }
    }
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(listener)
}
/// Serves remote management for the app's lifetime. A failure never stops Silo from
/// opening: it is kept for the settings page (`error`) and retried when the user turns
/// remote management on again.
pub(crate) fn start(app: AppHandle) {
    let enabled = match read_config() {
        Ok(config) => config.enabled,
        Err(error) => return record_start_error(Some(error)),
    };
    REMOTE_ENABLED.store(enabled, std::sync::atomic::Ordering::Release);
    // Re-point the bridge link every launch: an AppImage mount or a moved app leaves it stale.
    let linked = if enabled { link_bridge_for_this_account() } else { Ok(()) };
    let listening = listen(app);
    record_start_error(listening.err().or(linked.err()));
}
fn listen(app: AppHandle) -> Result<(), String> {
    let lease = lease_control(&directory()?)?;
    let listener = bind_control_socket(&directory()?)?;
    LISTENING.store(true, std::sync::atomic::Ordering::Release);
    thread::spawn(move || {
        let _lease = lease;
        serve_connections(listener.incoming(), ACCEPT_BACKOFF, |mut stream| {
            let Some(permit) = ConnectionPermit::acquire() else {
                let _ = write_frame(
                    &mut stream,
                    &json!({"error":"This computer has too many active Silo connections. Close an unused connection and retry."}),
                );
                return;
            };
            let app = app.clone();
            thread::spawn(move || {
                let _permit = permit;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                let result = read_frame(&mut stream).and_then(|request| {
                    if request["method"] == "guest.ssh" {
                        authorize(&request)?;
                        let mut child = crate::remote_access::spawn_stream(
                            &app,
                            "guest.ssh",
                            &request["params"],
                        )?;
                        if let Err(error) = write_frame(&mut stream, &json!({"result":{}})) {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(error);
                        }
                        relay_child(&stream, &mut child, || {
                            REMOTE_ENABLED.load(std::sync::atomic::Ordering::Acquire)
                                && crate::runtime::shutdown::ensure_accepting_operations().is_ok()
                        })?;
                        return Ok(None);
                    }
                    let peer = stream.try_clone().map_err(|e| e.to_string())?;
                    dispatch(&app, request, Arc::new(move || connection_open(&peer))).map(Some)
                });
                match result {
                    Ok(Some(result)) => {
                        let _ = write_frame(&mut stream, &json!({"result":result}));
                    }
                    Err(error) => {
                        let _ = write_frame(&mut stream, &json!({"error":error}));
                    }
                    Ok(None) => {}
                }
            });
        });
    });
    Ok(())
}
pub(crate) fn ensure_management_enabled() -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    if !read_config()?.enabled { return Err("Remote management is disabled on this computer.".into()); }
    Ok(())
}

fn authorize(request: &Value) -> Result<Config, String> {
    authorize_in(&directory()?, request)
}
fn authorize_in(dir: &Path, request: &Value) -> Result<Config, String> {
    let config = {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
        read_config_in(dir)?
    };
    validate_authorization(&config, request)?;
    Ok(config)
}

fn validate_authorization(config: &Config, request: &Value) -> Result<(), String> {
    if !config.enabled {
        return Err("Remote management is disabled on this computer.".into());
    }
    crate::runtime::shutdown::ensure_accepting_operations()?;
    if request["version"].as_u64() != Some(VERSION as u64) {
        return Err("Silo versions are incompatible. Update Silo on both computers.".into());
    }
    if request["method"] != "handshake" && request["hostId"].as_str() != Some(&config.host_id) {
        return Err(
            "This address now belongs to a different Silo computer. Reconnect it explicitly."
                .into(),
        );
    }
    Ok(())
}

fn dispatch(app: &AppHandle, request: Value, connection: operations::Probe) -> Result<Value, String> {
    handle(&directory()?, &request, connection, Arc::new(changes_allowed), |method, params| {
        execute(app, method, params)
    })
}
/// Runs one authorized, classified request against this computer.
fn execute(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "handshake" => {
            // Earlier versions installed Silo's key without restrictions; tighten it over this session.
            if let Some(public) = params["sshKey"].as_str() {
                if let Err(error) = restrict_installed_key(public) {
                    eprintln!("Could not restrict Silo's SSH key: {error}");
                }
            }
            Ok(Value::Null)
        }
        _ if method.starts_with("runtime.") => {
            crate::runtime::remote_ops::dispatch(app, method, params.clone())
        }
        _ => crate::remote_access::dispatch(app, method, params),
    }
}
/// The methods this computer serves, reported in the handshake.
fn capabilities() -> Vec<&'static str> {
    METHODS.iter().map(|(method, _)| *method).collect()
}
/// Owner side of one bridged request: authorize, classify, then run it. A change is
/// accepted once per `operationId` (see `operations`), waits for its turn in the
/// operation gate, and starts only while `connection` is open, `allowed` holds and its
/// `startWithinMs` has not passed.
fn handle(
    dir: &Path,
    request: &Value,
    connection: operations::Probe,
    allowed: operations::Probe,
    execute: impl FnOnce(&str, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let config = authorize_in(dir, request)?;
    let method = request["method"].as_str().ok_or("Missing remote method.")?;
    let params = &request["params"];
    match access(method) {
        // Unknown methods are refused before any gate, state event or record.
        None | Some(Access::Stream) => Err(UNSUPPORTED.into()),
        Some(Access::Read) if method == "handshake" => {
            execute(method, params)?;
            Ok(json!({"hostId":config.host_id,"name":name(),"version":VERSION,"capabilities":capabilities()}))
        }
        Some(Access::Read) => execute(method, params),
        Some(Access::Change) => {
            let id = request["operationId"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or("Invalid remote request identity.")?;
            let start_within = request["startWithinMs"]
                .as_u64()
                .map(Duration::from_millis)
                .ok_or("Invalid remote request deadline.")?
                .min(request_timeout(request));
            let journal = dir.join("operations");
            fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
            CHANGES.submit(
                operations::Submission {
                    journal: &journal,
                    id,
                    method,
                    params,
                    start_within,
                    connection,
                    allowed,
                    wait: request_timeout(request),
                    reconnect_grace: operations::RECONNECT_GRACE,
                },
                || execute(method, params),
            )
        }
    }
}
/// Changes requested by other computers, by `operationId`.
static CHANGES: operations::Registry = operations::Registry::new();
/// True while this computer accepts remote changes.
fn changes_allowed() -> bool {
    REMOTE_ENABLED.load(std::sync::atomic::Ordering::Acquire)
        && crate::runtime::shutdown::ensure_accepting_operations().is_ok()
}
/// True until the peer closes its end of `stream` (the bridge closes it when its controller leaves).
fn connection_open(stream: &UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let mut byte = 0u8;
    // SAFETY: peeks at most one byte into a local buffer without blocking.
    let read = unsafe {
        libc::recv(
            stream.as_raw_fd(),
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    match read {
        0 => false,
        count if count > 0 => true,
        _ => matches!(
            std::io::Error::last_os_error().kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sandbox_name_is_read_from_a_remote_snapshot() {
        let state = json!({"workspaces":[{"machine":{"id":"a","name":"one"}},{"machine":{"id":"b","name":"two"}}]});
        assert_eq!(sandbox_name(&state, "b").as_deref(), Some("two"));
        assert_eq!(sandbox_name(&state, "c"), None);
        assert_eq!(sandbox_name(&json!({}), "a"), None);
    }
    #[test]
    fn checkpoint_actions_build_owner_routed_requests_with_vm_identity() {
        let vm = "11111111-1111-4111-8111-111111111111";
        assert_eq!(checkpoint_remote_request(vm, "create", Some("Point"), None, None).unwrap(),
            ("checkpoint.create", json!({"vmId":vm,"name":"Point"})));
        assert_eq!(checkpoint_remote_request(vm, "fork", None, Some("checkpoint-id"), Some("Branch")).unwrap(),
            ("checkpoint.fork", json!({"vmId":vm,"checkpointId":"checkpoint-id","newName":"Branch"})));
        assert_eq!(checkpoint_remote_request(vm, "restore", None, Some("checkpoint-id"), None).unwrap(),
            ("checkpoint.restore", json!({"vmId":vm,"checkpointId":"checkpoint-id"})));
        assert!(checkpoint_remote_request("not-an-id", "create", Some("Point"), None, None).is_err());
    }

    #[test]
    fn desktop_tools_setup_has_time_to_install_over_remote_connection() {
        assert_eq!(request_timeout(&json!({"method":"desktop.action","params":{"action":"setup-tools"}})), Duration::from_secs(2100));
        assert_eq!(request_timeout(&json!({"method":"desktop.action","params":{"action":"update-streamer"}})), Duration::from_secs(2100));
        assert_eq!(request_timeout(&json!({"method":"desktop.action","params":{"action":"setup-lcu"}})), Duration::from_secs(2100));
        assert_eq!(request_timeout(&json!({"method":"desktop.action","params":{"action":"restart-streamer"}})), Duration::from_secs(600));
        assert_eq!(request_timeout(&json!({"method":"desktop.action","params":{"action":"start"}})), Duration::from_secs(600));
    }

    #[test]
    fn rejects_shell_and_option_addresses() {
        for address in [
            "-oProxyCommand=evil",
            "host;touch /tmp/x",
            "$(whoami)",
            "host\nother",
            "ssh://user:password@host",
            "ssh://host/path",
            "ssh://host?command=evil",
            "",
        ] {
            assert!(validate_address(address).is_err());
        }
        for address in [
            "studio",
            "me@studio.local",
            "192.168.1.4",
            "::1",
            "ssh://user@host:2222",
            "ssh://user@[::1]:2222",
        ] {
            assert!(validate_address(address).is_ok());
        }
    }
    #[test]
    fn frames_are_bounded_and_round_trip() {
        let value = json!({"method":"handshake"});
        let mut bytes = vec![];
        write_frame(&mut bytes, &value).unwrap();
        assert_eq!(read_frame(bytes.as_slice()).unwrap(), value);
        assert!(read_frame((LIMIT as u32 + 1).to_be_bytes().as_slice()).is_err());
    }
}
/// Drain child output after input EOF; terminate and reap on revocation or a stalled close.
fn relay_child(
    stream: &UnixStream,
    child: &mut std::process::Child,
    allowed: impl Fn() -> bool,
) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let result = (|| {
        let mut input = child.stdin.take().ok_or("Guest input unavailable.")?;
        let mut output = child.stdout.take().ok_or("Guest output unavailable.")?;
        stream.set_read_timeout(None).map_err(|e| e.to_string())?;
        let mut upstream = stream.try_clone().map_err(|e| e.to_string())?;
        let mut downstream = stream.try_clone().map_err(|e| e.to_string())?;
        let input_done = Arc::new(AtomicBool::new(false));
        let input_flag = input_done.clone();
        let output_done = Arc::new(AtomicBool::new(false));
        let output_flag = output_done.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let input_cancel = cancelled.clone();
        let output_cancel = cancelled.clone();
        nonblocking(&upstream)?;
        nonblocking(&downstream)?;
        nonblocking(&input)?;
        nonblocking(&output)?;
        let input_thread = thread::spawn(move || {
            let result = copy_cancellable(&mut upstream, &mut input, &input_cancel);
            drop(input);
            input_flag.store(true, Ordering::Release);
            result
        });
        let output_thread = thread::spawn(move || {
            let result = copy_cancellable(&mut output, &mut downstream, &output_cancel);
            output_flag.store(true, Ordering::Release);
            result
        });
        let mut closed_at = None;
        loop {
            if input_done.load(Ordering::Acquire) {
                closed_at.get_or_insert_with(Instant::now);
            }
            if output_done.load(Ordering::Acquire)
                || !allowed()
                || closed_at
                    .is_some_and(|at| Instant::now().duration_since(at) > Duration::from_secs(3))
            {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        cancelled.store(true, Ordering::Release);
        let _ = child.kill();
        let _ = child.wait();
        let _ = stream.shutdown(std::net::Shutdown::Both);
        // Shutdown releases the socket reader; killing the owned child closes its pipe.
        let _ = input_thread.join();
        let _ = output_thread.join();
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = stream.shutdown(std::net::Shutdown::Both);
    result
}
#[cfg(test)]
mod stream_tests {
    use super::*;
    #[test]
    fn raw_binary_stream_reaches_output_without_newline_or_input_eof() {
        let (mut source_writer, source_reader) = UnixStream::pair().unwrap();
        let (output_writer, mut output_reader) = UnixStream::pair().unwrap();
        output_reader
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        let worker = thread::spawn(move || {
            copy_raw_stream(source_reader, std::io::LineWriter::new(output_writer)).unwrap();
        });
        let payload = b"\0SSH binary\x01";
        source_writer.write_all(payload).unwrap();
        let mut observed = [0; 12];
        let result = output_reader.read_exact(&mut observed);
        drop(source_writer);
        worker.join().unwrap();
        assert!(result.is_ok(), "raw bytes remained buffered while input was open: {result:?}");
        assert_eq!(&observed, payload);
    }
    #[test]
    fn stream_reply_arrives_before_client_sends_ssh_bytes() {
        let (mut client, server) = UnixStream::pair().unwrap();
        client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let worker = thread::spawn(move || {
            let mut output = std::io::BufWriter::new(server);
            write_reply(&mut output, &json!({"result":{}})).unwrap();
            output.get_mut().set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut banner = [0; 4];
            output.get_mut().read_exact(&mut banner).map(|_| banner)
        });
        let response = read_reply(std::io::BufReader::new(&client));
        if response.is_ok() {
            client.write_all(b"SSH-").unwrap();
        }
        drop(client);
        let banner = worker.join().unwrap();
        assert_eq!(response.unwrap()["result"], json!({}));
        assert_eq!(banner.unwrap(), *b"SSH-");
    }
    fn child(program: &str, args: &[&str]) -> std::process::Child {
        Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    #[test]
    fn input_eof_drains_response_and_reaps_child() {
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let worker = thread::spawn(move || {
            let mut child = child("/bin/cat", &[]);
            relay_child(&server, &mut child, || true).unwrap();
            assert!(child.try_wait().unwrap().is_some());
        });
        client.write_all(b"SSH payload survives input EOF").unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        let mut output = Vec::new();
        client.read_to_end(&mut output).unwrap();
        assert_eq!(output, b"SSH payload survives input EOF");
        worker.join().unwrap();
    }
    #[test]
    fn revocation_interrupts_full_child_and_client_pipes() {
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = thread::spawn(move || {
            let _ = client.write_all(&vec![b'x'; 2 * 1024 * 1024]);
        });
        let mut blocked_input = child("/bin/sleep", &["60"]);
        let deadline = Instant::now() + Duration::from_millis(100);
        relay_child(&server, &mut blocked_input, || Instant::now() < deadline).unwrap();
        drop(server);
        writer.join().unwrap();
        assert!(blocked_input.try_wait().unwrap().is_some());
        let (_client, server) = UnixStream::pair().unwrap();
        let mut blocked_output = child("/usr/bin/yes", &[]);
        let deadline = Instant::now() + Duration::from_millis(100);
        relay_child(&server, &mut blocked_output, || Instant::now() < deadline).unwrap();
        assert!(blocked_output.try_wait().unwrap().is_some());
    }
    #[test]
    fn stdout_eof_releases_blocked_input_and_revocation_closes_live_child() {
        let (_client, server) = UnixStream::pair().unwrap();
        let mut exited = child("/usr/bin/true", &[]);
        let start = Instant::now();
        relay_child(&server, &mut exited, || true).unwrap();
        assert!(start.elapsed() < Duration::from_secs(2));
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut live = child("/bin/cat", &[]);
        relay_child(&server, &mut live, || false).unwrap();
        assert!(live.try_wait().unwrap().is_some());
        let mut byte = [0];
        assert_eq!(client.read(&mut byte).unwrap(), 0);
    }
}

fn nonblocking(io: &impl std::os::fd::AsRawFd) -> Result<(), String> {
    let fd = io.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
fn copy_cancellable<R: Read + std::os::fd::AsRawFd, W: Write + std::os::fd::AsRawFd>(
    reader: &mut R,
    writer: &mut W,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::io::Result<()> {
    use std::sync::atomic::Ordering;
    let ready = |fd, events| {
        let mut poll = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        unsafe { libc::poll(&mut poll, 1, 100) };
    };
    let mut buffer = [0u8; 32768];
    while !cancelled.load(Ordering::Acquire) {
        let count = match reader.read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                ready(reader.as_raw_fd(), libc::POLLIN);
                continue;
            }
            Err(error) => return Err(error),
        };
        let mut written = 0;
        while written < count && !cancelled.load(Ordering::Acquire) {
            match writer.write(&buffer[written..count]) {
                Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                Ok(count) => written += count,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    ready(writer.as_raw_fd(), libc::POLLOUT)
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

static CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
struct ConnectionPermit;
impl ConnectionPermit {
    fn acquire() -> Option<Self> {
        use std::sync::atomic::Ordering;
        CONNECTIONS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 64).then_some(count + 1)
            })
            .ok()
            .map(|_| Self)
    }
}
impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        CONNECTIONS.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

#[cfg(test)]
mod setup_tests {
    use super::*;
    /// sshd runs the remote command with the account's login shell: `$SHELL -c COMMAND`.
    fn install_with(shell: &Path) {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        let authorized = ssh.join("authorized_keys");
        fs::write(&authorized, b"existing-key-without-final-newline").unwrap();
        let public = "ssh-ed25519 AAAA public-comment-$(never-execute)";
        for _ in 0..2 {
            let mut child = Command::new(shell)
                .args(["-c", INSTALL_PUBLIC_KEY])
                .env("HOME", home.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(public.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{}: {}", shell.display(), String::from_utf8_lossy(&output.stderr));
        }
        assert_eq!(
            fs::read_to_string(authorized).unwrap(),
            format!("existing-key-without-final-newline\n{public}\n"),
            "{}",
            shell.display()
        );
    }
    #[test]
    fn key_setup_creates_silos_key_once_and_installs_its_restricted_line() {
        let dir = tempfile::tempdir().unwrap();
        assert!(key_setup_command(dir.path(), "-oProxyCommand=evil").is_err());
        assert!(!dir.path().join("id_ed25519").exists());
        let command = key_setup_command(dir.path(), "me@office").unwrap();
        let key = dir.path().join("id_ed25519");
        assert_eq!(fs::metadata(&key).unwrap().permissions().mode() & 0o077, 0);
        let public = fs::read_to_string(key.with_extension("pub")).unwrap();
        assert!(command.starts_with("printf '%s\n' "));
        assert!(command.contains(&authorized_key_line(&public).unwrap()));
        assert!(command.contains("sh -c"));
        assert!(command.contains("me@office"));
        // A second setup reuses the key.
        let again = key_setup_command(dir.path(), "me@office").unwrap();
        assert_eq!(again, command);
        let authorize = authorize_command("me@office").unwrap();
        assert!(authorize.contains("StrictHostKeyChecking=ask") && authorize.ends_with(&format!("{} {}", crate::terminal::quote("me@office"), crate::terminal::quote("true"))));
        assert!(authorize_command("$(whoami)").is_err());
    }
    #[test]
    fn commands_that_launch_processes_stay_off_the_main_thread() {
        // Tauri runs a synchronous command on the main thread; only quick settings reads
        // and writes may be synchronous here.
        let quick = ["remote_management_status", "set_remote_management", "remote_host_list", "remove_remote_host"];
        let source = include_str!("remote.rs");
        let mut commands = 0;
        for block in source.split("#[tauri::command]").skip(1) {
            let signature = block.trim_start().lines().next().unwrap();
            if !signature.starts_with("pub") {
                continue;
            }
            let name = signature.split("fn ").nth(1).unwrap().split('(').next().unwrap();
            commands += 1;
            assert!(signature.contains("async fn") || quick.contains(&name), "{name} must be async");
        }
        assert!(commands >= 10);
    }
    #[test]
    fn public_key_install_preserves_existing_unterminated_line_and_is_idempotent() {
        install_with(Path::new("/bin/sh"));
    }
    #[test]
    fn public_key_install_works_from_any_login_shell() {
        let mut shells: Vec<PathBuf> = ["/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh", "/bin/csh", "/bin/tcsh"]
            .into_iter()
            .map(PathBuf::from)
            .collect();
        // fish and nushell are not POSIX shells; test them where installed.
        for name in ["fish", "nu"] {
            if let Some(found) = std::env::var_os("PATH")
                .map(|path| std::env::split_paths(&path).map(|dir| dir.join(name)).collect::<Vec<_>>())
                .and_then(|candidates| candidates.into_iter().find(|candidate| candidate.is_file()))
            {
                shells.push(found);
            }
        }
        let available: Vec<_> = shells.into_iter().filter(|shell| shell.is_file()).collect();
        assert!(available.iter().any(|shell| shell.ends_with("csh") || shell.ends_with("tcsh") || shell.ends_with("fish")), "no non-POSIX shell to test");
        for shell in available {
            install_with(&shell);
        }
    }
}

#[cfg(test)]
mod connection_failure_tests {
    use super::*;
    #[test]
    fn distinguishes_ssh_failures_from_bridge_failures() {
        let changed = "@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n";
        assert!(connection_failure(Some(255), changed).contains("host key changed"));
        assert!(connection_failure(Some(255), "Host key verification failed.\n").starts_with("Host key verification failed."));
        assert!(connection_failure(Some(255), "user@office: Permission denied (publickey).\n").starts_with("SSH authentication failed"));
        assert!(connection_failure(Some(255), "Received disconnect: Too many authentication failures\n").starts_with("SSH authentication failed"));
        assert!(connection_failure(Some(255), "ssh: connect to host office port 22: Connection refused\n").contains("refused"));
        assert!(connection_failure(Some(255), "ssh: connect to host office port 22: Operation timed out\n").contains("timed out"));
        assert!(connection_failure(Some(255), "ssh: Could not resolve hostname office\n").contains("resolve"));
        assert_eq!(connection_failure(Some(255), "\x1b[31msecret banner"), CONNECTION_HELP);
        // Bridge failures exit 1 (or 127 when the link is missing) after authentication succeeded.
        assert!(connection_failure(Some(1), "Silo is not running on this computer.\n").contains("not running on the other computer"));
        assert!(connection_failure(Some(127), "sh: /home/u/.local/bin/silo-remote: not found\n").contains("bridge is missing"));
        assert_eq!(connection_failure(Some(1), "Permission denied"), CONNECTION_HELP);
    }
}

#[cfg(test)]
mod accept_tests {
    use super::*;
    #[test]
    fn accept_errors_do_not_stop_the_owner_listener() {
        let incoming = vec![
            Err(std::io::Error::from_raw_os_error(libc::EMFILE)),
            Ok(1),
            Err(std::io::Error::from_raw_os_error(libc::ECONNABORTED)),
            Err(std::io::Error::from_raw_os_error(libc::EMFILE)),
            Ok(2),
        ];
        let mut served = Vec::new();
        let started = Instant::now();
        serve_connections(
            incoming.into_iter(),
            (Duration::from_millis(5), Duration::from_millis(8)),
            |stream| served.push(stream),
        );
        assert_eq!(served, [1, 2]);
        assert!(started.elapsed() >= Duration::from_millis(18));
    }
}

#[cfg(test)]
mod authorized_key_tests {
    use super::*;
    const BLOB: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIHk8t0ahm+m4Qf9wTQ2xV1Vv2Qb2QeQ3bE8m0l2a6y5Z";

    #[test]
    fn installed_line_only_allows_the_bridge_and_loopback_tunnels() {
        let line = authorized_key_line(&format!("ssh-ed25519 {BLOB} {SILO_KEY_COMMENT}\n")).unwrap();
        assert_eq!(
            line,
            format!(r#"restrict,port-forwarding,permitopen="127.0.0.1:*",command="exec ~/.local/bin/silo-remote --remote-bridge" ssh-ed25519 {BLOB} Silo remote management"#)
        );
        for invalid in [
            "",
            "ssh-rsa AAAA Silo remote management",
            "ssh-ed25519",
            "ssh-ed25519 AAAA\"x",
            "ssh-ed25519 $(touch) Silo",
            "command=\"sh\" ssh-ed25519 AAAA",
        ] {
            assert!(authorized_key_line(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn rewrites_only_silos_own_unrestricted_line() {
        let own = format!("ssh-ed25519 {BLOB} {SILO_KEY_COMMENT}");
        let contents = format!(
            "ssh-ed25519 AAAAother user@laptop\n{own}\nfrom=\"10.0.0.1\" {own}\nssh-ed25519 {BLOB} personal\n{own}"
        );
        let rewritten = restrict_authorized_keys(&contents, BLOB).unwrap();
        let restricted = format!("{AUTHORIZED_KEY_OPTIONS} {own}");
        assert_eq!(
            rewritten,
            format!(
                "ssh-ed25519 AAAAother user@laptop\n{restricted}\nfrom=\"10.0.0.1\" {own}\nssh-ed25519 {BLOB} personal\n{restricted}"
            )
        );
        assert_eq!(restrict_authorized_keys(&rewritten, BLOB), None);
        assert_eq!(restrict_authorized_keys(&contents, "AAAAother"), None);
    }

    #[test]
    fn rewrite_preserves_file_mode_and_skips_symlinks() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("authorized_keys");
        let public = format!("ssh-ed25519 {BLOB} {SILO_KEY_COMMENT}");
        fs::write(&path, format!("ssh-ed25519 AAAAother user\n{public}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(restrict_authorized_keys_file(&path, &public).unwrap());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            format!("ssh-ed25519 AAAAother user\n{AUTHORIZED_KEY_OPTIONS} {public}\n")
        );
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!restrict_authorized_keys_file(&path, &public).unwrap());
        assert!(!home.path().join(".authorized_keys.silo-restrict").exists());

        let target = home.path().join("managed");
        fs::write(&target, format!("{public}\n")).unwrap();
        let link = home.path().join("linked");
        symlink(&target, &link).unwrap();
        assert!(!restrict_authorized_keys_file(&link, &public).unwrap());
        assert_eq!(fs::read_to_string(&target).unwrap(), format!("{public}\n"));
        assert!(!restrict_authorized_keys_file(&home.path().join("missing"), &public).unwrap());
    }
}

#[cfg(test)]
mod connect_tests {
    use super::*;
    fn host(id: &str, name: &str, address: &str) -> RemoteHost {
        RemoteHost { id: id.into(), name: name.into(), address: address.into() }
    }
    fn saved(dir: &Path) -> Vec<(String, String, String)> {
        read_config_in(dir).unwrap().hosts.into_iter().map(|h| (h.id, h.name, h.address)).collect()
    }

    #[test]
    fn a_reported_identity_never_silently_takes_over_a_saved_computer() {
        let home = tempfile::tempdir().unwrap();
        let dir = directory_in(home.path()).unwrap();
        let office = uuid::Uuid::new_v4().to_string();
        save_connected_host(&dir, host(&office, "Office", "office.local"), "Laptop", false).unwrap();
        // Same computer, same address: the name is refreshed.
        save_connected_host(&dir, host(&office, "Office Mac", "office.local"), "Laptop", false).unwrap();
        assert_eq!(saved(&dir), [(office.clone(), "Office Mac".into(), "office.local".into())]);
        // Another address claims the saved identity: refused until the user confirms.
        let error = save_connected_host(&dir, host(&office, "Office Mac", "10.0.0.9"), "Laptop", false).unwrap_err();
        assert!(error.contains(ALREADY_SAVED) && error.contains("office.local") && error.contains("10.0.0.9"), "{error}");
        assert_eq!(saved(&dir), [(office.clone(), "Office Mac".into(), "office.local".into())]);
        save_connected_host(&dir, host(&office, "Office Mac", "10.0.0.9"), "Laptop", true).unwrap();
        assert_eq!(saved(&dir), [(office, "Office Mac".into(), "10.0.0.9".into())]);
    }

    #[test]
    fn this_computers_identity_is_named_as_itself_or_as_a_copy() {
        let home = tempfile::tempdir().unwrap();
        let dir = directory_in(home.path()).unwrap();
        let own = read_config_in(&dir).unwrap().host_id;
        let error = save_connected_host(&dir, host(&own, "Laptop", "localhost"), "Laptop", true).unwrap_err();
        assert!(error.contains("points to this computer"));
        let error = save_connected_host(&dir, host(&own, "Studio", "studio.local"), "Laptop", true).unwrap_err();
        assert!(error.contains("Studio uses this computer's Silo identity"), "{error}");
        assert!(saved(&dir).is_empty());
    }
}

#[cfg(test)]
mod bridge_link_tests {
    use super::*;
    fn executable(path: &Path) {
        fs::write(path, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_link_names_the_appimage_file_not_its_temporary_mount() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("Silo.AppImage");
        executable(&image);
        let mounted = PathBuf::from("/tmp/.mount_SiloAb12/usr/bin/silo-ui");
        assert_eq!(select_bridge_target(Some(image.clone()), mounted.clone()).unwrap(), image);
        let plain = dir.path().join("plain");
        fs::write(&plain, b"").unwrap();
        for ignored in [dir.path().join("missing.AppImage"), plain, PathBuf::from("Silo.AppImage")] {
            assert_eq!(select_bridge_target(Some(ignored), mounted.clone()).unwrap(), mounted);
        }
        let translocated = PathBuf::from("/private/var/folders/x/T/AppTranslocation/ABC/d/Silo.app/Contents/MacOS/silo-ui");
        assert!(select_bridge_target(None, translocated).unwrap_err().contains("Applications"));
    }

    #[test]
    fn the_link_is_repointed_but_never_replaces_someone_elses_file() {
        let home = tempfile::tempdir().unwrap();
        let apps = tempfile::tempdir().unwrap();
        let link = home.path().join(".local/bin/silo-remote");
        let target = apps.path().join("Silo_0.6.0_amd64.AppImage");
        executable(&target);
        link_bridge(home.path(), &target).unwrap();
        assert_eq!(fs::read_link(&link).unwrap(), target);
        link_bridge(home.path(), &target).unwrap();
        // Links Silo made before: a vanished AppImage mount, an older AppImage, a moved app.
        let older = apps.path().join("Silo_0.5.0_amd64.AppImage");
        executable(&older);
        for previous in [PathBuf::from("/tmp/.mount_gone/usr/bin/silo-ui"), older, apps.path().join("moved/silo-ui")] {
            fs::remove_file(&link).unwrap();
            symlink(&previous, &link).unwrap();
            link_bridge(home.path(), &target).unwrap();
            assert_eq!(fs::read_link(&link).unwrap(), target, "{}", previous.display());
        }
        // Another program's link or a real file stays untouched.
        let other = apps.path().join("other-tool");
        executable(&other);
        fs::remove_file(&link).unwrap();
        symlink(&other, &link).unwrap();
        assert!(link_bridge(home.path(), &target).unwrap_err().contains("already exists"));
        assert_eq!(fs::read_link(&link).unwrap(), other);
        fs::remove_file(&link).unwrap();
        fs::write(&link, b"mine").unwrap();
        assert!(link_bridge(home.path(), &target).unwrap_err().contains("already exists"));
        assert_eq!(fs::read(&link).unwrap(), b"mine");
    }

    #[test]
    fn copyable_addresses_prefer_names_then_tailscale_then_interfaces() {
        let interfaces = ["192.168.1.4", "100.101.102.103", "169.254.3.4", "10.0.0.2", "100.128.0.1", "not-an-ip"].map(String::from);
        let list = |name| {
            management_addresses("ana", name, &interfaces)
                .into_iter()
                .map(|entry| (entry.address, entry.kind))
                .collect::<Vec<_>>()
        };
        let expected_ips = [
            ("ana@100.101.102.103", "tailscale"),
            ("ana@192.168.1.4", "network"),
            ("ana@10.0.0.2", "network"),
            ("ana@100.128.0.1", "network"),
        ];
        let owned = |pairs: &[(&str, &'static str)]| pairs.iter().map(|(a, k)| (a.to_string(), *k)).collect::<Vec<_>>();
        assert_eq!(list("studio"), owned(&[[("ana@studio.local", "name"), ("ana@studio", "name")].as_slice(), &expected_ips].concat()));
        assert_eq!(list("Anas-Mac.local"), owned(&[[("ana@Anas-Mac.local", "name")].as_slice(), &expected_ips].concat()));
        assert_eq!(list(""), owned(&expected_ips));
    }

    #[test]
    fn a_start_failure_is_reported_in_the_status() {
        let config = Config { host_id: uuid::Uuid::new_v4().to_string(), enabled: true, hosts: vec![] };
        record_start_error(Some("Another Silo instance owns remote management.".into()));
        assert_eq!(status(&config).error.as_deref(), Some("Another Silo instance owns remote management."));
        record_start_error(None);
        assert_eq!(status(&config).error, None);
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    fn arguments(command: &Command) -> Vec<String> {
        command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn silos_key_is_offered_alone_unless_only_other_keys_work() {
        let key = Path::new("/private/key");
        let only = arguments(&ssh_with_identity("office", Some(key), Identity::SiloOnly).unwrap());
        assert!(only.windows(2).any(|pair| pair == ["-i", "/private/key"]));
        assert!(only.windows(2).any(|pair| pair == ["-o", "IdentitiesOnly=yes"]));
        let any = arguments(&ssh_with_identity("office", Some(key), Identity::AnyKey).unwrap());
        assert!(any.windows(2).any(|pair| pair == ["-i", "/private/key"]));
        assert!(!any.iter().any(|arg| arg.starts_with("IdentitiesOnly")));
        let none = arguments(&ssh_with_identity("office", None, Identity::SiloOnly).unwrap());
        assert!(!none.iter().any(|arg| arg == "-i" || arg.starts_with("IdentitiesOnly")));
    }

    #[test]
    fn a_refused_key_choice_falls_back_once_and_is_remembered() {
        let address = format!("fallback-{}", uuid::Uuid::new_v4());
        let refused = || Err(Failure::Failed(AUTHENTICATION_FAILED.into()));
        // Silo's key is not installed there yet: the user's agent keys authenticate.
        let mut tried = Vec::new();
        let result = with_identity_fallback(&address, true, |identity| {
            tried.push(identity);
            if identity == Identity::SiloOnly { refused() } else { Ok(json!(1)) }
        });
        assert_eq!((result, tried), (Ok(json!(1)), vec![Identity::SiloOnly, Identity::AnyKey]));
        assert_eq!(preferred_identity(&address), Identity::AnyKey);
        // After "Set up Silo SSH key", too many agent keys are refused; Silo's key alone works.
        let mut tried = Vec::new();
        let result = with_identity_fallback(&address, true, |identity| {
            tried.push(identity);
            if identity == Identity::AnyKey { refused() } else { Ok(json!(2)) }
        });
        assert_eq!((result, tried), (Ok(json!(2)), vec![Identity::AnyKey, Identity::SiloOnly]));
        assert_eq!(preferred_identity(&address), Identity::SiloOnly);
        // Other failures and computers without Silo's key are tried once.
        let mut attempts = 0;
        let lost = with_identity_fallback(&address, true, |_| {
            attempts += 1;
            Err(Failure::Lost("dropped".into()))
        });
        assert_eq!((lost, attempts), (Err(Failure::Lost("dropped".into())), 1));
        let mut attempts = 0;
        let result = with_identity_fallback(&address, false, |_| {
            attempts += 1;
            refused()
        });
        assert_eq!((result, attempts), (refused(), 1));
    }
}

#[cfg(test)]
mod reply_tests {
    use super::*;
    fn reply(value: &Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_reply(&mut bytes, value).unwrap();
        bytes
    }

    #[test]
    fn replies_are_found_after_shell_startup_output() {
        let value = json!({"result":{"hostId":"office"}});
        for noise in [
            &b""[..],
            b"Welcome to office\n",
            b"conda init\n\0\0SILO-BRIDGE\n\0SILO-BRIDGE-REPL",
            b"\x1b[32mgreen banner\x1b[0m\r\n",
        ] {
            let bytes = [noise, &reply(&value)].concat();
            assert_eq!(read_reply(bytes.as_slice()).unwrap(), value, "{noise:?}");
        }
        let flood = [vec![b'x'; REPLY_SEARCH_LIMIT + 1], reply(&value)].concat();
        assert!(read_reply(flood.as_slice()).unwrap_err().contains("shell startup files"));
        assert!(read_reply(&b"motd only\n"[..]).unwrap_err().contains("connection ended"));
        // A frame without the preamble (earlier bridges) is never trusted as a reply.
        let mut bare = Vec::new();
        write_frame(&mut bare, &value).unwrap();
        assert!(read_reply(bare.as_slice()).is_err());
    }

    #[test]
    fn an_exchange_skips_what_the_remote_shell_prints() {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), reply(&json!({"result":{"ok":true}}))).unwrap();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo 'Last login: today'; printf 'conda: base\\n'; cat \"$0\""]).arg(file.path());
        let result = run_exchange(command, &json!({"method":"runtime.snapshot"}), Instant::now() + Duration::from_secs(10));
        assert_eq!(result, Ok(json!({"ok":true})));
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A private owner directory (never the real `~/.silo`) with management enabled.
    fn owner() -> (tempfile::TempDir, PathBuf, Config) {
        let home = tempfile::tempdir().unwrap();
        let dir = directory_in(home.path()).unwrap();
        let mut config = read_config_in(&dir).unwrap();
        config.enabled = true;
        save_config_in(&dir, &config).unwrap();
        (home, dir, config)
    }
    fn request(config: &Config, method: &str) -> Value {
        json!({"version":VERSION,"hostId":config.host_id,"operationId":uuid::Uuid::new_v4().to_string(),"startWithinMs":60_000,"method":method,"params":{"vmId":"vm"}})
    }
    /// Handles `request` over an open connection; changes are allowed while `dir`'s
    /// settings keep remote management enabled.
    fn run(
        dir: &Path,
        request: &Value,
        execute: impl FnOnce(&str, &Value) -> Result<Value, String>,
    ) -> Result<Value, String> {
        let settings = dir.to_owned();
        let allowed = Arc::new(move || read_config_in(&settings).is_ok_and(|config| config.enabled));
        handle(dir, request, Arc::new(|| true), allowed, execute)
    }
    fn methods(access: Access) -> Vec<&'static str> {
        METHODS.iter().filter(|(_, a)| *a == access).map(|(m, _)| *m).collect()
    }
    /// Quoted `word.word` literals: the method names a dispatcher source matches on.
    fn method_literals(source: &str) -> std::collections::BTreeSet<String> {
        source
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|text| {
                text.contains('.')
                    && text.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_lowercase()))
            })
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn every_served_method_is_classified_and_every_change_is_recorded() {
        assert_eq!(
            methods(Access::Change),
            [
                "runtime.action", "runtime.upsert", "runtime.delete", "desktop.action",
                "ssh.access.save", "guest.prepare", "network.publish", "repository.push.start",
                "repository.push", "repository.dismiss", "checkpoint.create", "checkpoint.fork",
                "checkpoint.restore",
            ]
        );
        assert_eq!(methods(Access::Stream), ["guest.ssh"]);
        let served: std::collections::BTreeSet<String> = method_literals(include_str!("remote_access.rs"))
            .into_iter()
            .chain(method_literals(include_str!("runtime/remote_ops.rs")))
            .collect();
        for method in &served {
            assert!(access(method).is_some(), "{method} is dispatched but not classified");
        }
        for (method, _) in METHODS.iter().filter(|(m, _)| *m != "handshake") {
            assert!(served.contains(*method), "{method} is classified but never dispatched");
        }
        let mut names = capabilities();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), METHODS.len());
    }

    #[test]
    fn changes_are_recorded_once_and_reads_run_every_time() {
        let (_home, dir, config) = owner();
        let runs = AtomicUsize::new(0);
        for method in methods(Access::Change) {
            let request = request(&config, method);
            for _ in 0..2 {
                let result = run(&dir, &request, |called, _| {
                    assert_eq!(called, method);
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"ran":method}))
                });
                assert_eq!(result.unwrap(), json!({"ran":method}));
            }
            let id = request["operationId"].as_str().unwrap();
            assert!(dir.join("operations").join(format!("{id}.json")).is_file(), "{method}");
        }
        assert_eq!(runs.swap(0, Ordering::SeqCst), methods(Access::Change).len());
        let recorded = fs::read_dir(dir.join("operations")).unwrap().count();
        for method in methods(Access::Read).into_iter().filter(|m| *m != "handshake") {
            let request = request(&config, method);
            for _ in 0..2 {
                run(&dir, &request, |_, _| {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                })
                .unwrap();
            }
        }
        assert_eq!(runs.load(Ordering::SeqCst), 2 * (methods(Access::Read).len() - 1));
        assert_eq!(fs::read_dir(dir.join("operations")).unwrap().count(), recorded);
    }

    #[test]
    fn refused_requests_never_run() {
        let (_home, dir, config) = owner();
        let refuse = |request: &Value| {
            run(&dir, request, |method, _| panic!("{method} must not run")).unwrap_err()
        };
        let mut other = request(&config, "runtime.action");
        other["hostId"] = json!(uuid::Uuid::new_v4().to_string());
        assert!(refuse(&other).contains("different Silo computer"));
        other["method"] = json!("runtime.snapshot");
        assert!(refuse(&other).contains("different Silo computer"));
        let mut stale = request(&config, "runtime.action");
        stale["version"] = json!(VERSION - 1);
        assert!(refuse(&stale).contains("incompatible"));
        for id in [json!("not-a-uuid"), Value::Null, json!(7)] {
            let mut change = request(&config, "checkpoint.restore");
            change["operationId"] = id;
            assert_eq!(refuse(&change), "Invalid remote request identity.");
        }
        let mut undated = request(&config, "checkpoint.restore");
        undated["startWithinMs"] = Value::Null;
        assert_eq!(refuse(&undated), "Invalid remote request deadline.");
        for method in ["runtime.unknown", "network.unpublish.all", "guest.ssh", ""] {
            assert_eq!(refuse(&request(&config, method)), UNSUPPORTED);
        }
        let mut disabled = config.clone();
        disabled.enabled = false;
        save_config_in(&dir, &disabled).unwrap();
        assert!(refuse(&request(&config, "runtime.snapshot")).contains("disabled"));
        assert!(!dir.join("operations").exists());
    }

    #[test]
    fn handshake_reports_identity_and_capabilities_without_a_pinned_owner() {
        let (_home, dir, config) = owner();
        let request = json!({"version":VERSION,"method":"handshake","params":{}});
        let result = run(&dir, &request, |method, _| {
            assert_eq!(method, "handshake");
            Ok(Value::Null)
        })
        .unwrap();
        assert_eq!(result["hostId"], json!(config.host_id));
        assert_eq!(result["version"], json!(VERSION));
        assert_eq!(result["capabilities"], json!(capabilities()));
    }

    #[test]
    fn a_queued_change_rechecks_access_when_its_turn_comes() {
        let (_home, dir, config) = owner();
        let vm = uuid::Uuid::new_v4().to_string();
        let (held, release) = (std::sync::mpsc::channel(), std::sync::mpsc::channel::<()>());
        let busy = {
            let vm = vm.clone();
            thread::spawn(move || {
                let guard = crate::runtime::OPERATIONS.vm(&vm, "vm", "Long local work").unwrap();
                held.0.send(()).unwrap();
                release.1.recv().unwrap();
                drop(guard);
            })
        };
        held.1.recv().unwrap();
        let queued = {
            let (dir, request, vm) = (dir.clone(), request(&config, "runtime.upsert"), vm.clone());
            thread::spawn(move || {
                run(&dir, &request, |_, _| {
                    let _turn = crate::runtime::OPERATIONS
                        .vm(&vm, "vm", "Remote change")
                        .map_err(|e| e.to_string())?;
                    panic!("a revoked change must not run")
                })
            })
        };
        let waiting = |vm: &str| {
            crate::runtime::OPERATIONS
                .snapshot()
                .waiting
                .iter()
                .any(|entry| entry.vm_id.as_deref() == Some(vm))
        };
        let until = Instant::now() + Duration::from_secs(5);
        while !waiting(&vm) {
            assert!(Instant::now() < until, "the change never queued");
            thread::sleep(Duration::from_millis(5));
        }
        let mut disabled = config.clone();
        disabled.enabled = false;
        save_config_in(&dir, &disabled).unwrap();
        assert_eq!(queued.join().unwrap(), Err(operations::EXPIRED.into()));
        assert!(!waiting(&vm));
        release.0.send(()).unwrap();
        busy.join().unwrap();
    }

    #[test]
    fn the_owner_sees_the_connection_close_when_the_controller_leaves() {
        let (owner_side, bridge_side) = UnixStream::pair().unwrap();
        let (mut controller, bridge_input) = UnixStream::pair().unwrap();
        watch_controller(bridge_input, bridge_side);
        assert!(connection_open(&owner_side));
        controller.write_all(b"ignored").unwrap();
        thread::sleep(Duration::from_millis(50));
        assert!(connection_open(&owner_side));
        drop(controller);
        let until = Instant::now() + Duration::from_secs(5);
        while connection_open(&owner_side) {
            assert!(Instant::now() < until, "the owner never saw the controller leave");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_lost_change_is_sent_again_with_the_same_identity() {
        let mut request = json!({"method":"runtime.action","operationId":"fixed"});
        let deadline = || Instant::now() + Duration::from_secs(60);
        let mut sent = Vec::new();
        let result = send_change(&mut request, deadline(), &[Duration::ZERO; 2], |request| {
            sent.push((request["operationId"].clone(), request["startWithinMs"].as_u64().unwrap()));
            if sent.len() < 3 {
                Err(Failure::Lost("dropped".into()))
            } else {
                Ok(json!("done"))
            }
        });
        assert_eq!(result, Ok(json!("done")));
        assert_eq!(sent.len(), 3);
        for (id, within) in sent {
            assert_eq!(id, json!("fixed"));
            assert!((25_000..=30_000).contains(&within), "{within}");
        }
        // Retries are bounded, and other failures are final at once.
        let mut attempts = 0;
        let lost = send_change(&mut request, deadline(), &[Duration::ZERO], |_| {
            attempts += 1;
            Err(Failure::Lost("dropped".into()))
        });
        assert_eq!((lost, attempts), (Err("dropped".into()), 2));
        for failure in [Failure::Reported("no".into()), Failure::Failed("no".into())] {
            let mut failure = Some(failure);
            let result = send_change(&mut request, deadline(), &[Duration::ZERO], |_| {
                Err(failure.take().expect("sent once"))
            });
            assert_eq!(result, Err("no".into()));
        }
        assert!(lost_connection(Some(255), "Connection closed by 10.0.0.2 port 22\n"));
        assert!(lost_connection(Some(255), "Timeout, server office not responding.\n"));
        assert!(!lost_connection(Some(255), "Host key verification failed.\n"));
        assert!(!lost_connection(Some(255), "user@office: Permission denied (publickey).\n"));
        assert!(!lost_connection(Some(1), "Silo is not running on this computer.\n"));
    }

    #[test]
    fn owner_directory_lock_and_socket_are_private_to_this_account() {
        let home = tempfile::tempdir().unwrap();
        let dir = directory_in(home.path()).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&home.path().join(".silo")) & 0o022, 0);
        assert_eq!(mode(&dir), 0o700);
        let lease = lease_control(&dir).unwrap();
        assert_eq!(mode(&dir.join("control.lock")), 0o600);
        assert!(lease_control(&dir).unwrap_err().contains("Another Silo instance"));
        let listener = bind_control_socket(&dir).unwrap();
        assert_eq!(mode(&dir.join("control.sock")), 0o600);
        assert!(bind_control_socket(&dir).unwrap_err().contains("Another Silo instance"));
        drop(listener);
        // A socket left by a stopped owner is replaced, not treated as a live owner.
        drop(bind_control_socket(&dir).unwrap());
        drop(lease);
        drop(lease_control(&dir).unwrap());
    }
}

#[cfg(test)]
mod ssh_authorization_tests {
    use super::*;
    #[test]
    fn ssh_settings_require_management_protocol_and_pinned_owner() {
        let mut config = Config { host_id: uuid::Uuid::new_v4().to_string(), enabled: true, hosts: vec![] };
        for method in ["ssh.access.state", "ssh.access.save", "ssh.access.connection"] {
            let request = json!({"version":VERSION,"hostId":config.host_id,"method":method});
            validate_authorization(&config, &request).unwrap();
            config.enabled = false;
            assert!(validate_authorization(&config, &request).is_err());
            config.enabled = true;
            let mut changed = request.clone(); changed["hostId"] = json!(uuid::Uuid::new_v4().to_string());
            assert!(validate_authorization(&config, &changed).is_err());
            changed = request; changed["version"] = json!(VERSION + 1);
            assert!(validate_authorization(&config, &changed).is_err());
        }
    }
}

pub(crate) fn log_identity() -> Result<(String, String), String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    Ok((read_config()?.host_id, name()))
}
