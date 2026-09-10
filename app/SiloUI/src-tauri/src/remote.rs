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
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
const INSTALL_PUBLIC_KEY: &str = r#"umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && key=$(cat) && { grep -qxF -- "$key" ~/.ssh/authorized_keys || printf '\n%s\n' "$key" >> ~/.ssh/authorized_keys; }"#;
const VERSION: u32 = 1;
const LIMIT: usize = 4 * 1024 * 1024;
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static REQUEST_LOCK: Mutex<()> = Mutex::new(());
static REMOTE_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
    pub address: String,
}
#[derive(Serialize, Deserialize)]
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
}
fn directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Home directory is unavailable.")?;
    let dir = PathBuf::from(home).join(".silo/desktop-remote");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(dir)
}
fn read_config() -> Result<Config, String> {
    let path = directory()?.join("config.json");
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "Remote management settings are damaged.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let config = Config {
                host_id: uuid::Uuid::new_v4().to_string(),
                enabled: false,
                hosts: vec![],
            };
            save_config(&config)?;
            Ok(config)
        }
        Err(e) => Err(e.to_string()),
    }
}
fn save_config(config: &Config) -> Result<(), String> {
    let dir = directory()?;
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(dir.join("config.json"))
        .map_err(|e| e.to_string())?;
    Ok(())
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
    ManagementStatus {
        enabled: config.enabled,
        host_id: config.host_id.clone(),
        address: format!("{}@{}", std::env::var("USER").unwrap_or_default(), name),
        name,
    }
}
#[tauri::command]
pub fn remote_management_status() -> Result<ManagementStatus, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    Ok(status(&read_config()?))
}
#[tauri::command]
pub fn set_remote_management(enabled: bool) -> Result<ManagementStatus, String> {
    let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
    if enabled {
        let path = PathBuf::from(std::env::var_os("HOME").ok_or("Home unavailable.")?)
            .join(".local/bin/silo-remote");
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        if let Ok(existing) = fs::symlink_metadata(&path) {
            if !existing.file_type().is_symlink()
                || fs::read_link(&path)
                    .ok()
                    .and_then(|p| p.file_name().map(|n| n.to_owned()))
                    != executable.file_name().map(|n| n.to_owned())
            {
                return Err("~/.local/bin/silo-remote already exists. Choose a different name for that file before enabling remote management.".into());
            }
        }
        let temp = path.with_file_name(format!(".silo-remote-{}", uuid::Uuid::new_v4()));
        symlink(executable, &temp).map_err(|e| e.to_string())?;
        if let Err(error) = fs::rename(&temp, &path) {
            let _ = fs::remove_file(temp);
            return Err(error.to_string());
        }
    }
    let mut config = read_config()?;
    config.enabled = enabled;
    save_config(&config)?;
    REMOTE_ENABLED.store(enabled, std::sync::atomic::Ordering::Release);
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
pub fn remote_authorize_ssh(app: AppHandle, address: String) -> Result<(), String> {
    let address = address.trim();
    validate_address(address)?;
    let application = crate::applications::selected_terminal(&app)?;
    let command = [
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
    .join(" ");
    crate::applications::open_terminal(&app, &application, &command)
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
fn ssh_for_address(address: &str) -> Result<Command, String> {
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
    let key = directory()?.join("id_ed25519");
    if key.is_file() {
        command.arg("-i").arg(key);
    }
    Ok(command)
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
pub fn remote_setup_ssh_key(app: AppHandle, address: String) -> Result<(), String> {
    let address = address.trim();
    validate_address(address)?;
    let key = directory()?.join("id_ed25519");
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
    if !public.starts_with("ssh-ed25519 ") || public.len() > 1024 {
        return Err("Invalid Silo SSH public key.".into());
    }

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
    let command = format!(
        "printf '%s\n' {} | {}",
        crate::terminal::quote(public.trim()),
        args.iter()
            .map(|arg| crate::terminal::quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let application = crate::applications::selected_terminal(&app)?;
    crate::applications::open_terminal(&app, &application, &command)
}
fn exchange(address: &str, request: Value) -> Result<Value, String> {
    validate_address(address)?;
    let stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut child = ssh_for_address(address)?
        .args([
            "--",
            address,
            "exec ~/.local/bin/silo-remote --remote-bridge",
        ])
        .stdin(Stdio::piped())
        .stdout(stdout.try_clone().map_err(|e| e.to_string())?)
        .stderr(stderr.try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Err(error) = write_frame(
        child.stdin.take().ok_or("SSH input unavailable.")?,
        &request,
    ) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let deadline = Instant::now() + Duration::from_secs(600);
    let exit = loop {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            break exit;
        }
        if Instant::now() > deadline
            || stdout.metadata().map_err(|e| e.to_string())?.len() > LIMIT as u64 + 4
            || stderr.metadata().map_err(|e| e.to_string())?.len() > 65536
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Remote operation timed out. Its outcome is unknown; reconnect and inspect before issuing another change.".into());
        }
        thread::sleep(Duration::from_millis(40));
    };
    if !exit.success() {
        return Err("Cannot connect to Silo over SSH. Verify the address, authorize its host key using SSH, and configure an SSH key or agent. On the other computer, keep Silo running with remote management enabled.".into());
    }
    use std::io::{Seek, SeekFrom};
    let mut stdout = stdout;
    stdout.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let response = read_frame(stdout)?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
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
    exchange(
        &host.address,
        json!({"version":VERSION,"hostId":host.id,"requestId":uuid::Uuid::new_v4().to_string(),"method":method,"params":params}),
    )
}
#[tauri::command]
pub async fn connect_remote_host(address: String) -> Result<RemoteHost, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let address = address.trim().to_owned();
        let result = exchange(
            &address,
            json!({
                "version": VERSION, "requestId": uuid::Uuid::new_v4().to_string(),
                "method": "handshake", "params": {}
            }),
        )?;
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
        let mut config = read_config()?;
        if config.host_id == host.id {
            return Err(
                "This address points to this computer. Its VMs are already available locally."
                    .into(),
            );
        }
        config.hosts.retain(|saved| saved.id != host.id);
        config.hosts.push(host.clone());
        save_config(&config)?;
        Ok(host)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remote_host_snapshot(app: AppHandle, host_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = call_remote(&app, &host_id, "runtime.snapshot", json!({}));
        if result
            .as_ref()
            .is_err_and(|error| error != "SILO_SANDBOX_UPDATE_IN_PROGRESS")
        {
            crate::remote_network::close_host(&host_id);
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
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        call_remote(
            &app,
            &host_id,
            "runtime.action",
            json!({"vmId":vm_id,"action":action}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
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
    tauri::async_runtime::spawn_blocking(move || {
        call_remote(
            &app,
            &host_id,
            "runtime.delete",
            json!({"vmId":vm_id,"expected":expected}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Called before constructing Tauri. A bridge never launches the GUI or runtime.
pub(crate) fn run_bridge() -> Result<(), String> {
    let mut socket = UnixStream::connect(directory()?.join("control.sock"))
        .map_err(|_| "Silo is not running on this computer.".to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_secs(600)))
        .map_err(|e| e.to_string())?;
    let request = read_frame(std::io::stdin().lock())?;
    let streaming = request["method"] == "guest.ssh";
    write_frame(&mut socket, &request)?;
    let response = read_frame(&mut socket)?;
    write_frame(std::io::stdout().lock(), &response)?;
    if streaming && response.get("error").is_none() {
        socket.set_read_timeout(None).map_err(|e| e.to_string())?;
        let mut input = socket.try_clone().map_err(|e| e.to_string())?;
        thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
            let _ = input.shutdown(std::net::Shutdown::Write);
        });
        std::io::copy(&mut socket, &mut std::io::stdout().lock()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub(crate) fn run_remote_stream(host_id: &str, method: &str, params: Value) -> Result<(), String> {
    let host = read_config()?
        .hosts
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or("Saved computer not found.")?;
    validate_address(&host.address)?;
    let mut child = ssh_for_address(&host.address)?
        .args([
            "--",
            &host.address,
            "exec ~/.local/bin/silo-remote --remote-bridge",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut input = child.stdin.take().ok_or("SSH input unavailable.")?;
        let mut output = child.stdout.take().ok_or("SSH output unavailable.")?;
        write_frame(
            &mut input,
            &json!({"version":VERSION,"hostId":host.id,"requestId":uuid::Uuid::new_v4().to_string(),"method":method,"params":params}),
        )?;
        let reply = read_frame(&mut output)?;
        if let Some(error) = reply["error"].as_str() {
            return Err(error.to_owned());
        }
        thread::spawn(move || {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut input);
        });
        std::io::copy(&mut output, &mut std::io::stdout().lock()).map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}
pub(crate) fn start(app: AppHandle) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let lease = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory()?.join("control.lock"))
        .map_err(|e| e.to_string())?;
    if unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Another Silo instance owns remote management.".into());
    }
    let path = directory()?.join("control.sock");
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
    if read_config()?.enabled {
        set_remote_management(true)?;
    }
    let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    thread::spawn(move || {
        let _lease = lease;
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let Some(permit) = ConnectionPermit::acquire() else {
                let _ = write_frame(
                    &mut stream,
                    &json!({"error":"This computer has too many active Silo connections. Close an unused connection and retry."}),
                );
                continue;
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
                    dispatch(&app, request).map(Some)
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
        }
    });
    Ok(())
}
fn authorize(request: &Value) -> Result<Config, String> {
    let config = {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "Settings unavailable.")?;
        read_config()?
    };
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
    Ok(config)
}

fn dispatch(app: &AppHandle, request: Value) -> Result<Value, String> {
    let config = authorize(&request)?;
    let method = request["method"].as_str().ok_or("Missing remote method.")?;
    if method == "handshake" {
        return Ok(json!({"hostId":config.host_id,"name":name(),"version":VERSION}));
    }
    if request["hostId"].as_str() != Some(&config.host_id) {
        return Err(
            "This address now belongs to a different Silo computer. Reconnect it explicitly."
                .into(),
        );
    }
    let id = request["requestId"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("Invalid remote request identity.")?;
    let execute = || {
        if method.starts_with("runtime.") {
            crate::runtime::remote_ops::dispatch(app, method, request["params"].clone())
        } else {
            crate::remote_access::dispatch(app, method, &request["params"])
        }
    };
    if !matches!(
        method,
        "runtime.action" | "runtime.upsert" | "runtime.delete"
    ) {
        return execute();
    }
    // Record acceptance before touching a VM. Lost replies and restarts never replay a change.
    let _guard = REQUEST_LOCK
        .lock()
        .map_err(|_| "Remote operation state unavailable.")?;
    // A queued request must recheck access after the preceding operation finishes.
    authorize(&request)?;
    let operations = directory()?.join("operations");
    fs::create_dir_all(&operations).map_err(|e| e.to_string())?;
    recorded_operation(&operations, id, &request, execute)
}
#[cfg(test)]
mod tests {
    use super::*;
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

fn save_operation(
    directory: &std::path::Path,
    path: &std::path::Path,
    record: &Value,
) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, record).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    std::fs::File::open(directory)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

fn recorded_operation(
    operations: &std::path::Path,
    id: &str,
    request: &Value,
    execute: impl FnOnce() -> Result<Value, String>,
) -> Result<Value, String> {
    let operation = operations.join(format!("{id}.json"));
    if operation.exists() {
        let record: Value =
            serde_json::from_slice(&fs::read(&operation).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if record["request"] != *request {
            return Err("Remote request identity was reused for a different operation.".into());
        }
        return match record.get("result") {
            Some(result) => serde_json::from_value(result.clone()).map_err(|e|e.to_string())?,
            None => Err("This operation was already accepted. Its result is uncertain; refresh the VM state before making another change.".into()),
        };
    }
    save_operation(operations, &operation, &json!({"request":request}))?;
    let result = execute();
    save_operation(
        &operations,
        &operation,
        &json!({"request":request,"result":result}),
    )?;
    result
}

#[cfg(test)]
mod operation_tests {
    use super::*;
    #[test]
    fn completed_and_interrupted_requests_never_repeat_side_effects() {
        let dir = tempfile::tempdir().unwrap();
        let request = json!({"method":"runtime.upsert"});
        let result = recorded_operation(dir.path(), "completed", &request, || {
            Ok(json!({"created":true}))
        })
        .unwrap();
        assert_eq!(
            recorded_operation(dir.path(), "completed", &request, || panic!(
                "must not replay"
            ))
            .unwrap(),
            result
        );
        save_operation(
            dir.path(),
            &dir.path().join("interrupted.json"),
            &json!({"request":request}),
        )
        .unwrap();
        assert!(
            recorded_operation(dir.path(), "interrupted", &request, || panic!(
                "must not replay"
            ))
            .unwrap_err()
            .contains("already accepted")
        );
        assert!(recorded_operation(
            dir.path(),
            "completed",
            &json!({"method":"runtime.delete"}),
            || panic!("must not replay")
        )
        .is_err());
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
    #[test]
    fn public_key_install_preserves_existing_unterminated_line_and_is_idempotent() {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        let authorized = ssh.join("authorized_keys");
        fs::write(&authorized, b"existing-key-without-final-newline").unwrap();
        let public = "ssh-ed25519 AAAA public-comment-$(never-execute)";
        for _ in 0..2 {
            let mut child = Command::new("/bin/sh")
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
            assert!(child.wait().unwrap().success());
        }
        assert_eq!(
            fs::read_to_string(authorized).unwrap(),
            format!("existing-key-without-final-newline\n{public}\n")
        );
    }
}
