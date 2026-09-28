//! Targeted changes against the owner's current inventory, ordered by the operation gate.
use super::*;

pub(crate) fn dispatch(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let paths = runtime_paths(app)?;
    if method == "runtime.snapshot" {
        return serde_json::to_value(tauri::async_runtime::block_on(read_application_state(
            app.clone(),
            params.get("refreshRepositories").and_then(Value::as_bool),
        ))?)
        .map_err(|e| e.to_string());
    }
    if method == "runtime.logs" {
        let request = serde_json::from_value(params).map_err(|_| "Invalid log query.")?;
        let (id, name) = crate::remote::log_identity()?;
        return serde_json::to_value(runtime_logs::query_local(&paths, request, &id, &name)?).map_err(|e| e.to_string());
    }
    if method == "runtime.configuration" {
        return serde_json::to_value(read_metadata(&paths.metadata).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string());
    }
    // Remote-triggered work waits its turn. A single dispatch may change the shared
    // inventory (upsert/delete) or one VM's lifecycle; computer scope keeps it
    // correct and ordered against all local operations, matching the former lock.
    let _guard = OPERATIONS
        .computer("Applying remote change")
        .map_err(|e| e.to_string())?;
    shutdown::ensure_accepting_operations()?;
    let mut request = read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    let resources = host_resources().map_err(|e| e.to_string())?;
    let _ = app.emit("silo://application-state-changed", ());
    let result = (|| {
        match method {
            "runtime.action" => {
                let vm_id = params["vmId"].as_str().ok_or("Missing VM identity.")?;
                let machine = request
                    .machines
                    .iter()
                    .find(|m| m.id() == vm_id && m.is_vm())
                    .ok_or("This VM no longer exists on this computer.")?;
                let action = params["action"].as_str().ok_or("Missing VM action.")?;
                if !matches!(action, "start" | "stop" | "restart" | "dismiss-error") {
                    return Err("Unsupported remote lifecycle action.".into());
                }
                explicit_workspace_action_with(&ProcessRunner, &paths, &resources, action, machine.name())
                    .map_err(|e| safe_activity_error(&e))?;
            }
            "runtime.upsert" | "runtime.delete" => {
                let expected: Option<MachineConfiguration> =
                    serde_json::from_value(params["expected"].clone())
                        .map_err(|_| "Invalid expected VM configuration.")?;
                let replacement: Option<MachineConfiguration> = if method == "runtime.upsert" {
                    Some(
                        serde_json::from_value(params["machine"].clone())
                            .map_err(|_| "Invalid VM configuration.")?,
                    )
                } else {
                    None
                };
                let id = replacement
                    .as_ref()
                    .map(|m| m.id())
                    .or_else(|| params["vmId"].as_str())
                    .ok_or("Missing VM identity.")?;
                if expected.as_ref().is_some_and(|m| !m.is_vm())
                    || replacement.as_ref().is_some_and(|m| !m.is_vm())
                {
                    return Err("Remote management only accepts virtual machines.".into());
                }
                change_machine(&mut request.machines, id, expected.as_ref(), replacement.as_ref())
                    .map_err(|rejection| match rejection {
                        ChangeRejection::Missing => "This VM no longer exists.".to_string(),
                        ChangeRejection::Stale | ChangeRejection::WrongTarget => {
                            "This VM changed on its computer. Refresh before trying again.".to_string()
                        }
                    })?;
                validate_request(&request).map_err(|e| e.to_string())?;
                validate_requested_resources(&request, &resources).map_err(|e| e.to_string())?;
                configuration_recovery::prepare_retry(&ProcessRunner, &paths, Some(&request))
                    .map_err(|e| e.to_string())?;
                save_machine_configuration_with_progress(
                    &ProcessRunner,
                    &paths,
                    &resources,
                    request,
                    None,
                    &|_, _, _| {
                        let _ = app.emit("silo://application-state-changed", ());
                    },
                )
                .map_err(|e| safe_activity_error(&e))?;
                configuration_recovery::finish(&paths).map_err(|e| e.to_string())?;
            }
            _ => return Err("Unsupported remote request.".into()),
        }
        serde_json::to_value(
            read_application_state_with(&ProcessRunner, &paths).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })();
    let _ = app.emit("silo://application-state-changed", ());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vm(id: &str) -> MachineConfiguration {
        MachineConfiguration::Vm {
            id: id.into(),
            name: id.into(),
            cpus: 2,
            max_cpus: 4,
            memory_gib: 2,
            max_memory_gib: 4,
            workspace_storage_gib: 10,
            runtime_storage_gib: 10,
            desktop: None,
        }
    }
    #[test]
    fn targeted_change_preserves_other_vms_and_rejects_stale_configuration() {
        let a = vm("a");
        let b = vm("b");
        let mut machines = vec![a.clone(), b.clone()];
        assert!(change_machine(&mut machines, "a", None, Some(&a)).is_err());
        assert_eq!(machines, vec![a.clone(), b.clone()]);
        change_machine(&mut machines, "a", Some(&a), None).unwrap();
        assert_eq!(machines, vec![b]);
        assert!(change_machine(&mut machines, "a", Some(&a), None).is_err());
    }
}

pub(crate) fn local_vm_name(app: &AppHandle, id: &str) -> Result<String, String> {
    let paths = runtime_paths(app)?;
    read_metadata(&paths.metadata)
        .map_err(|e| e.to_string())?
        .machines
        .into_iter()
        .find(|m| m.id() == id && m.is_vm())
        .map(|m| m.name().to_owned())
        .ok_or("This VM no longer exists on this computer.".into())
}
