//! Opt-in SSH listeners with isolated client keys and pipe-owned runtime children.
use crate::{
    editor,
    runtime::{self, ProcessRunner, RuntimePaths},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader},
    net::Ipv4Addr,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const FAILED: &str = "Could not read SSH access settings.";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    workspace: String,
    machine_id: String,
    enabled: bool,
    port: u16,
    bind_address: String,
    keys: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workspace {
    workspace: String,
    vm_id: String,
    enabled: bool,
    port: u16,
    bind_address: String,
    keys: Vec<String>,
    state: &'static str,
    message: Option<String>,
    fingerprint: Option<String>,
    computer_name: String,
    addresses: Vec<String>,
}
#[derive(Serialize)]
pub(crate) struct State {
    workspaces: Vec<Workspace>,
}
struct Listener {
    children: Vec<Child>,
    config: Configuration,
}
impl Drop for Listener {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[derive(Default)]
struct Owners {
    listeners: BTreeMap<String, Listener>,
    errors: BTreeMap<String, String>,
}
fn owners() -> &'static Mutex<Owners> {
    static OWNERS: OnceLock<Mutex<Owners>> = OnceLock::new();
    OWNERS.get_or_init(Default::default)
}
fn path(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("ssh-access.json")
}
fn read(paths: &RuntimePaths) -> Result<Vec<Configuration>, String> {
    let bytes = editor::read_regular(&path(paths))?;
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    let configs: Vec<Configuration> = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
    if configs.len() > 4096 {
        return Err(FAILED.into());
    }
    let mut seen = BTreeSet::new();
    for config in &configs {
        validate(config)?;
        if !seen.insert(&config.workspace) {
            return Err(FAILED.into());
        }
    }
    Ok(configs)
}
fn validate(config: &Configuration) -> Result<(), String> {
    runtime::validate_name(&config.workspace).map_err(|e| e.to_string())?;
    uuid::Uuid::parse_str(&config.machine_id).map_err(|_| "Invalid sandbox identity.")?;
    if config.port == 0 {
        return Err("Enter a port from 1 to 65535.".into());
    }
    let ip: Ipv4Addr = config
        .bind_address
        .parse()
        .map_err(|_| "Choose an IPv4 address assigned to the computer.")?;
    if ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || (ip.is_loopback() && ip != Ipv4Addr::LOCALHOST)
    {
        return Err("Choose 127.0.0.1 or a specific network interface address. Wildcard bindings are not allowed.".into());
    }
    if config.keys.len() > 128 {
        return Err("Use at most 128 authorized keys.".into());
    }
    let mut seen = BTreeSet::new();
    for key in &config.keys {
        let normalized = normalize_key(key)?;
        if !seen.insert(normalized) {
            return Err("This public key is already authorized.".into());
        }
    }
    Ok(())
}
fn normalize_key(key: &str) -> Result<String, String> {
    if key.len() > 4096 || key.contains(['\n', '\r', '\0']) {
        return Err("Paste one Ed25519 public key per entry.".into());
    }
    let mut words = key.split_whitespace();
    let normalized = format!(
        "{} {}",
        words.next().unwrap_or(""),
        words.next().unwrap_or("")
    );
    editor::validate_public_key(&normalized)?;
    Ok(normalized)
}
fn host_name() -> String {
    let mut bytes = [0u8; 256];
    // SAFETY: gethostname writes at most the supplied buffer length.
    if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) } != 0 {
        return "Unnamed computer".into();
    }
    String::from_utf8_lossy(&bytes)
        .trim_end_matches('\0')
        .to_owned()
}
fn addresses() -> Vec<String> {
    let mut list = std::ptr::null_mut();
    let mut result = BTreeSet::new();
    // SAFETY: getifaddrs owns a linked list until freeifaddrs. Check family before casting.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return vec![];
        }
        let mut item = list;
        while !item.is_null() {
            let addr = (*item).ifa_addr;
            if !addr.is_null()
                && (*addr).sa_family as i32 == libc::AF_INET
                && (*item).ifa_flags & libc::IFF_UP as u32 != 0
            {
                let ip = Ipv4Addr::from(
                    (*(addr as *const libc::sockaddr_in))
                        .sin_addr
                        .s_addr
                        .to_ne_bytes(),
                );
                if !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !ip.is_broadcast()
                {
                    result.insert(ip.to_string());
                }
            }
            item = (*item).ifa_next;
        }
        libc::freeifaddrs(list);
    }
    result.into_iter().collect()
}
fn fingerprint(paths: &RuntimePaths, name: &str) -> Result<String, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let root = paths.home.join("sandboxes").join(name).join("ssh");
    let key = root.join("host_ed25519");
    let public = editor::public_key(&key)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public.split_whitespace().nth(1).ok_or(FAILED)?)
        .map_err(|_| FAILED)?;
    Ok(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(bytes))
    ))
}
fn spawn(paths: &RuntimePaths, config: &Configuration) -> Result<Listener, String> {
    let root = paths.home.join("ssh/managed-access");
    editor::private_directory(&paths.home.join("ssh"))?;
    editor::private_directory(&root)?;
    let authorized = root.join(format!("{}.authorized_keys", config.machine_id));
    // Deliberately never read or write the editor's shared authorized_keys or private client key.
    editor::write_private(
        &authorized,
        format!("{}\n", config.keys.join("\n")).as_bytes(),
    )?;
    let host_root = paths
        .home
        .join("sandboxes")
        .join(&config.workspace)
        .join("ssh");
    editor::private_directory(&host_root)?;
    editor::key(&host_root.join("host_ed25519"))?;
    fingerprint(paths, &config.workspace)?;
    let mut listener = Listener {
        children: vec![],
        config: config.clone(),
    };
    let mut hosts = vec!["127.0.0.1"];
    if config.bind_address != "127.0.0.1" {
        hosts.push(&config.bind_address);
    }
    for host in hosts {
        let mut child = Command::new(&paths.executable)
            .args([
                "ssh",
                "serve",
                &config.workspace,
                "--no-start",
                "--no-inactivity-timeout",
                "--exit-on-stdin-close",
                "--authorized-keys",
            ])
            .arg(&authorized)
            .args(["--expected-machine-id", &config.machine_id])
            .args(["--host", host, "--port", &config.port.to_string()])
            .env("MSB_HOME", &paths.home)
            .env("MSB_PATH", &paths.executable)
            .env("MSB_LIBKRUNFW_PATH", &paths.library)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start the SSH listener.")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Could not read SSH listener readiness.")?;
        listener.children.push(child);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line == "SILO_SSH_READY" {
                    let _ = tx.try_send(());
                }
            }
        });
        rx.recv_timeout(Duration::from_secs(8)).map_err(|_| "SSH could not listen. Check whether the port is in use, the network address is available, and the bundled runtime is current.")?;
        if listener
            .children
            .last_mut()
            .unwrap()
            .try_wait()
            .map_err(|_| "Could not check SSH listener.")?
            .is_some()
        {
            return Err("The SSH listener exited.".into());
        }
    }
    Ok(listener)
}
fn inspect_running(paths: &RuntimePaths, config: &Configuration) -> Result<bool, String> {
    let inspected = runtime::inspect_workspace(&ProcessRunner, paths, &config.workspace)
        .map_err(|_| "Could not verify sandbox status. SSH access is closed.")?;
    runtime::ensure_managed(&inspected).map_err(|_| "This sandbox is not managed by Silo.")?;
    if inspected
        .config
        .pointer("/labels/silo.machine-id")
        .and_then(serde_json::Value::as_str)
        != Some(config.machine_id.as_str())
    {
        return Err("The sandbox identity changed. Configure SSH access again.".into());
    }
    let user = crate::working_account::working_user(&inspected.config)?;
    crate::working_account::require_runtime(paths, user)?;
    Ok(inspected.status == "Running")
}
pub(crate) fn reconcile(paths: &RuntimePaths) {
    if paths.metadata.as_os_str().is_empty() {
        return;
    }
    if runtime::shutdown::ensure_accepting_operations().is_err() {
        close_all();
        return;
    }
    let Ok(configs) = read(paths) else {
        close_all();
        return;
    };
    let Ok(metadata) = runtime::read_metadata(&paths.metadata) else {
        close_all();
        return;
    };
    let Ok(mut owned) = owners().lock() else {
        return;
    };
    owned.listeners.retain(|name, _| {
        configs
            .iter()
            .any(|c| &c.workspace == name && c.enabled && !c.keys.is_empty())
    });
    owned.errors.clear();
    for config in configs.iter().filter(|c| c.enabled) {
        let observed = if metadata
            .machines
            .iter()
            .any(|m| m.is_vm() && m.name() == config.workspace && m.id() == config.machine_id)
        {
            inspect_running(paths, config)
        } else {
            Err("The sandbox identity changed. Configure SSH access again.".into())
        };
        reconcile_one(&mut owned, config, observed, &addresses(), || {
            spawn(paths, config)
        });
    }
}
fn reconcile_one(
    owned: &mut Owners,
    config: &Configuration,
    observed: Result<bool, String>,
    addresses: &[String],
    launch: impl FnOnce() -> Result<Listener, String>,
) {
    let result = (|| {
        if !config.enabled || !observed? {
            owned.listeners.remove(&config.workspace);
            return Ok(());
        }
        if config.keys.is_empty() {
            return Err("Add an authorized public key to open SSH access.".into());
        }
        if config.bind_address != "127.0.0.1" && !addresses.contains(&config.bind_address) {
            return Err(
                "The selected network address is unavailable. Choose an active interface.".into(),
            );
        }
        if let Some(listener) = owned.listeners.get_mut(&config.workspace) {
            if listener.config == *config
                && listener
                    .children
                    .iter_mut()
                    .all(|c| matches!(c.try_wait(), Ok(None)))
            {
                return Ok(());
            }
        }
        owned.listeners.remove(&config.workspace);
        runtime::shutdown::ensure_accepting_operations()?;
        owned.listeners.insert(config.workspace.clone(), launch()?);
        Ok(())
    })();
    if let Err(error) = result {
        owned.listeners.remove(&config.workspace);
        owned.errors.insert(config.workspace.clone(), error);
    } else {
        owned.errors.remove(&config.workspace);
    }
}

