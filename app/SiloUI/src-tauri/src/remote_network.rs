//! Each controller owns its loopback tunnels. A remote host's localhost address
//! is never presented as an address on this computer.
//!
//! A tunnel the user opened is kept as an intent (its local port and scheme) while the
//! computer stays saved. When the tunnel dies (sleep, a dropped connection) or the other
//! computer publishes the port on a new endpoint, it is opened again in the background on
//! the same local port. Failed polls close live tunnels only when the computer failed
//! repeatedly or no longer admits this one (`remote::close_after_failed_poll`).
use crate::{remote, runtime};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

/// Saved computer id, sandbox id, guest port.
type Key = (String, String, u16);

struct Tunnel {
    child: Child,
    local_port: u16,
    remote_port: u16,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl std::fmt::Debug for Tunnel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Tunnel")
            .field("local_port", &self.local_port)
            .field("remote_port", &self.remote_port)
            .finish()
    }
}
impl Tunnel {
    fn alive(&mut self) -> bool {
        self.child.try_wait().ok() == Some(None)
    }
}
/// A port the user opened from this computer, kept while its tunnel is down.
#[derive(Clone, Debug, PartialEq)]
struct Intent {
    local_port: u16,
    scheme: Option<String>,
}
#[derive(Default)]
struct Tunnels {
    live: HashMap<Key, Tunnel>,
    intents: HashMap<Key, Intent>,
    /// Keys a background reconnect is opening right now.
    connecting: HashSet<Key>,
}
static TUNNELS: OnceLock<Mutex<Tunnels>> = OnceLock::new();
/// A short data lock: never held while ssh starts or a port is probed.
fn tunnels() -> MutexGuard<'static, Tunnels> {
    crate::sync::lock_or_recover(TUNNELS.get_or_init(|| Mutex::new(Tunnels::default())), "remote tunnels")
}
const TUNNEL_LIMIT: usize = 128;
/// How long a new tunnel may take to accept connections.
const READY_WITHIN: Duration = Duration::from_secs(12);
/// How long the owner reuses its network state for polling controllers.
const HOST_STATE_MAX_AGE: Duration = Duration::from_secs(2);

/// Network state of this computer for a controller, with stable VM ids. Several
/// controllers polling at once share one read (see `cached`).
pub(crate) fn host_state(app: &AppHandle) -> Result<Value, String> {
    cached(&HOST_STATE, HOST_STATE_MAX_AGE, || read_host_state(app))
}
/// A fresh read after a change on this computer; later polls reuse it.
pub(crate) fn fresh_host_state(app: &AppHandle) -> Result<Value, String> {
    cached(&HOST_STATE, Duration::ZERO, || read_host_state(app))
}
static HOST_STATE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
/// Returns the stored value while younger than `max_age`, else computes and stores it. The
/// lock is held while computing, so concurrent callers wait for one read instead of each
/// inspecting every VM. Errors are not stored.
fn cached(
    cache: &Mutex<Option<(Instant, Value)>>,
    max_age: Duration,
    compute: impl FnOnce() -> Result<Value, String>,
) -> Result<Value, String> {
    let mut cache = crate::sync::lock_or_recover(cache, "remote network state");
    if let Some((at, value)) = cache.as_ref() {
        if at.elapsed() < max_age {
            return Ok(value.clone());
        }
    }
    let value = compute()?;
    *cache = Some((Instant::now(), value.clone()));
    Ok(value)
}
fn read_host_state(app: &AppHandle) -> Result<Value, String> {
    let state = tauri::async_runtime::block_on(crate::network::read_network_state(app.clone()))?;
    let mut value = serde_json::to_value(state).map_err(|e| e.to_string())?;
    let paths = runtime::runtime_paths(app)?;
    let config = runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    for row in value["workspaces"]
        .as_array_mut()
        .ok_or("Invalid network state.")?
    {
        let name = row["workspace"].as_str().unwrap_or("");
        let machine = config
            .machines
            .iter()
            .find(|m| m.is_vm() && m.name() == name)
            .ok_or("VM configuration changed. Refresh network services.")?;
        row["vmId"] = json!(machine.id());
    }
    Ok(value)
}

