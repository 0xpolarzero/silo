//! Each controller owns its loopback tunnels. A remote host's localhost address
//! is never presented as an address on this computer.
use crate::{remote, runtime};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::TcpListener,
    process::{Child, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::AppHandle;

struct Tunnel {
    child: Child,
    local_port: u16,
    remote_port: u16,
    scheme: Option<String>,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
static TUNNELS: OnceLock<Mutex<HashMap<(String, String, u16), Tunnel>>> = OnceLock::new();
fn tunnels() -> &'static Mutex<HashMap<(String, String, u16), Tunnel>> {
    TUNNELS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn host_state(app: &AppHandle) -> Result<Value, String> {
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
    let value = match remote::call_remote(app, host, "network.state", json!({})) {
        Ok(value) => value,
        Err(error) => {
            if let Ok(mut entries) = tunnels().lock() {
                entries.retain(|(id, _, _), _| id != host);
            }
            return Err(error);
        }
    };
    let mut entries = tunnels()
        .lock()
        .map_err(|_| "Network connections unavailable.")?;
    project_ports(value, host, &mut entries)
}
fn project_ports(
    mut value: Value,
    host: &str,
    entries: &mut HashMap<(String, String, u16), Tunnel>,
) -> Result<Value, String> {
    let mut observed = std::collections::HashSet::new();
    for row in value["workspaces"]
        .as_array_mut()
        .ok_or("Invalid remote network state.")?
    {
        let vm = row["vmId"]
            .as_str()
            .ok_or("Missing remote VM identity.")?
            .to_owned();
        row["workspace"] = json!(format!("silo-remote:{host}:{vm}"));
        for port in row["ports"]
            .as_array_mut()
            .ok_or("Invalid remote port state.")?
        {
            let guest = port["port"]
                .as_u64()
                .and_then(|n| u16::try_from(n).ok())
                .ok_or("Invalid remote port.")?;
            let key = (host.into(), vm.clone(), guest);
            observed.insert(key.clone());
            let valid = entries.get_mut(&key).is_some_and(|t| {
                t.child.try_wait().ok() == Some(None)
                    && port["hostPort"].as_u64() == Some(t.remote_port as u64)
            });
            if !valid {
                entries.remove(&key);
            }
            if let Some(tunnel) = entries.get(&key) {
                port["hostPort"] = json!(tunnel.local_port);
                port["configuredHostPort"] = json!(tunnel.local_port);
                port["configured"] = json!(true);
                port["scheme"] = json!(tunnel.scheme);
            } else {
                port["hostPort"] = Value::Null;
                port["configuredHostPort"] = Value::Null;
                port["configured"] = json!(false);
                port["state"] = json!("unpublished");
            }
        }
    }
    entries.retain(|key, _| key.0 != host || observed.contains(key));
    Ok(value)
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
        let key = (host_id.clone(), vm_id, port);
        let mut entries = tunnels()
            .lock()
            .map_err(|_| "Network connections unavailable.")?;
        runtime::shutdown::ensure_accepting_operations()?;
        if entries.len() >= 128 && !entries.contains_key(&key) {
            return Err("Close an unused connection before opening another port.".into());
        }
        entries.remove(&key);
        let reservation = TcpListener::bind(("127.0.0.1", host_port.unwrap_or(0)))
            .map_err(|_| "This local port is already in use.")?;
        let local = reservation.local_addr().map_err(|e| e.to_string())?.port();
        let mut command = remote::ssh_tunnel_command(&host_id, local, endpoint)?;
        drop(reservation);
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not open the SSH tunnel.")?;
        let mut tunnel = Tunnel {
            child,
            local_port: local,
            remote_port: endpoint,
            scheme,
        };
        // Probe the local listener; process creation alone does not mean forwarding succeeded.
        let until = std::time::Instant::now() + Duration::from_secs(12);
        loop {
            if tunnel
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err(
                    "SSH could not open this port. Check access and local port availability."
                        .into(),
                );
            }
            if std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], local)),
                Duration::from_millis(100),
            )
            .is_ok()
            {
                break;
            }
            if std::time::Instant::now() >= until {
                return Err("Timed out opening the SSH tunnel.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        runtime::shutdown::ensure_accepting_operations()?;
        entries.insert(key, tunnel);
        drop(entries);
        read(&app, &host_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_remove_network_port(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    port: u16,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tunnels()
            .lock()
            .map_err(|_| "Network connections unavailable.")?
            .remove(&(host_id.clone(), vm_id, port));
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
            .ok_or("This service is not connected.")?;
        crate::applications::open_browser(&app, &format!("{scheme}://127.0.0.1:{local}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn close_all() {
    if let Ok(mut entries) = tunnels().lock() {
        entries.clear();
    }
}

pub(crate) fn close_host(host: &str) {
    if let Ok(mut entries) = tunnels().lock() {
        entries.retain(|(id, _, _), _| id != host);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observed(host_port: u16) -> Value {
        json!({"workspaces":[{"workspace":"dev","vmId":"vm","ports":[{"port":3000,"hostPort":host_port,"configured":true,"state":"reachable","scheme":"http"}]}]})
    }
    fn tunnel() -> Tunnel {
        let child = std::process::Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        Tunnel {
            child,
            local_port: 43000,
            remote_port: 32000,
            scheme: Some("http".into()),
        }
    }
    #[test]
    fn owner_loopback_is_not_a_controller_endpoint_until_a_tunnel_exists() {
        let mut entries = HashMap::new();
        let result = project_ports(observed(32000), "office", &mut entries).unwrap();
        assert_eq!(
            result["workspaces"][0]["workspace"],
            "silo-remote:office:vm"
        );
        assert!(result["workspaces"][0]["ports"][0]["hostPort"].is_null());
        assert_eq!(result["workspaces"][0]["ports"][0]["configured"], false);
        entries.insert(("office".into(), "vm".into(), 3000), tunnel());
        let result = project_ports(observed(32000), "office", &mut entries).unwrap();
        assert_eq!(result["workspaces"][0]["ports"][0]["hostPort"], 43000);
        assert_eq!(result["workspaces"][0]["ports"][0]["configured"], true);
    }
    #[test]
    fn changed_owner_endpoint_or_deleted_vm_closes_only_its_own_tunnels() {
        let key = ("office".into(), "vm".into(), 3000);
        let other = ("other".into(), "vm".into(), 3000);
        let mut entries = HashMap::from([(key.clone(), tunnel()), (other.clone(), tunnel())]);
        let result = project_ports(observed(32001), "office", &mut entries).unwrap();
        assert!(result["workspaces"][0]["ports"][0]["hostPort"].is_null());
        assert!(!entries.contains_key(&key));
        assert!(entries.contains_key(&other));
        entries.insert(key.clone(), tunnel());
        project_ports(json!({"workspaces":[]}), "office", &mut entries).unwrap();
        assert!(!entries.contains_key(&key));
        assert!(entries.contains_key(&other));
    }
}