pub(crate) fn close_workspace(name: &str) {
    if let Ok(mut owned) = owners().lock() {
        owned.listeners.remove(name);
        owned.errors.remove(name);
    }
}
pub(crate) fn close_all() {
    if let Ok(mut owned) = owners().lock() {
        owned.listeners.clear();
        owned.errors.clear();
    }
}
pub(crate) fn start_monitor(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        if let Ok(_guard) = runtime::MUTATION_LOCK.try_lock() {
            if runtime::shutdown::ensure_accepting_operations().is_ok() {
                if let Ok(paths) = runtime::runtime_paths(&app) {
                    reconcile(&paths);
                }
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    });
}
fn state(paths: &RuntimePaths) -> Result<State, String> {
    let configs = read(paths)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|_| FAILED)?;
    let owned = owners().lock().map_err(|_| FAILED)?;
    let computer_name = host_name();
    let addresses = addresses();
    Ok(State {
        workspaces: metadata
            .machines
            .iter()
            .filter(|m| m.is_vm())
            .map(|machine| {
                let config = configs
                    .iter()
                    .find(|c| c.workspace == machine.name() && c.machine_id == machine.id());
                let enabled = config.is_some_and(|c| c.enabled);
                let message = owned.errors.get(machine.name()).cloned();
                let status = if !enabled {
                    "disabled"
                } else if message.is_some() {
                    "error"
                } else if owned.listeners.contains_key(machine.name()) {
                    "listening"
                } else {
                    "waiting"
                };
                Workspace {
                    workspace: machine.name().into(),
                    vm_id: machine.id().into(),
                    enabled,
                    port: config.map_or(2222, |c| c.port),
                    bind_address: config
                        .map_or("127.0.0.1", |c| c.bind_address.as_str())
                        .into(),
                    keys: config.map_or_else(Vec::new, |c| c.keys.clone()),
                    state: status,
                    message,
                    fingerprint: if enabled {
                        fingerprint(paths, machine.name()).ok()
                    } else {
                        None
                    },
                    computer_name: computer_name.clone(),
                    addresses: addresses.clone(),
                }
            })
            .collect(),
    })
}
#[tauri::command]
pub(crate) async fn read_ssh_access_state(app: AppHandle) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = runtime::MUTATION_LOCK.lock().map_err(|_| FAILED)?;
        let paths = runtime::runtime_paths(&app)?;
        reconcile(&paths);
        state(&paths)
    })
    .await
    .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub(crate) async fn save_ssh_access(
    app: AppHandle,
    workspace: String,
    enabled: bool,
    port: u16,
    bind_address: String,
    keys: Vec<String>,
) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = crate::updates::operation_guard()?;
        let _guard = runtime::MUTATION_LOCK.lock().map_err(|_| FAILED)?;
        runtime::shutdown::ensure_accepting_operations()?;
        let paths = runtime::runtime_paths(&app)?;
        let result = save_with(
            &paths,
            Target::Name(&workspace),
            Settings {
                enabled,
                port,
                bind_address,
                keys,
            },
        );
        let _ = app.emit("silo://network-state-changed", ());
        result
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub(crate) enabled: bool,
    pub(crate) port: u16,
    pub(crate) bind_address: String,
    pub(crate) keys: Vec<String>,
}
enum Target<'a> {
    Name(&'a str),
    Id(&'a str),
}
fn client_key(paths: &RuntimePaths, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid sandbox identity.")?;
    let root = paths.home.join("ssh/managed-clients");
    editor::private_directory(&root)?;
    let path = root.join(id);
    editor::key(&path)?;
    Ok(path)
}

// Only an explicit connection/export request reads private material. Ordinary
// state responses and persisted settings contain public keys only.
pub(crate) fn connection_material(paths: &RuntimePaths, vm_id: &str) -> Result<serde_json::Value, String> {
    connection_material_for_client(paths, vm_id, None)
}

fn connection_material_for_client(paths: &RuntimePaths, vm_id: &str, request: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
    uuid::Uuid::parse_str(vm_id).map_err(|_| "Invalid sandbox identity.")?;
    let config = read(paths)?.into_iter().find(|c| c.machine_id == vm_id && c.enabled)
        .ok_or("Enable SSH access first.")?;
    let user = crate::working_account::inspect_user(paths, &config.workspace)?;
    if let Some(request) = request { crate::working_account::require_client_protocol(user, request)?; }
    save_with(paths, Target::Id(vm_id), Settings { enabled: true, port: config.port,
        bind_address: config.bind_address.clone(), keys: config.keys })?;
    let key = client_key(paths, vm_id)?;
    let private = std::fs::read_to_string(key).map_err(|_| "Could not read the connection key.")?;
    Ok(serde_json::json!({"privateKey":private,"port":config.port,"address":config.bind_address,"user":user}))
}

fn save_with(
    paths: &RuntimePaths,
    target: Target<'_>,
    settings: Settings,
) -> Result<State, String> {
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|_| FAILED)?;
    let machine = metadata
        .machines
        .iter()
        .find(|m| {
            m.is_vm()
                && match target {
                    Target::Name(name) => m.name() == name,
                    Target::Id(id) => m.id() == id,
                }
        })
        .ok_or("This sandbox no longer exists on its computer. Refresh SSH access.")?;
    let workspace = machine.name().to_owned();
    let Settings {
        enabled,
        port,
        bind_address,
        mut keys,
    } = settings;
    if enabled {
        let public = editor::public_key(&client_key(paths, machine.id())?)?;
        if !keys.iter().any(|key| normalize_key(key).ok().as_deref() == Some(public.trim())) {
            keys.push(public.trim().to_owned());
        }
    }
    let mut config = Configuration {
        workspace: workspace.clone(),
        machine_id: machine.id().into(),
        enabled,
        port,
        bind_address,
        keys,
    };
    validate(&config)?;
    if enabled && config.bind_address != "127.0.0.1" && !addresses().contains(&config.bind_address)
    {
        return Err("Choose an active network interface address.".into());
    }
    let mut configs = read(&paths)?;
    // Deleted or replaced identities must not reserve a port forever.
    configs.retain(|c| {
        metadata
            .machines
            .iter()
            .any(|m| m.is_vm() && m.name() == c.workspace && m.id() == c.machine_id)
    });
    if enabled && port == 2222 && !configs.iter().any(|c| c.machine_id == machine.id()) {
        config.port = (2222..=65535).find(|candidate| {
            !configs.iter().any(|c| c.enabled && c.port == *candidate)
                && std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, *candidate)).is_ok()
        }).ok_or("No SSH port is available.")?;
    }
    if enabled
        && configs
            .iter()
            .any(|c| c.enabled && c.workspace != workspace && c.port == config.port)
    {
        return Err("Another sandbox already uses this SSH port. Choose a different port.".into());
    }
    if configs.iter().any(|c| c == &config) {
        reconcile(paths);
        return state(paths);
    }
    configs.retain(|c| c.workspace != workspace);
    configs.push(config);
    let bytes = serde_json::to_vec(&configs).map_err(|_| FAILED)?;
    if bytes.len() > 1024 * 1024 || configs.len() > 4096 {
        return Err("SSH settings are too large. Remove unused client keys first.".into());
    }
    // Revoke live sessions before committing changed authorization.
    close_workspace(&workspace);
    editor::write_private(&path(&paths), &bytes)?;
    reconcile(&paths);
    state(&paths)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteSave {
    vm_id: String,
    settings: Settings,
}

