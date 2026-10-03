//! Prepare a usable client command or explicitly export its isolated key.
use crate::{editor, remote, runtime, ssh_access};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    port: u16,
    address: String,
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn command(path: &Path, endpoint: &Endpoint, user: &str) -> Result<String, String> {
    let user = crate::working_account::response_user(&serde_json::json!({"user":user}))?;
    let address: std::net::Ipv4Addr = endpoint
        .address
        .parse()
        .map_err(|_| "Invalid SSH address.")?;
    if endpoint.port == 0 || address.is_unspecified() {
        return Err("Invalid SSH connection.".into());
    }
    Ok(format!(
        "ssh -i {} -o IdentitiesOnly=yes -p {} {user}@{}",
        quote(path.to_str().ok_or("Invalid key path.")?),
        endpoint.port,
        address
    ))
}

fn select_endpoint(
    endpoint: &mut Endpoint,
    network: Option<bool>,
    is_remote: bool,
    download: bool,
) -> Result<(), String> {
    if network == Some(true) && endpoint.address == "127.0.0.1" && !download {
        return Err("Enable SSH from other computers first.".into());
    }
    if network == Some(false) {
        endpoint.address = "127.0.0.1".into();
    }
    // A controller cannot dial the owner's loopback address.
    if is_remote && !download && endpoint.address == "127.0.0.1" {
        return Err("Enable access from other computers to connect to this remote sandbox.".into());
    }
    Ok(())
}

/// Where this computer keeps its own key for SSH access to one sandbox on another
/// computer. The private key never leaves this computer; the owner only receives its
/// public key (C-15).
fn remote_client_root(home: &Path) -> PathBuf {
    home.join("ssh/remote-clients")
}
/// Earlier versions kept a copy of the owner's own private key here instead.
fn legacy_connection_root(home: &Path) -> PathBuf {
    home.join("ssh/connections")
}

/// This computer's key for one remote sandbox, created on first use.
fn remote_client_key(home: &Path, host: &str, vm: &str) -> Result<PathBuf, String> {
    static KEYS: Mutex<()> = Mutex::new(());
    uuid::Uuid::parse_str(host).map_err(|_| "Invalid computer identity.")?;
    uuid::Uuid::parse_str(vm).map_err(|_| "Invalid sandbox identity.")?;
    let _guard = KEYS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let name = format!("{host}-{vm}");
    remove_if_present(&legacy_connection_root(home).join(&name))?;
    let root = remote_client_root(home);
    editor::private_directory(&home.join("ssh"))?;
    editor::private_directory(&root)?;
    let key = root.join(name);
    editor::key(&key)?;
    Ok(key)
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err("Could not remove an SSH connection key.".into())
        }
        _ => Ok(()),
    }
}