fn read(app: &AppHandle, host: &str) -> Result<Value, String> {
    // A computer that just failed repeatedly is answered at once; its snapshot poll
    // (or this read, shortly) tries again.
    if let Some(error) = remote::offline(host) {
        return Err(error);
    }
    let value = match remote::call_remote(app, host, "network.state", json!({})) {
        Ok(value) => {
            remote::poll_succeeded(host);
            value
        }
        Err(error) => {
            remote::close_after_failed_poll(host, &error);
            return Err(error);
        }
    };
    let hosts = crate::network::uses_sandbox_hosts(app);
    let projection = project_ports(value, host, &mut tunnels(), hosts)?;
    let Projection { value, closed, reconnect } = projection;
    drop(closed);
    for (key, intent, remote_port) in reconnect {
        reconnect_in_background(app.clone(), key, intent, remote_port);
    }
    Ok(value)
}

struct Projection {
    value: Value,
    /// Tunnels to stop, dropped after the lock is released.
    closed: Vec<Tunnel>,
    /// Intended tunnels to open again: key, intent, the owner's current endpoint.
    reconnect: Vec<(Key, Intent, u16)>,
}
/// Rewrites the owner's rows for this computer: rows become remote targets, ports show this
/// computer's tunnel (never the owner's loopback endpoint), and with `hosts` each sandbox
/// gets the host name its websites open at here (C-24; the owner's own host choice is
/// ignored). Dead or outdated tunnels with an intent are reopened.
fn project_ports(mut value: Value, host: &str, tunnels: &mut Tunnels, hosts: bool) -> Result<Projection, String> {
    let mut observed = HashSet::new();
    let mut closed = Vec::new();
    let mut reconnect = Vec::new();
    for row in value["workspaces"]
        .as_array_mut()
        .ok_or("Invalid remote network state.")?
    {
        let vm = row["vmId"]
            .as_str()
            .ok_or("Missing remote VM identity.")?
            .to_owned();
        let name = row["workspace"].as_str().unwrap_or("").to_owned();
        row["host"] = if hosts {
            json!(crate::network::sandbox_host(&name, &vm))
        } else {
            Value::Null
        };
        row["workspace"] = json!(format!("silo-remote:{host}:{vm}"));
        for port in row["ports"]
            .as_array_mut()
            .ok_or("Invalid remote port state.")?
        {
            let guest = port["port"]
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .ok_or("Invalid remote port.")?;
            let key: Key = (host.into(), vm.clone(), guest);
            observed.insert(key.clone());
            let endpoint = port["hostPort"]
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .filter(|n| *n != 0);
            // A stopped or restarting VM has no endpoint yet; its tunnel waits for it.
            let current = tunnels.live.get_mut(&key).is_some_and(|tunnel| {
                tunnel.alive() && endpoint.is_none_or(|endpoint| endpoint == tunnel.remote_port)
            });
            if !current {
                closed.extend(tunnels.live.remove(&key));
            }
            let intent = tunnels.intents.get(&key).cloned();
            match (tunnels.live.get(&key), intent) {
                (Some(tunnel), intent) => {
                    port["configuredHostPort"] = json!(tunnel.local_port);
                    port["configured"] = json!(true);
                    port["scheme"] = json!(intent.and_then(|intent| intent.scheme));
                    port["hostPort"] = if endpoint.is_some() { json!(tunnel.local_port) } else { Value::Null };
                }
                (None, Some(intent)) => {
                    port["configuredHostPort"] = json!(intent.local_port);
                    port["configured"] = json!(true);
                    port["scheme"] = json!(intent.scheme);
                    port["hostPort"] = Value::Null;
                    if let Some(endpoint) = endpoint {
                        port["state"] = json!("waiting");
                        port["message"] = json!("Reconnecting to the other computer…");
                        if tunnels.connecting.insert(key.clone()) {
                            reconnect.push((key, intent, endpoint));
                        }
                    }
                }
                (None, None) => {
                    port["hostPort"] = Value::Null;
                    port["configuredHostPort"] = Value::Null;
                    port["configured"] = json!(false);
                    port["state"] = json!("unpublished");
                }
            }
        }
    }
    // Ports or sandboxes the owner no longer has are forgotten here too.
    let gone: Vec<Key> = tunnels
        .live
        .keys()
        .chain(tunnels.intents.keys())
        .filter(|key| key.0 == host && !observed.contains(*key))
        .cloned()
        .collect();
    for key in gone {
        closed.extend(tunnels.live.remove(&key));
        tunnels.intents.remove(&key);
    }
    Ok(Projection { value, closed, reconnect })
}

