//! Local TCP services and loopback-only published ports.
use crate::runtime::{self, ProcessRunner, RuntimePaths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

static NETWORK_LOCK: Mutex<()> = Mutex::new(());
const FAILED: &str = "Could not read network services. Try again.";
const LIMIT: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mapping {
    workspace: String,
    port: u16,
    host_port: Option<u16>,
    scheme: Option<String>,
    enabled: bool,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    mappings: Vec<Mapping>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Port {
    port: u16,
    host_port: Option<u16>,
    scheme: Option<String>,
    state: &'static str,
    configured: bool,
    message: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workspace {
    workspace: String,
    ports: Vec<Port>,
    error: Option<String>,
}
#[derive(Serialize)]
pub(crate) struct State {
    workspaces: Vec<Workspace>,
}
#[derive(Clone, Debug, Deserialize, PartialEq)]
struct Published {
    guest_port: u16,
    host_port: u16,
    host_bind: String,
}

fn validate(mapping: &Mapping) -> Result<(), String> {
    if mapping.port == 0
        || mapping.host_port == Some(0)
        || !matches!(mapping.scheme.as_deref(), None | Some("http" | "https"))
    {
        return Err("Enter a port from 1 to 65535 and a supported protocol.".into());
    }
    Ok(())
}
fn config_path(paths: &RuntimePaths) -> std::path::PathBuf {
    paths.metadata.with_file_name("network.json")
}
fn read_config(paths: &RuntimePaths) -> Result<Configuration, String> {
    let path = config_path(paths);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Configuration::default()),
        Err(_) => return Err("Could not read saved ports.".into()),
    };
    if bytes.len() > 128 * 1024 {
        return Err("Saved ports are invalid.".into());
    }
    let config: Configuration =
        serde_json::from_slice(&bytes).map_err(|_| "Saved ports are invalid.")?;
    let mut seen = BTreeSet::new();
    if config.mappings.len() > 4096 {
        return Err("Too many saved ports.".into());
    }
    for mapping in &config.mappings {
        validate(mapping)?;
        if !seen.insert((&mapping.workspace, mapping.port)) {
            return Err("Saved ports contain duplicates.".into());
        }
    }
    Ok(config)
}
fn write_config(paths: &RuntimePaths, config: &Configuration) -> Result<(), String> {
    let path = config_path(paths);
    let bytes = serde_json::to_vec(config).map_err(|_| "Could not save ports.")?;
    if bytes.len() > 128 * 1024 || config.mappings.len() > 4096 {
        return Err("Too many saved ports. Remove an unused port first.".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Could not save ports.")?)
        .map_err(|_| "Could not save ports.")?;
    file.as_file_mut()
        .write_all(&bytes)
        .map_err(|_| "Could not save ports.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Could not save ports.")?;
    file.persist(path).map_err(|_| "Could not save ports.")?;
    Ok(())
}

// Linux /proc socket tables are available inside guests on both supported hosts.
// A loopback-only listener cannot be reached by the runtime's guest-IP forwarder.
fn parse_listeners(output: &str) -> Result<BTreeMap<u16, bool>, String> {
    let mut ports = BTreeMap::new();
    let mut header = false;
    if output.len() > 1024 * 1024 {
        return Err(FAILED.into());
    }
    for line in output.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.is_empty() {
            continue;
        }
        if fields[0] == "sl" {
            header = true;
            continue;
        }
        if fields.len() < 4 {
            return Err(FAILED.into());
        }
        if fields[3] != "0A" {
            continue;
        }
        let (address, port) = fields[1].split_once(':').ok_or(FAILED)?;
        if !matches!(address.len(), 8 | 32) || !address.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(FAILED.into());
        }
        let port = u16::from_str_radix(port, 16).map_err(|_| FAILED)?;
        if port == 0 {
            return Err(FAILED.into());
        }
        // IPv6-only sockets are not proof of reachability over the IPv4 publisher.
        let reachable_bind = address.len() == 8 && !address.ends_with("7F");
        ports
            .entry(port)
            .and_modify(|known| *known |= reachable_bind)
            .or_insert(reachable_bind);
        if ports.len() > 4096 {
            return Err(FAILED.into());
        }
    }
    if !header {
        return Err(FAILED.into());
    }
    Ok(ports)
}
fn listeners(paths: &RuntimePaths, workspace: &str) -> Result<BTreeMap<u16, bool>, String> {
    let output = runtime::run_msb(
        paths,
        &[
            "exec".into(),
            workspace.into(),
            "--no-start".into(),
            "--no-tty".into(),
            "--quiet".into(),
            "--timeout".into(),
            "3s".into(),
            "--".into(),
            "sh".into(),
            "-c".into(),
            "cat /proc/net/tcp && { if [ -f /proc/net/tcp6 ]; then cat /proc/net/tcp6; fi; }"
                .into(),
        ],
        Duration::from_secs(5),
    )
    .map_err(|_| FAILED)?;
    parse_listeners(&output.stdout)
}

#[cfg(unix)]
fn control_response(socket: &Path, request: Value) -> Result<Value, String> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(socket)
        .map_err(|_| "Network controls are unavailable. Restart this VM and retry.")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| FAILED)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| FAILED)?;
    serde_json::to_writer(&mut stream, &request).map_err(|_| FAILED)?;
    stream.write_all(b"\n").map_err(|_| FAILED)?;
    let mut response = Vec::new();
    use std::io::Read;
    BufReader::new(stream)
        .take(64 * 1024 + 1)
        .read_until(b'\n', &mut response)
        .map_err(|_| "Network operation timed out. Retry to check its result.")?;
    if response.len() > 64 * 1024 || response.last() != Some(&b'\n') {
        return Err(FAILED.into());
    }
    let value: Value = serde_json::from_slice(&response).map_err(|_| FAILED)?;
    if value["ok"] != true {
        let message = value["error"].as_str().unwrap_or("");
        return Err(if message.contains("Address already in use") || message.contains("address already in use") { "This local port is already in use. Choose another or use Automatic." }
            else if message.contains("Permission denied") || message.contains("permission denied") { "This local port needs elevated privileges. Choose a port above 1023." }
            else { "Could not update port forwarding. Restart the VM if its runtime was updated, then retry." }.into());
    }
    Ok(value)
}
fn control(socket: &Path, request: Value) -> Result<Vec<Published>, String> {
    let value = control_response(socket, request)?;
    let mut ports: Vec<Published> =
        serde_json::from_value(value["ports"].clone()).map_err(|_| FAILED)?;
    if ports.len() > LIMIT
        || ports
            .iter()
            .any(|p| p.guest_port == 0 || p.host_port == 0 || p.host_bind != "127.0.0.1")
    {
        return Err(FAILED.into());
    }
    ports.sort_by_key(|p| p.guest_port);
    if ports
        .windows(2)
        .any(|pair| pair[0].guest_port == pair[1].guest_port)
    {
        return Err(FAILED.into());
    }
    Ok(ports)
}

