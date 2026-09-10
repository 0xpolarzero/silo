//! Guest access is routed through the owning Silo process. Only public SSH keys
//! cross computers; editor and terminal applications always launch locally.
use crate::{remote, runtime};
use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use tauri::AppHandle;

pub(crate) fn target(value: &str) -> Result<Option<(String, String)>, String> {
    let Some(rest) = value.strip_prefix("silo-remote:") else {
        return Ok(None);
    };
    let Some((host, vm)) = rest.split_once(':') else {
        return Err("Invalid remote VM target.".into());
    };
    if uuid::Uuid::parse_str(host).is_err() || uuid::Uuid::parse_str(vm).is_err() {
        return Err("Invalid remote VM target.".into());
    }
    Ok(Some((host.into(), vm.into())))
}
fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing {key}."))
}
fn vm_name(app: &AppHandle, params: &Value) -> Result<String, String> {
    runtime::remote_ops::local_vm_name(app, string(params, "vmId")?)
}
pub(crate) fn dispatch(app: &AppHandle, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "files.list" => {
            let _guard = runtime::MUTATION_LOCK
                .try_lock()
                .map_err(|_| "A VM operation is in progress. Retry shortly.")?;
            let name = vm_name(app, params)?;
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0);
            let offset = usize::try_from(offset).map_err(|_| "Invalid folder offset.")?;
            let page = tauri::async_runtime::block_on(crate::files::list_workspace_directory(
                app.clone(),
                name,
                string(params, "path")?.into(),
                offset,
                params
                    .get("snapshotId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ))?;
            serde_json::to_value(page).map_err(|_| "Could not encode folder listing.".into())
        }
        "guest.prepare" => {
            let _guard = runtime::MUTATION_LOCK
                .try_lock()
                .map_err(|_| "A VM operation is in progress. Retry shortly.")?;
            let name = vm_name(app, params)?;
            let paths = runtime::runtime_paths(app)?;
            let public = crate::editor::authorize_remote(
                &paths,
                &name,
                string(params, "publicKey")?,
                string(params, "path")?,
            )?;
            Ok(json!({"hostPublicKey": public}))
        }
        "network.state" => crate::remote_network::host_state(app),
        "network.publish" => {
            let _guard = runtime::MUTATION_LOCK
                .try_lock()
                .map_err(|_| "A VM operation is in progress. Retry shortly.")?;
            runtime::shutdown::ensure_accepting_operations()?;
            let name = vm_name(app, params)?;
            let port = params["port"]
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p != 0)
                .ok_or("Invalid port.")?;
            let scheme = params["scheme"].as_str().map(str::to_owned);
            tauri::async_runtime::block_on(crate::network::save_network_port(
                app.clone(),
                name,
                port,
                None,
                scheme,
            ))?;
            crate::remote_network::host_state(app)
        }
        "repository.push" => {
            let name = vm_name(app, params)?;
            tauri::async_runtime::block_on(crate::host_push::push_repository(
                app.clone(),
                name,
                string(params, "path")?.into(),
            ))
        }
        "repository.dismiss" => {
            let name = vm_name(app, params)?;
            tauri::async_runtime::block_on(crate::host_push::dismiss_repository_push(
                app.clone(),
                name,
                string(params, "path")?.into(),
            ))?;
            Ok(Value::Null)
        }
        _ => Err("This Silo version does not support that remote operation.".into()),
    }
}

pub(crate) fn spawn_stream(app: &AppHandle, method: &str, params: &Value) -> Result<Child, String> {
    if method != "guest.ssh" {
        return Err("Unsupported guest connection.".into());
    }
    let _guard = runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "A VM operation is in progress. Retry shortly.")?;
    runtime::shutdown::ensure_accepting_operations()?;
    let name = vm_name(app, params)?;
    let paths = runtime::runtime_paths(app)?;
    let inspected = runtime::inspect_workspace(&runtime::ProcessRunner, &paths, &name)
        .map_err(|e| e.to_string())?;
    runtime::ensure_managed(&inspected).map_err(|e| e.to_string())?;
    if inspected.status != "Running" {
        return Err("Start this VM before connecting.".into());
    }
    Command::new(&paths.executable)
        .env("MSB_HOME", &paths.home)
        .env("MSB_PATH", &paths.executable)
        .env("MSB_LIBKRUNFW_PATH", &paths.library)
        .args([
            "ssh",
            "serve",
            &name,
            "--stdio",
            "--no-start",
            "--no-inactivity-timeout",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not open the remote VM connection.".into())
}

pub(crate) fn prepare(
    app: &AppHandle,
    host: &str,
    vm: &str,
    public: &str,
    path: &str,
) -> Result<String, String> {
    let result = remote::call_remote(
        app,
        host,
        "guest.prepare",
        json!({"vmId":vm,"publicKey":public,"path":path}),
    )?;
    let key = string(&result, "hostPublicKey")?;
    crate::editor::validate_public_key(key)?;
    Ok(key.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_targets_never_fall_back_to_local_names() {
        let host = uuid::Uuid::new_v4();
        let vm = uuid::Uuid::new_v4();
        assert_eq!(
            target(&format!("silo-remote:{host}:{vm}")).unwrap(),
            Some((host.to_string(), vm.to_string()))
        );
        assert_eq!(target("dev").unwrap(), None);
        for input in [
            "silo-remote:dev",
            "silo-remote:host:dev",
            "silo-remote:host:vm:extra",
        ] {
            assert!(target(input).is_err());
        }
    }
}