/// Delete every SSH connection key this computer holds for sandboxes on `host`, when
/// that computer is removed (C-15). Keys for other computers are untouched.
pub(crate) fn forget_host(home: &Path, host: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(host).map_err(|_| "Invalid computer identity.")?;
    let prefix = format!("{host}-");
    for root in [remote_client_root(home), legacy_connection_root(home)] {
        let entries = match std::fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Could not read SSH connection keys.".into()),
        };
        for entry in entries {
            let entry = entry.map_err(|_| "Could not read SSH connection keys.")?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix))
            {
                remove_if_present(&entry.path())?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_connection(
    app: AppHandle,
    window: WebviewWindow,
    workspace: Option<String>,
    host_id: Option<String>,
    vm_id: Option<String>,
    download: bool,
    network: Option<bool>,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("SSH keys can only be exported from the main window.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime::runtime_paths(&app)?;
        let is_remote = host_id.is_some();
        let (value, key, identity) = if let Some(host) = host_id {
            uuid::Uuid::parse_str(&host).map_err(|_| "Invalid computer identity.")?;
            let vm = vm_id.ok_or("Missing sandbox identity.")?;
            uuid::Uuid::parse_str(&vm).map_err(|_| "Invalid sandbox identity.")?;
            let key = remote_client_key(&paths.home, &host, &vm)?;
            // The owner authorizes this computer's public key under this computer's
            // Silo identity, so a replaced key supersedes the previous one.
            let (controller, _) = remote::log_identity()?;
            let value = remote::call_remote(&app, &host, "ssh.access.connection", serde_json::json!({
                "vmId":vm,"accountProtocol":1,"publicKey":editor::public_key(&key)?,"controllerId":controller,
            }))?;
            if value.get("privateKey").is_some() {
                return Err("Update Silo on both computers to connect over SSH.".into());
            }
            (value, key, format!("{host}-{vm}"))
        } else {
            // Exporting a connection reconciles the shared SSH listeners and port
            // allocation across VMs; computer scope.
            let _guard = runtime::OPERATIONS
                .computer("Preparing SSH access")
                .map_err(|e| e.to_string())?;
            runtime::shutdown::ensure_accepting_operations()?;
            let name = workspace.ok_or("Missing sandbox name.")?;
            let metadata = runtime::read_metadata(&paths.metadata).map_err(|_| "Could not read sandboxes.")?;
            let vm = metadata.machines.iter().find(|m| m.name() == name).ok_or("Sandbox no longer exists.")?;
            let value = ssh_access::connection_material(&paths, vm.id())?;
            let private = value["privateKey"].as_str().ok_or("Could not read the connection key.")?;
            let root = legacy_connection_root(&paths.home);
            editor::private_directory(&root)?;
            let local = root.join(vm.id());
            editor::write_private(&local, private.as_bytes())?;
            // Verify the exported bytes form a usable private key before presenting them.
            editor::public_key(&local)?;
            (value, local, vm.id().to_owned())
        };
        let user = crate::working_account::response_user(&value)?;
        let mut endpoint: Endpoint = serde_json::from_value(value).map_err(|_| "Invalid connection response. Update Silo on both computers.")?;
        select_endpoint(&mut endpoint, network, is_remote, download)?;
        if download {
            let Some(selected) = app.dialog().file().set_parent(&window).set_title("Save SSH connection key")
                .set_file_name(format!("silo-{identity}.key")).blocking_save_file() else { return Ok(None); };
            let destination = selected.into_path().map_err(|_| "Choose a local file.")?;
            let private = editor::read_regular(&key)?;
            editor::write_private(&destination, &private)?;
            Ok(None)
        } else { command(&key, &endpoint, user).map(Some) }
    }).await.map_err(|_| "Could not prepare SSH connection.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_row_uses_its_endpoint_and_remote_loopback_is_not_presented_as_usable() {
        let mut endpoint = Endpoint {
            port: 2222,
            address: "192.168.1.42".into(),
        };
        select_endpoint(&mut endpoint, Some(true), false, false).unwrap();
        assert_eq!(endpoint.address, "192.168.1.42");
        select_endpoint(&mut endpoint, Some(false), false, false).unwrap();
        assert_eq!(endpoint.address, "127.0.0.1");
        assert!(select_endpoint(&mut endpoint, Some(true), false, false).is_err());
        assert!(select_endpoint(&mut endpoint, Some(false), true, false).is_err());
        select_endpoint(&mut endpoint, Some(false), true, true).unwrap();
    }
    #[test]
    fn command_quotes_key_paths_and_uses_explicit_identity() {
        let endpoint = Endpoint {
            port: 2223,
            address: "127.0.0.1".into(),
        };
        assert_eq!(
            command(std::path::Path::new("/a'b $(bad)/key"), &endpoint, "silo").unwrap(),
            "ssh -i '/a'\\''b $(bad)/key' -o IdentitiesOnly=yes -p 2223 silo@127.0.0.1"
        );
        assert!(command(std::path::Path::new("/key"), &endpoint, "silo")
            .unwrap()
            .ends_with("silo@127.0.0.1"));
        assert!(command(std::path::Path::new("/key"), &endpoint, "unknown").is_err());
    }
    #[test]
    fn each_computer_keeps_its_own_remote_key_and_drops_the_owners_copy() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let (host, vm) = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        );
        let legacy = legacy_connection_root(home).join(format!("{host}-{vm}"));
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "owner's private key from an earlier version").unwrap();
        let key = remote_client_key(home, &host, &vm).unwrap();
        assert!(
            !legacy.exists(),
            "a copy of the owner's key must not be kept"
        );
        let public = editor::public_key(&key).unwrap();
        // Stable across connections, so the owner's authorization keeps working.
        assert_eq!(
            editor::public_key(&remote_client_key(home, &host, &vm).unwrap()).unwrap(),
            public
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(remote_client_key(home, "../escape", &vm).is_err());
    }
    #[test]
    fn removing_a_computer_reports_unreadable_key_directories() {
        let host = "00000000-0000-4000-8000-000000000001";
        let missing = tempfile::tempdir().unwrap();
        forget_host(missing.path(), host).unwrap();
        for root in [remote_client_root, legacy_connection_root] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::create_dir(directory.path().join("ssh")).unwrap();
            std::fs::write(root(directory.path()), "not a key directory").unwrap();
            assert_eq!(
                forget_host(directory.path(), host).unwrap_err(),
                "Could not read SSH connection keys."
            );
        }
    }
    #[test]
    fn removing_a_computer_deletes_only_its_connection_keys() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let (removed, kept, vm) = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        );
        let removed_key = remote_client_key(home, &removed, &vm).unwrap();
        let kept_key = remote_client_key(home, &kept, &vm).unwrap();
        let legacy = legacy_connection_root(home).join(format!("{removed}-{vm}"));
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "owner's private key from an earlier version").unwrap();
        let local = legacy_connection_root(home).join(&vm);
        std::fs::write(&local, "this computer's own sandbox key").unwrap();
        forget_host(home, &removed).unwrap();
        assert!(!removed_key.exists() && !legacy.exists());
        assert!(kept_key.exists() && local.exists());
        assert!(forget_host(home, "..").is_err());
    }
}