fn socket_path(paths: &RuntimePaths, workspace: &str) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(workspace.as_bytes()));
    paths
        .home
        .join("run/sandboxes")
        .join(&digest[..24])
        .join("control.sock")
}
fn configured_vm(paths: &RuntimePaths, name: &str) -> Result<runtime::InspectedSandbox, String> {
    let metadata = runtime::read_metadata(&paths.metadata)
        .map_err(|_| "Could not read sandbox configuration.")?;
    if !metadata
        .machines
        .iter()
        .any(|m| m.is_vm() && m.name() == name)
    {
        return Err("Choose a local Silo VM.".into());
    }
    let inspected = runtime::inspect_workspace(&ProcessRunner, paths, name)
        .map_err(|_| "Could not inspect this VM.")?;
    runtime::ensure_managed(&inspected).map_err(|_| "This VM is not managed by Silo.")?;
    Ok(inspected)
}
fn pending(mapping: &Mapping, message: Option<String>, state: &'static str) -> Port {
    Port {
        port: mapping.port,
        host_port: None,
        scheme: mapping.scheme.clone(),
        configured: true,
        state,
        message,
    }
}
fn observe(paths: &RuntimePaths, workspace: &str, config: &Configuration) -> Workspace {
    let desired: Vec<_> = config
        .mappings
        .iter()
        .filter(|m| m.workspace == workspace)
        .collect();
    let mut result = Workspace {
        workspace: workspace.into(),
        ports: vec![],
        error: None,
    };
    let state = match configured_vm(paths, workspace) {
        Ok(state) => state,
        Err(e) => {
            result.ports = desired
                .iter()
                .map(|m| pending(m, Some(e.clone()), "unknown"))
                .collect();
            result.error = Some(e);
            return result;
        }
    };
    if state.status != "Running" {
        result.ports = desired
            .iter()
            .filter(|m| m.enabled)
            .map(|m| {
                pending(
                    m,
                    Some("Start this VM to make the port available.".into()),
                    "waiting",
                )
            })
            .collect();
        return result;
    }
    let _guard = match NETWORK_LOCK.lock() {
        Ok(guard) => guard,
        Err(_) => {
            result.error = Some(FAILED.into());
            return result;
        }
    };
    // Read the current desired revision only after obtaining the mutation lock.
    // An older refresh must never restore access removed by another window.
    let config = match read_config(paths) {
        Ok(config) => config,
        Err(e) => {
            result.error = Some(e);
            return result;
        }
    };
    let desired: Vec<_> = config
        .mappings
        .iter()
        .filter(|m| m.workspace == workspace)
        .collect();
    let socket = socket_path(paths, workspace);
    let mut published = match control(&socket, json!({"op":"ports_list"})) {
        Ok(ports) => ports,
        Err(e) => {
            drop(_guard);
            result.ports = listeners(paths, workspace)
                .unwrap_or_default()
                .keys()
                .map(|port| Port {
                    port: *port,
                    host_port: None,
                    scheme: None,
                    configured: false,
                    state: "unpublished",
                    message: None,
                })
                .collect();
            for mapping in desired {
                result.ports.retain(|p| p.port != mapping.port);
                result
                    .ports
                    .push(pending(mapping, Some(e.clone()), "unknown"));
            }
            result.error = Some(e);
            result.ports.sort_by_key(|p| p.port);
            return result;
        }
    };
    let mut failures = BTreeMap::new();
    for mapping in &desired {
        let exists = published.iter().find(|p| p.guest_port == mapping.port);
        let request = if !mapping.enabled {
            exists.map(|_| json!({"op":"port_remove","guest_port":mapping.port}))
        } else if exists.is_some_and(|p| mapping.host_port.is_none_or(|host| host == p.host_port)) {
            None
        } else {
            Some(
                json!({"op":"port_add","guest_port":mapping.port,"host_port":mapping.host_port.unwrap_or(0)}),
            )
        };
        if let Some(request) = request {
            match control(&socket, request) {
                Ok(ports) => published = ports,
                Err(e) => {
                    failures.insert(mapping.port, e.clone());
                    if e.contains("timed out") || e.to_lowercase().contains("restart") {
                        for remaining in &desired {
                            failures.entry(remaining.port).or_insert_with(|| e.clone());
                        }
                        break;
                    }
                }
            }
        }
    }
    // Remove confirmed tombstones, so repeated add/remove never grows settings forever.
    let mut cleaned = Configuration {
        mappings: config.mappings.clone(),
    };
    cleaned.mappings.retain(|m| {
        m.workspace != workspace || m.enabled || published.iter().any(|p| p.guest_port == m.port)
    });
    if cleaned.mappings.len() != config.mappings.len() {
        let _ = write_config(paths, &cleaned);
    }
    drop(_guard);
    // Discovery and reachability can be slow; they must never block revocation.
    let listeners = match listeners(paths, workspace) {
        Ok(ports) => ports,
        Err(e) => {
            result.ports = desired
                .iter()
                .filter(|m| m.enabled || published.iter().any(|p| p.guest_port == m.port))
                .map(|m| pending(m, Some(e.clone()), "unknown"))
                .collect();
            result.error = Some(e);
            return result;
        }
    };
    let mut reachable = BTreeMap::new();
    let candidates: Vec<_> = desired
        .iter()
        .filter(|m| {
            m.enabled
                && listeners.contains_key(&m.port)
                && published.iter().any(|p| p.guest_port == m.port)
        })
        .collect();
    for batch in candidates.chunks(3) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|m| {
                    let socket = &socket;
                    scope.spawn(move || {
                        control_response(socket, json!({"op":"port_probe","guest_port":m.port}))
                            .and_then(|v| v["reachable"].as_bool().ok_or_else(|| FAILED.into()))
                    })
                })
                .collect();
            for (mapping, handle) in batch.iter().zip(handles) {
                reachable.insert(
                    mapping.port,
                    handle.join().unwrap_or_else(|_| Err(FAILED.into())),
                );
            }
        });
    }
    let mut rows: BTreeMap<u16, Port> = listeners
        .keys()
        .map(|port| {
            (
                *port,
                Port {
                    port: *port,
                    host_port: None,
                    scheme: None,
                    state: "unpublished",
                    configured: false,
                    message: None,
                },
            )
        })
        .collect();
    for mapping in desired {
        if !mapping.enabled && !failures.contains_key(&mapping.port) {
            continue;
        }
        let active = published.iter().find(|p| p.guest_port == mapping.port);
        let (status, message) = if let Some(e) = failures.get(&mapping.port) {
            (
                "unknown",
                Some(if mapping.enabled {
                    e.clone()
                } else {
                    format!("Access could not be removed. {e}")
                }),
            )
        } else if !listeners.contains_key(&mapping.port) {
            (
                "waiting",
                Some("Waiting for a service inside the VM.".into()),
            )
        } else if matches!(reachable.get(&mapping.port), Some(Ok(true))) {
            ("reachable", None)
        } else if let Some(Err(e)) = reachable.get(&mapping.port) {
            ("unknown", Some(e.clone()))
        } else if active.is_some() {
            ("waiting", Some("The service is not reachable through this port. Check its bind address and network policy; use 0.0.0.0 inside the VM.".into()))
        } else {
            (
                "unknown",
                Some("Port forwarding could not be verified.".into()),
            )
        };
        rows.insert(
            mapping.port,
            Port {
                port: mapping.port,
                host_port: active.map(|p| p.host_port),
                scheme: mapping.scheme.clone(),
                state: status,
                configured: true,
                message,
            },
        );
    }
    result.ports = rows.into_values().collect();
    // Guest probes run without blocking mutations. Never publish their result
    // against settings or endpoints that changed while those probes were running.
    let latest = NETWORK_LOCK
        .lock()
        .map_err(|_| FAILED.to_string())
        .and_then(|_guard| {
            let current = read_config(paths)?;
            let current: Vec<_> = current
                .mappings
                .iter()
                .filter(|m| m.workspace == workspace)
                .cloned()
                .collect();
            let previous: Vec<_> = config
                .mappings
                .iter()
                .filter(|m| {
                    m.workspace == workspace
                        && (m.enabled || published.iter().any(|p| p.guest_port == m.port))
                })
                .cloned()
                .collect();
            if current != previous {
                return Err("Network settings changed. Refresh to check the current ports.".into());
            }
            if control(&socket, json!({"op":"ports_list"}))? != published {
                return Err("Port forwarding changed. Refresh to check the current ports.".into());
            }
            Ok(())
        });
    if let Err(error) = latest {
        for port in &mut result.ports {
            port.state = "unknown";
            port.host_port = None;
        }
        result.error = Some(error);
    }
    result
}
fn state_with(paths: &RuntimePaths, config: &Configuration) -> Result<State, String> {
    let metadata = runtime::read_metadata(&paths.metadata)
        .map_err(|_| "Could not read sandbox configuration.")?;
    let mut workspaces = vec![];
    let names: Vec<_> = metadata
        .machines
        .iter()
        .filter(|m| m.is_vm())
        .map(|m| m.name())
        .collect();
    for batch in names.chunks(3) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = batch
                .iter()
                .map(|name| scope.spawn(move || observe(paths, name, config)))
                .collect();
            for (name, handle) in batch.iter().zip(handles) {
                workspaces.push(handle.join().unwrap_or_else(|_| Workspace {
                    workspace: (**name).into(),
                    ports: vec![],
                    error: Some(FAILED.into()),
                }));
            }
        });
    }
    Ok(State { workspaces })
}