// Executed by the owning Silo app, never by its short-lived SSH bridge.
pub(crate) fn remote_dispatch(
    app: &AppHandle,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _operation = crate::updates::operation_guard()?;
    let _guard = runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "A sandbox operation is in progress. Retry shortly.")?;
    crate::remote::ensure_management_enabled()?;
    runtime::shutdown::ensure_accepting_operations()?;
    let paths = runtime::runtime_paths(app)?;
    let result = remote_with(&paths, method, params);
    if method == "ssh.access.save" {
        let _ = app.emit("silo://network-state-changed", ());
    }
    result
}
fn remote_with(
    paths: &RuntimePaths,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    if method == "ssh.access.connection" {
        let id = params["vmId"].as_str().ok_or("Missing sandbox identity.")?;
        return connection_material_for_client(paths, id, Some(params));
    }
    let result = match method {
        "ssh.access.state" => {
            reconcile(paths);
            state(paths)?
        }
        "ssh.access.save" => {
            let request: RemoteSave = serde_json::from_value(params.clone())
                .map_err(|_| "Invalid remote SSH settings.")?;
            uuid::Uuid::parse_str(&request.vm_id).map_err(|_| "Invalid sandbox identity.")?;
            save_with(paths, Target::Id(&request.vm_id), request.settings)?
        }
        _ => return Err("Unsupported remote SSH operation.".into()),
    };
    serde_json::to_value(result).map_err(|_| FAILED.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        os::unix::fs::PermissionsExt,
        time::Instant,
    };
    fn config() -> Configuration {
        use base64::Engine;
        let mut bytes = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
        bytes.extend_from_slice(&[1; 32]);
        Configuration {
            workspace: "dev".into(),
            machine_id: "00000000-0000-4000-8000-000000000001".into(),
            enabled: true,
            port: 2222,
            bind_address: "127.0.0.1".into(),
            keys: vec![format!(
                "ssh-ed25519 {} test laptop",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )],
        }
    }
    fn paths(dir: &tempfile::TempDir) -> RuntimePaths {
        RuntimePaths {
            guest_image: dir.path().join("image"),
            executable: dir.path().join("msb"),
            home: dir.path().join("home"),
            storage_home: None,
            library: dir.path().join("lib"),
            metadata: dir.path().join("machines.json"),
            volumes: dir.path().join("volumes"),
        }
    }
    #[test]
    fn rejects_wildcards_invalid_ports_keys_and_duplicate_key_comments() {
        let mut c = config();
        validate(&c).unwrap();
        for ip in [
            "0.0.0.0",
            "::",
            "localhost",
            "224.0.0.1",
            "255.255.255.255",
            "127.0.0.2",
            "1.2.3.999",
        ] {
            c.bind_address = ip.into();
            assert!(validate(&c).is_err(), "{ip}");
        }
        c.bind_address = "192.168.1.20".into();
        validate(&c).unwrap();
        c.port = 0;
        assert!(validate(&c).is_err());
        c.port = 65535;
        c.keys
            .push(c.keys[0].replace("test laptop", "different comment"));
        assert!(validate(&c).is_err());
        for key in [
            "command=\"sh\" ssh-ed25519 AAAA",
            "ssh-ed25519 AAAA",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "ssh-ed25519 AAAA\nssh-ed25519 AAAA",
        ] {
            c.keys = vec![key.into()];
            assert!(validate(&c).is_err());
        }
    }
    #[test]
    fn persists_identity_and_disabled_settings_without_touching_internal_keys() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        fs::create_dir_all(p.home.join("ssh")).unwrap();
        let internal = p.home.join("ssh/authorized_keys");
        fs::write(&internal, "Silo internal sentinel\n").unwrap();
        let mut c = config();
        c.enabled = false;
        editor::write_private(&path(&p), &serde_json::to_vec(&vec![c.clone()]).unwrap()).unwrap();
        assert_eq!(read(&p).unwrap(), vec![c]);
        assert_eq!(
            fs::read_to_string(internal).unwrap(),
            "Silo internal sentinel\n"
        );
        assert_eq!(
            fs::metadata(path(&p)).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::write(path(&p), "{broken").unwrap();
        assert!(read(&p).is_err());
    }
    #[test]
    fn refuses_symlinked_settings() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        let target = dir.path().join("target");
        fs::write(&target, "[]").unwrap();
        std::os::unix::fs::symlink(&target, path(&p)).unwrap();
        assert!(read(&p).is_err());
        assert!(editor::write_private(&path(&p), b"[]").is_err());
    }
    // A deterministic runtime substitute validates actual TCP ownership, stream
    // cleanup and command arguments. It never starts or accesses a real VM.
    fn fake_runtime(p: &RuntimePaths) {
        fs::write(
            &p.executable,
            r#"#!/usr/bin/python3
import socket, sys, threading
args = sys.argv[1:]
if args == ['--silo-working-account-protocol']:
    print('1')
    sys.exit(0)
assert args[:3] == ['ssh', 'serve', 'dev']
for flag in ['--no-start', '--no-inactivity-timeout', '--exit-on-stdin-close', '--authorized-keys', '--expected-machine-id']:
    assert flag in args
assert args[args.index('--expected-machine-id')+1] == '00000000-0000-4000-8000-000000000001'
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((args[args.index('--host')+1], int(args[args.index('--port')+1])))
s.listen()
print('SILO_SSH_READY', flush=True)
def echo():
    while True:
        conn, _ = s.accept()
        def session(c):
            with c:
                while True:
                    b = c.recv(100)
                    if not b: return
                    c.sendall(b)
        threading.Thread(target=session, args=(conn,), daemon=True).start()
threading.Thread(target=echo, daemon=True).start()
sys.stdin.buffer.read()
"#,
        )
        .unwrap();
        fs::set_permissions(&p.executable, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn unused_port() -> u16 {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
    #[test]
    fn listener_drop_closes_socket_and_sessions_and_preserves_internal_authorization() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        fake_runtime(&p);
        fs::create_dir_all(p.home.join("ssh")).unwrap();
        fs::write(p.home.join("ssh/authorized_keys"), "internal sentinel").unwrap();
        let mut c = config();
        c.port = unused_port();
        let listener = spawn(&p, &c).unwrap();
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(b"alive").unwrap();
        let mut bytes = [0; 5];
        stream.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"alive");
        drop(listener);
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).is_err());
        assert!(stream.read(&mut bytes).map_or(true, |n| n == 0));
        assert_eq!(
            fs::read_to_string(p.home.join("ssh/authorized_keys")).unwrap(),
            "internal sentinel"
        );
        assert_eq!(
            fs::read_to_string(p.home.join(format!(
                "ssh/managed-access/{}.authorized_keys",
                c.machine_id
            )))
            .unwrap(),
            format!("{}\n", c.keys.join("\n"))
        );
    }
    #[test]
    fn closing_owner_pipe_exits_child_without_drop_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        fake_runtime(&p);
        let mut c = config();
        c.port = unused_port();
        let mut listener = spawn(&p, &c).unwrap();
        drop(listener.children[0].stdin.take());
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            if listener.children[0].try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < until, "child survived owner pipe EOF");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).is_err());
    }
    #[test]
    fn occupied_port_never_reports_an_unrelated_listener_as_ready() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        fake_runtime(&p);
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut c = config();
        c.port = occupied.local_addr().unwrap().port();
        assert!(spawn(&p, &c).is_err());
        assert!(TcpStream::connect(occupied.local_addr().unwrap()).is_ok());
    }
    #[test]
    fn reconciliation_never_launches_stopped_disabled_unverified_or_keyless_sandboxes() {
        let mut owned = Owners::default();
        let mut c = config();
        for observed in [Ok(false), Err("status unavailable".into())] {
            reconcile_one(&mut owned, &c, observed, &[], || panic!("must not start"));
            assert!(owned.listeners.is_empty());
        }
        c.enabled = false;
        reconcile_one(&mut owned, &c, Ok(true), &[], || panic!("disabled"));
        c.enabled = true;
        c.keys.clear();
        reconcile_one(&mut owned, &c, Ok(true), &[], || {
            panic!("no authorized keys")
        });
        assert!(owned.errors["dev"].contains("public key"));
        c = config();
        c.bind_address = "192.168.50.2".into();
        reconcile_one(&mut owned, &c, Ok(true), &[], || {
            panic!("missing interface")
        });
        assert!(owned.errors["dev"].contains("unavailable"));
    }
    #[test]
    fn reconciliation_reuses_live_listener_restarts_on_keys_and_revokes_on_stop() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        fake_runtime(&p);
        let mut c = config();
        c.port = unused_port();
        let mut owned = Owners::default();
        reconcile_one(&mut owned, &c, Ok(true), &[], || spawn(&p, &c));
        let initial = owned.listeners["dev"].children[0].id();
        reconcile_one(&mut owned, &c, Ok(true), &[], || {
            panic!("unchanged listener")
        });
        assert_eq!(owned.listeners["dev"].children[0].id(), initial);
        let mut session = TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).unwrap();
        session
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        use base64::Engine;
        let mut key_bytes = base64::engine::general_purpose::STANDARD
            .decode(c.keys[0].split_whitespace().nth(1).unwrap())
            .unwrap();
        *key_bytes.last_mut().unwrap() = 2;
        c.keys[0] = format!(
            "ssh-ed25519 {} replacement client",
            base64::engine::general_purpose::STANDARD.encode(key_bytes)
        );
        reconcile_one(&mut owned, &c, Ok(true), &[], || spawn(&p, &c));
        assert!(owned.errors.is_empty(), "{:?}", owned.errors);
        assert_ne!(owned.listeners["dev"].children[0].id(), initial);
        assert!(session.read(&mut [0]).map_or(true, |n| n == 0));
        reconcile_one(&mut owned, &c, Ok(false), &[], || panic!("stopped"));
        assert!(owned.listeners.is_empty());
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).is_err());
    }
    #[test]
    fn network_listener_failure_rolls_back_the_ready_loopback_listener() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        fake_runtime(&p);
        let script = fs::read_to_string(&p.executable).unwrap().replace(
            "s = socket.socket()",
            "if args[args.index('--host')+1] != '127.0.0.1': sys.exit(1)\ns = socket.socket()",
        );
        fs::write(&p.executable, script).unwrap();
        let mut c = config();
        c.port = unused_port();
        c.bind_address = "192.0.2.1".into();
        assert!(spawn(&p, &c).is_err());
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).is_err());
    }
    fn remote_fixture(p: &RuntimePaths) {
        fake_runtime(p);
        fs::create_dir_all(&p.home).unwrap();
        let script = fs::read_to_string(&p.executable).unwrap().replace(
            "args = sys.argv[1:]",
            "args = sys.argv[1:]\nif args[0] == 'inspect':\n    import json, os, pathlib\n    running = (pathlib.Path(os.environ['MSB_HOME'])/'running').exists()\n    print(json.dumps({'name':'dev','status':'Running' if running else 'Stopped','config':{'labels':{'silo.managed':'true','silo.working-account':'1','silo.machine-id':'00000000-0000-4000-8000-000000000001'}}}))\n    sys.exit(0)",
        );
        fs::write(&p.executable, script).unwrap();
        fs::write(&p.library, "fixture").unwrap();
        fs::write(
            &p.metadata,
            serde_json::json!({"schemaVersion":1,"machines":[{
                "kind":"vm","id":config().machine_id,"name":"dev","cpus":2,"maxCPUs":2,
                "memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10
            }]})
            .to_string(),
        )
        .unwrap();
    }
    fn remote_request(c: &Configuration) -> serde_json::Value {
        serde_json::json!({"vmId":c.machine_id,"settings":{
            "enabled":c.enabled,"port":c.port,"bindAddress":c.bind_address,"keys":c.keys
        }})
    }
    #[test]
    fn working_account_outdated_runtime_closes_listener_before_reuse_or_binding() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        remote_fixture(&p);
        fs::write(p.home.join("running"), "running").unwrap();
        let script = fs::read_to_string(&p.executable).unwrap()
            .replace("'silo.managed':'true'", "'silo.managed':'true','silo.working-account':'1'")
            .replace("print('1')", "print('0')");
        fs::write(&p.executable, script).unwrap();
        let c = config();
        let mut owned = Owners::default();
        owned.listeners.insert(c.workspace.clone(), Listener { children: vec![], config: c.clone() });
        for _ in 0..2 {
            let observed = inspect_running(&p, &c);
            assert!(observed.as_ref().unwrap_err().contains("Repair or update Silo"));
            reconcile_one(&mut owned, &c, observed, &["127.0.0.1".into()], || panic!("unsafe runtime must not bind a listener"));
            assert!(!owned.listeners.contains_key(&c.workspace));
            assert!(owned.errors[&c.workspace].contains("Repair or update Silo"));
        }
    }

    #[test]
    fn working_account_remote_export_requires_protocol_before_creating_client_key() {
        let _guard = runtime::MUTATION_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        remote_fixture(&p);
        let script = fs::read_to_string(&p.executable).unwrap().replace(
            "'silo.managed':'true'", "'silo.managed':'true','silo.working-account':'1'",
        );
        fs::write(&p.executable, script).unwrap();
        let c = config();
        editor::write_private(&path(&p), &serde_json::to_vec(&vec![c.clone()]).unwrap()).unwrap();
        let request = serde_json::json!({"vmId":c.machine_id});
        let error = remote_with(&p, "ssh.access.connection", &request).unwrap_err();
        assert!(error.contains("Update Silo on the connecting computer"));
        assert!(!p.home.join("ssh/managed-clients").exists());
        let request = serde_json::json!({"vmId":c.machine_id,"accountProtocol":1});
        let exported = remote_with(&p, "ssh.access.connection", &request).unwrap();
        assert_eq!(exported["user"], "silo");
        assert!(exported["privateKey"].as_str().unwrap().contains("BEGIN OPENSSH PRIVATE KEY"));
    }

    #[test]
    fn automatic_client_key_is_stable_isolated_and_exported_only_on_request() {
        let _guard = runtime::MUTATION_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        remote_fixture(&p);
        let internal = p.home.join("ssh/authorized_keys");
        fs::create_dir_all(internal.parent().unwrap()).unwrap();
        fs::write(&internal, "internal sentinel").unwrap();
        let mut c = config();
        c.keys.clear();
        c.port = unused_port();
        let request = remote_request(&c);
        let first = remote_with(&p, "ssh.access.save", &request).unwrap();
        assert_eq!(first["workspaces"][0]["keys"].as_array().unwrap().len(), 1);
        assert!(!first.to_string().contains("PRIVATE KEY"));
        let key_path = client_key(&p, &c.machine_id).unwrap();
        let first_key = fs::read(&key_path).unwrap();
        assert_eq!(fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);
        let second = remote_with(&p, "ssh.access.save", &request).unwrap();
        assert_eq!(first["workspaces"][0]["keys"], second["workspaces"][0]["keys"]);
        assert_eq!(first_key, fs::read(&key_path).unwrap());
        let exported = remote_with(&p, "ssh.access.connection", &serde_json::json!({"vmId":c.machine_id,"accountProtocol":1})).unwrap();
        assert!(exported["privateKey"].as_str().unwrap().contains("BEGIN OPENSSH PRIVATE KEY"));
        assert_eq!(fs::read_to_string(internal).unwrap(), "internal sentinel");
        assert!(!p.home.join("running").exists());
        c.enabled = false;
        remote_with(&p, "ssh.access.save", &remote_request(&c)).unwrap();
        assert!(connection_material(&p, &c.machine_id).is_err());
        assert!(client_key(&p, "../../escape").is_err());
    }

    #[test]
    fn remote_enable_waits_for_owner_start_and_retries_preserve_sessions_until_remote_disable() {
        let _guard = runtime::MUTATION_LOCK.lock().unwrap();
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                close_workspace("dev");
            }
        }
        let _cleanup = Cleanup;
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        remote_fixture(&p);
        let mut c = config();
        c.port = unused_port();
        let request = remote_request(&c);
        let waiting = remote_with(&p, "ssh.access.save", &request).unwrap();
        assert_eq!(waiting["workspaces"][0]["state"], "waiting");
        assert!(
            !p.home.join("running").exists(),
            "remote toggle must not start a VM"
        );
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).is_err());
        fs::write(p.home.join("running"), "").unwrap();
        let response = remote_with(&p, "ssh.access.state", &serde_json::json!({})).unwrap();
        assert_eq!(response["workspaces"][0]["vmId"], c.machine_id);
        assert_eq!(response["workspaces"][0]["state"], "listening");
        drop(response); // Returning/dropping a controller reply does not own the listener.
        let mut session = TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).unwrap();
        session
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        remote_with(&p, "ssh.access.save", &request).unwrap();
        session.write_all(b"still alive").unwrap();
        let mut bytes = [0; 11];
        session.read_exact(&mut bytes).unwrap();
        assert_eq!(
            &bytes, b"still alive",
            "identical remote save must not restart SSH"
        );
        c.enabled = false;
        let result = remote_with(&p, "ssh.access.save", &remote_request(&c)).unwrap();
        assert_eq!(result["workspaces"][0]["state"], "disabled");
        assert!(session.read(&mut [0]).map_or(true, |n| n == 0));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, c.port)).is_err());
        assert_eq!(read(&p).unwrap()[0].keys, c.keys);
    }
    #[test]
    fn remote_save_rejects_replaced_ids_and_invalid_settings_without_writing() {
        let _guard = runtime::MUTATION_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let p = paths(&dir);
        remote_fixture(&p);
        let request = remote_request(&config());
        let mut replaced = request.clone();
        replaced["vmId"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
        assert!(remote_with(&p, "ssh.access.save", &replaced)
            .unwrap_err()
            .contains("no longer exists"));
        let mut invalid = request.clone();
        invalid["vmId"] = serde_json::json!("dev");
        assert!(remote_with(&p, "ssh.access.save", &invalid).is_err());
        let mut invalid = request.clone();
        invalid["workspace"] = serde_json::json!("dev");
        assert!(remote_with(&p, "ssh.access.save", &invalid).is_err());
        for (field, value) in [
            ("port", serde_json::json!(0)),
            ("bindAddress", serde_json::json!("0.0.0.0")),
            (
                "keys",
                serde_json::json!(["-----BEGIN OPENSSH PRIVATE KEY-----"]),
            ),
        ] {
            let mut invalid = request.clone();
            invalid["settings"][field] = value;
            assert!(remote_with(&p, "ssh.access.save", &invalid).is_err());
        }
        assert!(!path(&p).exists());
    }
}
