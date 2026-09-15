//! The controller only exchanges settings. Listeners belong to the remote Silo
//! application's ssh_access owner, independent of this controller's connection.
use crate::{remote, ssh_access::Settings};
use serde_json::{json, Value};
use tauri::AppHandle;

fn project(mut value: Value, host: &str) -> Result<Value, String> {
    uuid::Uuid::parse_str(host).map_err(|_| "Invalid computer identity.")?;
    let rows = value["workspaces"]
        .as_array_mut()
        .ok_or("Invalid remote SSH state.")?;
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let id = row["vmId"]
            .as_str()
            .ok_or("Missing remote sandbox identity. Update Silo on both computers.")?;
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid remote sandbox identity.")?;
        if !seen.insert(id.to_owned()) {
            return Err("Duplicate remote sandbox identity.".into());
        }
        row["workspace"] = json!(format!("silo-remote:{host}:{id}"));
    }
    Ok(value)
}
fn request(app: &AppHandle, host: &str, method: &str, params: Value) -> Result<Value, String> {
    uuid::Uuid::parse_str(host).map_err(|_| "Invalid computer identity.")?;
    project(remote::call_remote(app, host, method, params)?, host)
}
#[tauri::command]
pub(crate) async fn remote_ssh_access_state(
    app: AppHandle,
    host_id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request(&app, &host_id, "ssh.access.state", json!({}))
    })
    .await
    .map_err(|_| "Could not read remote SSH access.".to_string())?
}
#[tauri::command]
pub(crate) async fn remote_save_ssh_access(
    app: AppHandle,
    host_id: String,
    vm_id: String,
    enabled: bool,
    port: u16,
    bind_address: String,
    keys: Vec<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        uuid::Uuid::parse_str(&vm_id).map_err(|_| "Invalid sandbox identity.")?;
        let settings = Settings {
            enabled,
            port,
            bind_address,
            keys,
        };
        request(
            &app,
            &host_id,
            "ssh.access.save",
            json!({"vmId":vm_id,"settings":settings}),
        )
    })
    .await
    .map_err(|_| "Could not update remote SSH access.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_uses_owner_identity_and_preserves_owner_addresses_and_name() {
        let host = uuid::Uuid::new_v4().to_string();
        let vm = uuid::Uuid::new_v4().to_string();
        let value = json!({"workspaces":[{"vmId":vm,"workspace":"dev","computerName":"Computer B","bindAddress":"192.168.5.8","addresses":["192.168.5.8"],"state":"listening"}]});
        let projected = project(value.clone(), &host).unwrap();
        assert_eq!(
            projected["workspaces"][0]["workspace"],
            format!("silo-remote:{host}:{vm}")
        );
        for field in ["computerName", "bindAddress", "addresses", "state"] {
            assert_eq!(
                projected["workspaces"][0][field],
                value["workspaces"][0][field]
            );
        }
        let other = uuid::Uuid::new_v4().to_string();
        assert_ne!(
            project(value, &other).unwrap()["workspaces"][0]["workspace"],
            projected["workspaces"][0]["workspace"]
        );
    }
    #[test]
    fn missing_invalid_or_duplicate_remote_identity_never_falls_back_to_local_name() {
        let host = uuid::Uuid::new_v4().to_string();
        for value in [
            json!({}),
            json!({"workspaces":[{"workspace":"dev"}]}),
            json!({"workspaces":[{"vmId":"dev","workspace":"dev"}]}),
        ] {
            assert!(project(value, &host).is_err());
        }
        let id = uuid::Uuid::new_v4().to_string();
        assert!(project(json!({"workspaces":[{"vmId":id},{"vmId":id}]}), &host).is_err());
    }
}