#[tauri::command]
pub(crate) async fn read_network_state(app: AppHandle) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime::runtime_paths(&app).map_err(|_| FAILED)?;
        state_with(&paths, &read_config(&paths)?)
    })
    .await
    .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub(crate) async fn save_network_port(
    app: AppHandle,
    workspace: String,
    port: u16,
    host_port: Option<u16>,
    scheme: Option<String>,
) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = NETWORK_LOCK.lock().map_err(|_| FAILED)?;
        let paths = runtime::runtime_paths(&app).map_err(|_| FAILED)?;
        configured_vm(&paths, &workspace)?;
        let mapping = Mapping {
            workspace: workspace.clone(),
            port,
            host_port,
            scheme,
            enabled: true,
        };
        validate(&mapping)?;
        let mut config = read_config(&paths)?;
        if config
            .mappings
            .iter()
            .filter(|m| m.workspace == workspace && m.enabled && m.port != port)
            .count()
            >= LIMIT
        {
            return Err("This VM already has 128 published ports.".into());
        }
        config
            .mappings
            .retain(|m| m.workspace != workspace || m.port != port);
        config.mappings.push(mapping);
        if config.mappings.len() > 4096 {
            return Err("Too many saved ports. Remove an unused port first.".into());
        }
        write_config(&paths, &config)?;
        drop(_guard);
        let _ = observe(&paths, &workspace, &config);
        let result = state_with(&paths, &config);
        let _ = app.emit("silo://network-state-changed", ());
        result
    })
    .await
    .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub(crate) async fn remove_network_port(
    app: AppHandle,
    workspace: String,
    port: u16,
) -> Result<State, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = NETWORK_LOCK.lock().map_err(|_| FAILED)?;
        let paths = runtime::runtime_paths(&app).map_err(|_| FAILED)?;
        configured_vm(&paths, &workspace)?;
        let mut config = read_config(&paths)?;
        // Persist removal intent before touching the live listener. Failed removals
        // remain visible and reconcile on retry/relaunch, never silently reopen.
        if let Some(mapping) = config
            .mappings
            .iter_mut()
            .find(|m| m.workspace == workspace && m.port == port)
        {
            mapping.enabled = false;
        }
        write_config(&paths, &config)?;
        drop(_guard);
        let _ = observe(&paths, &workspace, &config);
        let result = state_with(&paths, &config);
        let _ = app.emit("silo://network-state-changed", ());
        result
    })
    .await
    .map_err(|_| FAILED.to_string())?
}
#[tauri::command]
pub(crate) async fn open_network_port(
    app: AppHandle,
    workspace: String,
    port: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime::runtime_paths(&app).map_err(|_| FAILED)?;
        let state = observe(&paths, &workspace, &read_config(&paths)?);
        let endpoint = state
            .ports
            .iter()
            .find(|p| p.port == port && p.configured && p.state == "reachable")
            .ok_or("This service is not reachable.")?;
        let scheme = endpoint
            .scheme
            .as_deref()
            .ok_or("This TCP service is not configured as a website.")?;
        crate::applications::open_browser(
            &app,
            &format!(
                "{scheme}://127.0.0.1:{}",
                endpoint.host_port.ok_or("This service is not reachable.")?
            ),
        )
    })
    .await
    .map_err(|_| FAILED.to_string())?
}

