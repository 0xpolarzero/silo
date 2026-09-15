//! Prepare a usable client command or explicitly export its isolated key.
use crate::{editor, remote, runtime, ssh_access};
use serde::Deserialize;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Material {
    private_key: String,
    port: u16,
    address: String,
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn command(path: &std::path::Path, material: &Material) -> Result<String, String> {
    let address: std::net::Ipv4Addr = material.address.parse().map_err(|_| "Invalid SSH address.")?;
    if material.port == 0 || address.is_unspecified() { return Err("Invalid SSH connection.".into()); }
    Ok(format!("ssh -i {} -o IdentitiesOnly=yes -p {} root@{}", quote(path.to_str().ok_or("Invalid key path.")?), material.port, address))
}

fn select_endpoint(material: &mut Material, network: Option<bool>, is_remote: bool, download: bool) -> Result<(), String> {
        if network == Some(true) && material.address == "127.0.0.1" && !download {
            return Err("Enable SSH from other computers first.".into());
        }
        if network == Some(false) { material.address = "127.0.0.1".into(); }
        // A controller cannot dial the owner's loopback address.
        if is_remote && !download && material.address == "127.0.0.1" {
            return Err("Enable access from other computers to connect to this remote sandbox.".into());
        }
    Ok(())
}

#[tauri::command]
pub(crate) async fn ssh_connection(app: AppHandle, window: WebviewWindow, workspace: Option<String>, host_id: Option<String>, vm_id: Option<String>, download: bool, network: Option<bool>) -> Result<Option<String>, String> {
    if window.label() != "main" { return Err("SSH keys can only be exported from the main window.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let paths = runtime::runtime_paths(&app)?;
        let is_remote = host_id.is_some();
        let (value, identity) = if let Some(host) = host_id {
            uuid::Uuid::parse_str(&host).map_err(|_| "Invalid computer identity.")?;
            let vm = vm_id.ok_or("Missing sandbox identity.")?;
            uuid::Uuid::parse_str(&vm).map_err(|_| "Invalid sandbox identity.")?;
            let value = remote::call_remote(&app, &host, "ssh.access.connection", serde_json::json!({"vmId":vm}))?;
            (value, format!("{host}-{vm}"))
        } else {
            let _guard = runtime::MUTATION_LOCK.lock().map_err(|_| "Sandbox operation failed.")?;
            runtime::shutdown::ensure_accepting_operations()?;
            let name = workspace.ok_or("Missing sandbox name.")?;
            let metadata = runtime::read_metadata(&paths.metadata).map_err(|_| "Could not read sandboxes.")?;
            let vm = metadata.machines.iter().find(|m| m.is_vm() && m.name() == name).ok_or("Sandbox no longer exists.")?;
            (ssh_access::connection_material(&paths, vm.id())?, vm.id().to_owned())
        };
        let mut material: Material = serde_json::from_value(value).map_err(|_| "Invalid connection response. Update Silo on both computers.")?;
        select_endpoint(&mut material, network, is_remote, download)?;
        let root = paths.home.join("ssh/connections");
        editor::private_directory(&root)?;
        let local = root.join(&identity);
        editor::write_private(&local, material.private_key.as_bytes())?;
        // Verify the exported bytes form a usable private key before presenting them.
        editor::public_key(&local)?;
        if download {
            let Some(selected) = app.dialog().file().set_parent(&window).set_title("Save SSH connection key")
                .set_file_name(format!("silo-{identity}.key")).blocking_save_file() else { return Ok(None); };
            let destination = selected.into_path().map_err(|_| "Choose a local file.")?;
            editor::write_private(&destination, material.private_key.as_bytes())?;
            Ok(None)
        } else { command(&local, &material).map(Some) }
    }).await.map_err(|_| "Could not prepare SSH connection.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_row_uses_its_endpoint_and_remote_loopback_is_not_presented_as_usable() {
        let mut material = Material { private_key: String::new(), port: 2222, address: "192.168.1.42".into() };
        select_endpoint(&mut material, Some(true), false, false).unwrap();
        assert_eq!(material.address, "192.168.1.42");
        select_endpoint(&mut material, Some(false), false, false).unwrap();
        assert_eq!(material.address, "127.0.0.1");
        assert!(select_endpoint(&mut material, Some(true), false, false).is_err());
        assert!(select_endpoint(&mut material, Some(false), true, false).is_err());
        select_endpoint(&mut material, Some(false), true, true).unwrap();
    }
    #[test]
    fn command_quotes_key_paths_and_uses_explicit_identity() {
        let material = Material { private_key: String::new(), port: 2223, address: "127.0.0.1".into() };
        assert_eq!(command(std::path::Path::new("/a'b $(bad)/key"), &material).unwrap(), "ssh -i '/a'\\''b $(bad)/key' -o IdentitiesOnly=yes -p 2223 root@127.0.0.1");
    }
}