/// Starts ssh forwarding `local` (or any free port) to the owner's `remote_port` and waits
/// until the local port accepts connections. Runs without the tunnels lock.
fn open_tunnel(
    command: impl FnOnce(u16) -> Result<Command, String>,
    local: Option<u16>,
    remote_port: u16,
    ready_within: Duration,
) -> Result<Tunnel, String> {
    let reservation = TcpListener::bind(("127.0.0.1", local.unwrap_or(0)))
        .map_err(|_| "This local port is already in use.")?;
    let local = reservation.local_addr().map_err(|e| e.to_string())?.port();
    let mut command = command(local)?;
    drop(reservation);
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not open the SSH tunnel.")?;
    let mut tunnel = Tunnel { child, local_port: local, remote_port };
    // Probe the local listener; process creation alone does not mean forwarding succeeded.
    let until = Instant::now() + ready_within;
    loop {
        if !tunnel.alive() {
            return Err("SSH could not open this port. Check access and local port availability.".into());
        }
        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], local)),
            Duration::from_millis(100),
        )
        .is_ok()
        {
            return Ok(tunnel);
        }
        if Instant::now() >= until {
            return Err("Timed out opening the SSH tunnel.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn reconnect_in_background(app: AppHandle, key: Key, intent: Intent, remote_port: u16) {
    std::thread::spawn(move || {
        let opened = runtime::shutdown::ensure_accepting_operations().and_then(|()| {
            open_tunnel(
                |local| remote::ssh_tunnel_command(&key.0, local, remote_port),
                Some(intent.local_port),
                remote_port,
                READY_WITHIN,
            )
        });
        let unused = {
            let mut tunnels = tunnels();
            tunnels.connecting.remove(&key);
            match opened {
                // Only while the user still wants this port and nothing else reopened it.
                Ok(tunnel) if tunnels.intents.get(&key) == Some(&intent) && !tunnels.live.contains_key(&key) => {
                    tunnels.live.insert(key, tunnel);
                    None
                }
                Ok(tunnel) => Some(tunnel),
                Err(_) => None,
            }
        };
        drop(unused);
        let _ = app.emit("silo://network-state-changed", ());
    });
}

/// Opens (or replaces) the tunnel for `key` and records the intent. The lock is taken only
/// around map updates. A different local port is opened before the previous tunnel closes,
/// so a failed replacement keeps the working one; reusing the same local port needs the
/// previous tunnel closed first.
fn save_tunnel(
    key: Key,
    host_port: Option<u16>,
    scheme: Option<String>,
    endpoint: u16,
    open: impl FnOnce(Option<u16>) -> Result<Tunnel, String>,
) -> Result<(), String> {
    let (requested, blocking) = {
        let mut tunnels = tunnels();
        runtime::shutdown::ensure_accepting_operations()?;
        if tunnels.live.len() >= TUNNEL_LIMIT && !tunnels.live.contains_key(&key) {
            return Err("Close an unused connection before opening another port.".into());
        }
        // Automatic keeps the port this computer used before, so bookmarks keep working.
        let requested = host_port.or_else(|| tunnels.intents.get(&key).map(|intent| intent.local_port));
        let unchanged = tunnels.live.get_mut(&key).is_some_and(|tunnel| {
            tunnel.alive() && tunnel.remote_port == endpoint && requested.is_none_or(|port| port == tunnel.local_port)
        });
        if unchanged {
            let local_port = tunnels.live[&key].local_port;
            tunnels.intents.insert(key, Intent { local_port, scheme });
            return Ok(());
        }
        let occupies = tunnels.live.get(&key).is_some_and(|tunnel| Some(tunnel.local_port) == requested);
        (requested, if occupies { tunnels.live.remove(&key) } else { None })
    };
    drop(blocking);
    let tunnel = open(requested)?;
    let replaced = {
        let mut tunnels = tunnels();
        if runtime::shutdown::ensure_accepting_operations().is_err() {
            return Err("Silo is quitting.".into());
        }
        tunnels.intents.insert(key.clone(), Intent { local_port: tunnel.local_port, scheme });
        tunnels.connecting.remove(&key);
        tunnels.live.insert(key, tunnel)
    };
    drop(replaced);
    Ok(())
}

#[tauri::command]
pub async fn remote_network_state(app: AppHandle, host_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || read(&app, &host_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_save_network_port(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    port: u16,
    host_port: Option<u16>,
    scheme: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if port == 0
            || host_port == Some(0)
            || !matches!(scheme.as_deref(), None | Some("http" | "https"))
        {
            return Err("Invalid port configuration.".into());
        }
        let state = remote::call_remote(
            &app,
            &host_id,
            "network.publish",
            json!({"vmId":vm_id,"port":port,"scheme":scheme}),
        )?;
        let endpoint = state["workspaces"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["vmId"] == vm_id))
            .and_then(|r| r["ports"].as_array())
            .and_then(|ports| ports.iter().find(|p| p["port"] == port))
            .and_then(|p| p["hostPort"].as_u64())
            .and_then(|p| u16::try_from(p).ok())
            .ok_or("The remote VM port is not available yet. Check the VM service and retry.")?;
        let host = host_id.clone();
        save_tunnel((host_id.clone(), vm_id, port), host_port, scheme, endpoint, |local| {
            open_tunnel(
                |local| remote::ssh_tunnel_command(&host, local, endpoint),
                local,
                endpoint,
                READY_WITHIN,
            )
        })?;
        read(&app, &host_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Stops publishing the port on the owning computer, then closes this computer's tunnel.
#[tauri::command]
pub async fn remote_remove_network_port(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    port: u16,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remote::call_remote(&app, &host_id, "network.unpublish", json!({"vmId":vm_id,"port":port}))?;
        let closed = {
            let mut tunnels = tunnels();
            let key = (host_id.clone(), vm_id, port);
            tunnels.intents.remove(&key);
            tunnels.live.remove(&key)
        };
        drop(closed);
        read(&app, &host_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_open_network_port(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    port: u16,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = read(&app, &host_id)?;
        let target = format!("silo-remote:{host_id}:{vm_id}");
        let endpoint = state["workspaces"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["workspace"] == target))
            .and_then(|r| r["ports"].as_array())
            .and_then(|ports| {
                ports
                    .iter()
                    .find(|p| p["port"] == port && p["state"] == "reachable")
            })
            .ok_or("This service is not reachable.")?;
        let scheme = endpoint["scheme"]
            .as_str()
            .filter(|s| matches!(*s, "http" | "https"))
            .ok_or("This port is not a website.")?;
        let local = endpoint["hostPort"]
            .as_u64()
            .and_then(|port| u16::try_from(port).ok())
            .ok_or("This service is not connected.")?;
        let url = crate::network::website_url(scheme, row_host(&state, &target), local);
        crate::applications::open_browser(&app, &url)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn row_host<'a>(state: &'a Value, target: &str) -> Option<&'a str> {
    state["workspaces"]
        .as_array()?
        .iter()
        .find(|row| row["workspace"] == target)?["host"]
        .as_str()
}
/// Closes every tunnel (quit).
pub(crate) fn close_all() {
    let closed: Vec<Tunnel> = tunnels().live.drain().map(|(_, tunnel)| tunnel).collect();
    drop(closed);
}
/// Closes a computer's live tunnels but keeps their intents, so they reopen on the same
/// local ports once it answers again.
pub(crate) fn disconnect_host(host: &str) {
    let closed: Vec<Tunnel> = {
        let mut tunnels = tunnels();
        let keys: Vec<Key> = tunnels.live.keys().filter(|key| key.0 == host).cloned().collect();
        keys.iter().filter_map(|key| tunnels.live.remove(key)).collect()
    };
    drop(closed);
}
/// Forgets a computer's tunnels and intents (removed, or no longer the same computer).
pub(crate) fn close_host(host: &str) {
    let closed: Vec<Tunnel> = {
        let mut tunnels = tunnels();
        tunnels.intents.retain(|key, _| key.0 != host);
        tunnels.connecting.retain(|key| key.0 != host);
        let keys: Vec<Key> = tunnels.live.keys().filter(|key| key.0 == host).cloned().collect();
        keys.iter().filter_map(|key| tunnels.live.remove(key)).collect()
    };
    drop(closed);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observed(host_port: Option<u16>) -> Value {
        json!({"workspaces":[{"workspace":"dev","vmId":"vm","ports":[{"port":3000,"hostPort":host_port,"configured":true,"state":"reachable","scheme":"http"}]}]})
    }
    fn child() -> Child {
        std::process::Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    }
    fn tunnel(local_port: u16, remote_port: u16) -> Tunnel {
        Tunnel { child: child(), local_port, remote_port }
    }
    fn intent(local_port: u16) -> Intent {
        Intent { local_port, scheme: Some("http".into()) }
    }
    fn key(host: &str) -> Key {
        (host.into(), "vm".into(), 3000)
    }
    fn port(result: &Projection) -> &Value {
        &result.value["workspaces"][0]["ports"][0]
    }

    #[test]
    fn owner_loopback_is_not_a_controller_endpoint_until_a_tunnel_exists() {
        let mut tunnels = Tunnels::default();
        let result = project_ports(observed(Some(32000)), "office", &mut tunnels, false).unwrap();
        assert_eq!(result.value["workspaces"][0]["workspace"], "silo-remote:office:vm");
        assert!(port(&result)["hostPort"].is_null());
        assert_eq!(port(&result)["configured"], false);
        tunnels.live.insert(key("office"), tunnel(43000, 32000));
        tunnels.intents.insert(key("office"), intent(43000));
        let result = project_ports(observed(Some(32000)), "office", &mut tunnels, false).unwrap();
        assert_eq!(port(&result)["hostPort"], 43000);
        assert_eq!(port(&result)["configured"], true);
        assert!(result.reconnect.is_empty() && result.closed.is_empty());
    }

    #[test]
    fn remote_sandboxes_open_at_their_own_host_on_this_computer() {
        let mut tunnels = Tunnels::default();
        let value = json!({"workspaces":[{"workspace":"dev","vmId":"1a2b3c4d-0000-4000-8000-000000000001","host":"owner-choice.localhost","ports":[]}]});
        let result = project_ports(value.clone(), "office", &mut tunnels, true).unwrap();
        assert_eq!(result.value["workspaces"][0]["host"], "dev-1a2b3c4d.localhost");
        assert_eq!(row_host(&result.value, "silo-remote:office:1a2b3c4d-0000-4000-8000-000000000001"), Some("dev-1a2b3c4d.localhost"));
        // This computer's browser decides, not the owner's.
        let result = project_ports(value, "office", &mut tunnels, false).unwrap();
        assert!(result.value["workspaces"][0]["host"].is_null());
    }

    #[test]
    fn a_new_owner_endpoint_or_a_dead_tunnel_reopens_on_the_same_local_port() {
        let mut tunnels = Tunnels::default();
        tunnels.live.insert(key("office"), tunnel(43000, 32000));
        tunnels.intents.insert(key("office"), intent(43000));
        // The VM restarted and the owner published the port on a new endpoint.
        let result = project_ports(observed(Some(32001)), "office", &mut tunnels, false).unwrap();
        assert_eq!(result.closed.len(), 1);
        assert_eq!(result.reconnect, [(key("office"), intent(43000), 32001)]);
        assert_eq!(port(&result)["configuredHostPort"], 43000);
        assert_eq!(port(&result)["state"], "waiting");
        // A reconnect already under way is not started twice.
        assert!(project_ports(observed(Some(32001)), "office", &mut tunnels, false).unwrap().reconnect.is_empty());
        tunnels.connecting.clear();
        // A tunnel that died (sleep) is reopened too.
        let mut dead = tunnel(43000, 32001);
        dead.child.kill().unwrap();
        dead.child.wait().unwrap();
        tunnels.live.insert(key("office"), dead);
        let result = project_ports(observed(Some(32001)), "office", &mut tunnels, false).unwrap();
        assert_eq!(result.reconnect, [(key("office"), intent(43000), 32001)]);
    }

    #[test]
    fn a_restarting_vm_keeps_its_tunnel_and_intent() {
        let mut tunnels = Tunnels::default();
        tunnels.live.insert(key("office"), tunnel(43000, 32000));
        tunnels.intents.insert(key("office"), intent(43000));
        let result = project_ports(observed(None), "office", &mut tunnels, false).unwrap();
        assert!(result.closed.is_empty() && result.reconnect.is_empty());
        assert!(port(&result)["hostPort"].is_null());
        assert_eq!(port(&result)["configuredHostPort"], 43000);
        // Back on the same endpoint: usable again without reconnecting.
        let result = project_ports(observed(Some(32000)), "office", &mut tunnels, false).unwrap();
        assert_eq!(port(&result)["hostPort"], 43000);
        assert!(result.reconnect.is_empty());
    }

    #[test]
    fn a_deleted_port_or_vm_forgets_only_its_own_tunnels() {
        let mut tunnels = Tunnels::default();
        for host in ["office", "other"] {
            tunnels.live.insert(key(host), tunnel(43000, 32000));
            tunnels.intents.insert(key(host), intent(43000));
        }
        let result = project_ports(json!({"workspaces":[]}), "office", &mut tunnels, false).unwrap();
        assert_eq!(result.closed.len(), 1);
        assert!(!tunnels.live.contains_key(&key("office")) && !tunnels.intents.contains_key(&key("office")));
        assert!(tunnels.live.contains_key(&key("other")) && tunnels.intents.contains_key(&key("other")));
    }

    #[test]
    fn saving_a_port_never_holds_the_lock_while_ssh_starts_and_keeps_the_old_tunnel_on_failure() {
        let host = uuid::Uuid::new_v4().to_string();
        let key = key(&host);
        save_tunnel(key.clone(), None, Some("http".into()), 32000, |requested| {
            assert!(TUNNELS.get().unwrap().try_lock().is_ok(), "the tunnels lock is held during the probe");
            assert_eq!(requested, None);
            Ok(tunnel(43100, 32000))
        })
        .unwrap();
        // Moving to another local port fails: the working tunnel stays.
        let failed = save_tunnel(key.clone(), Some(43101), None, 32000, |requested| {
            assert_eq!(requested, Some(43101));
            assert!(tunnels().live.contains_key(&key), "replaced before the new tunnel worked");
            Err("This local port is already in use.".into())
        });
        assert!(failed.is_err());
        assert_eq!(tunnels().live[&key].local_port, 43100);
        // Automatic reuses the intended local port after the tunnel died.
        tunnels().live.remove(&key);
        save_tunnel(key.clone(), None, Some("https".into()), 32005, |requested| {
            assert_eq!(requested, Some(43100));
            Ok(tunnel(43100, 32005))
        })
        .unwrap();
        assert_eq!(tunnels().intents[&key], Intent { local_port: 43100, scheme: Some("https".into()) });
        // An unchanged save only updates the scheme.
        save_tunnel(key.clone(), None, Some("http".into()), 32005, |_| panic!("must not reopen")).unwrap();
        assert_eq!(tunnels().intents[&key].scheme.as_deref(), Some("http"));
        disconnect_host(&host);
        assert!(!tunnels().live.contains_key(&key) && tunnels().intents.contains_key(&key));
        close_host(&host);
        assert!(!tunnels().intents.contains_key(&key));
    }

    #[test]
    fn opening_a_tunnel_waits_for_the_local_listener() {
        let sleeper = || {
            let mut command = Command::new("/bin/sleep");
            command.arg("30");
            command
        };
        // Stands in for ssh's listener: binds the local port once Silo released its reservation.
        let listener = std::sync::Arc::new(Mutex::new(None));
        let tunnel = open_tunnel(
            |local| {
                let listener = listener.clone();
                std::thread::spawn(move || {
                    let bound = (0..200).find_map(|_| {
                        TcpListener::bind(("127.0.0.1", local)).ok().or_else(|| {
                            std::thread::sleep(Duration::from_millis(10));
                            None
                        })
                    });
                    *listener.lock().unwrap() = bound;
                });
                Ok(sleeper())
            },
            None,
            32000,
            Duration::from_secs(10),
        )
        .unwrap();
        assert_ne!(tunnel.local_port, 0);
        assert_eq!(tunnel.remote_port, 32000);
        let exited = open_tunnel(|_| Ok(Command::new("/usr/bin/false")), None, 32000, Duration::from_secs(5));
        assert!(exited.unwrap_err().contains("could not open"));
        let silent = open_tunnel(|_| Ok(sleeper()), None, 32000, Duration::from_millis(300));
        assert_eq!(silent.unwrap_err(), "Timed out opening the SSH tunnel.");
        let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_eq!(open_tunnel(|_| Ok(sleeper()), Some(port), 32000, Duration::from_millis(300)).unwrap_err(), "This local port is already in use.");
    }

    #[test]
    fn the_owner_reads_its_network_state_once_for_concurrent_polls() {
        let cache = Mutex::new(None);
        let mut reads = 0;
        for _ in 0..3 {
            let value = cached(&cache, Duration::from_secs(60), || { reads += 1; Ok(json!(reads)) }).unwrap();
            assert_eq!(value, json!(1));
        }
        assert_eq!(cached(&cache, Duration::ZERO, || Ok(json!("fresh"))).unwrap(), json!("fresh"));
        assert!(cached(&cache, Duration::ZERO, || Err("failed".into())).is_err());
        assert_eq!(cached(&cache, Duration::from_secs(60), || panic!("an error is not stored")).unwrap(), json!("fresh"));
    }
}