// Called after successful starts, including launch-at-login and temporary starts.
// Port failures must not turn a successful VM start into a VM lifecycle failure.
pub(crate) fn reconcile_started(paths: &RuntimePaths, workspace: &str) {
    if let Ok(config) = read_config(paths) {
        if config.mappings.iter().any(|m| m.workspace == workspace) {
            let _ = observe(paths, workspace, &config);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    fn control_reply(response: &str) -> Result<Vec<Published>, String> {
        use std::os::unix::net::UnixListener;
        // Keep the socket below macOS's pathname length limit.
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let path = directory.path().join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let response = response.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap()).read_line(&mut request).unwrap();
            assert_eq!(serde_json::from_str::<Value>(&request).unwrap()["op"], "ports_list");
            stream.write_all(response.as_bytes()).unwrap();
        });
        let result = control(&path, json!({"op":"ports_list"}));
        server.join().unwrap();
        result
    }

    #[test]
    #[cfg(unix)]
    fn runtime_errors_are_short_and_do_not_expose_raw_details() {
        let conflict = control_reply("{\"ok\":false,\"error\":\"Address already in use: private runtime diagnostics\"}\n").unwrap_err();
        assert_eq!(conflict, "This local port is already in use. Choose another or use Automatic.");
        let unknown = control_reply("{\"ok\":false,\"error\":\"private runtime diagnostics\"}\n").unwrap_err();
        assert!(!unknown.contains("private runtime diagnostics"));
        assert!(unknown.contains("Could not update port forwarding"));
    }

    #[test]
    #[cfg(unix)]
    fn invalid_or_externally_bound_runtime_ports_never_succeed() {
        assert!(control_reply("{\"ok\":true,\"ports\":[{\"guest_port\":3000,\"host_port\":43000,\"host_bind\":\"0.0.0.0\"}]}\n").is_err());
        assert!(control_reply("{\"ok\":true}\n").is_err());
        assert!(control_reply("{\"ok\":true,\"ports\":[]}").is_err());
        assert!(control_reply("not json\n").is_err());
        let ports = control_reply("{\"ok\":true,\"ports\":[{\"guest_port\":3000,\"host_port\":43000,\"host_bind\":\"127.0.0.1\"}]}\n").unwrap();
        assert_eq!(ports[0].host_port, 43000);
    }

    #[test]
    fn discovers_tcp_listeners_without_guessing_from_connections() {
        let input="sl local_address rem_address st\n0: 00000000:0BB8 00000000:0000 0A\n1: 0100007F:1538 00000000:0000 0A\n2: 00000000:0050 00000000:0000 01\n";
        let ports = parse_listeners(input).unwrap();
        assert_eq!(ports.get(&3000), Some(&true));
        assert_eq!(ports.get(&5432), Some(&false));
        assert!(!ports.contains_key(&80));
    }
    #[test]
    fn invalid_socket_output_is_not_empty_success() {
        assert!(parse_listeners("broken").is_err());
        assert!(parse_listeners("").is_err());
        assert!(parse_listeners("0: ZZZZZZZZ:1234 x 0A").is_err());
        assert!(parse_listeners("sl local_address rem_address st\n")
            .unwrap()
            .is_empty());
    }
    #[test]
    fn rejects_invalid_ports_and_schemes() {
        let mut m = Mapping {
            workspace: "dev".into(),
            port: 3000,
            host_port: None,
            scheme: Some("http".into()),
            enabled: true,
        };
        assert!(validate(&m).is_ok());
        m.host_port = Some(0);
        assert!(validate(&m).is_err());
        m.host_port = None;
        m.scheme = Some("file".into());
        assert!(validate(&m).is_err());
    }
    #[test]
    fn pending_removal_survives_relaunch_and_corrupt_settings_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let paths = RuntimePaths {
            executable: temp.path().join("msb"),
            home: temp.path().into(),
            storage_home: None,
            library: temp.path().join("lib"),
            metadata: temp.path().join("machines.json"),
            volumes: temp.path().join("volumes"),
        };
        let config = Configuration {
            mappings: vec![Mapping {
                workspace: "dev".into(),
                port: 3000,
                host_port: None,
                scheme: Some("http".into()),
                enabled: false,
            }],
        };
        write_config(&paths, &config).unwrap();
        assert!(!read_config(&paths).unwrap().mappings[0].enabled);
        fs::write(config_path(&paths), "broken").unwrap();
        assert!(read_config(&paths).is_err());
    }
    #[test]
    fn loopback_ipv6_is_not_reported_as_ipv4_reachable() {
        let input="sl local_address rem_address st\n0: 00000000000000000000000001000000:0BB8 00000000:0000 0A\n";
        assert_eq!(parse_listeners(input).unwrap().get(&3000), Some(&false));
    }
}
