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
    // A remote lifecycle action changes only one VM's runtime, so it shares that VM's
    // lane (keyed by stable id, with the same dedupe key as the local lifecycle command)
    // and, for the idempotent start/stop/restart, auto-retries transient failures exactly
    // like the local `workspace_action` command.
    if method == "runtime.action" {
        return remote_action(app, &paths, &params);
    }
    // Inventory changes (upsert/delete) stay computer-scoped: they rewrite the shared
    // metadata file. They run once, holding the gate for the whole operation.
    let _guard = OPERATIONS
        .computer("Applying remote change")
        .map_err(|e| e.to_string())?;
    shutdown::ensure_accepting_operations()?;
    let mut request = read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    let resources = host_resources().map_err(|e| e.to_string())?;
    let _ = app.emit("silo://application-state-changed", ());
    let result = (|| {
        match method {
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
                apply_whole_configuration_with_progress(
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

/// A remote start/stop/restart/dismiss-error against one local VM. Start/stop/restart are
/// idempotent, so transient runtime failures retry through `gated_auto_retry`, which
/// re-acquires this VM's gate per attempt (released between attempts) with the same lane,
/// dedupe key, labels, cancellability, and expected durations as the local command;
/// dismiss-error runs once. `silo://application-state-changed` is emitted around the work.
fn remote_action(app: &AppHandle, paths: &RuntimePaths, params: &Value) -> Result<Value, String> {
    let vm_id = params["vmId"].as_str().ok_or("Missing VM identity.")?.to_owned();
    let action = params["action"].as_str().ok_or("Missing VM action.")?.to_owned();
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "dismiss-error") {
        return Err("Unsupported remote lifecycle action.".into());
    }
    // Resolve the display name from fresh metadata before acquiring; the work re-reads and
    // re-checks the VM still exists once each attempt's turn arrives.
    let name = read_metadata(&paths.metadata)
        .map_err(|e| e.to_string())?
        .machines
        .into_iter()
        .find(|m| m.id() == vm_id && m.is_vm())
        .map(|m| m.name().to_owned())
        .ok_or("This VM no longer exists on this computer.")?;
    let base_label = lifecycle_label(&action, &name);
    let key = format!("vm:{vm_id}:{action}");
    // Start/restart may be cancelled while running; stop may not. Expected durations flag
    // slow operations in the UI (no auto-kill), matching the local command.
    let expected = match action.as_str() {
        "start" | "restart" => Duration::from_secs(180),
        "stop" => Duration::from_secs(120),
        _ => Duration::from_secs(600),
    };
    let allow_cancel = matches!(action.as_str(), "start" | "restart");
    let acquire = |label: &str| -> Result<operation_gate::OperationGuard<'static>, RuntimeError> {
        OPERATIONS
            .kind(operation_gate::OperationKind::Lifecycle)
            .acquire(
                operation_gate::Scope::Vm { id: vm_id.clone() },
                Some(name.clone()),
                label,
                Some(key.clone()),
            )
            .map_err(RuntimeError::from)
    };
    let prepare = |guard: &operation_gate::OperationGuard<'static>| {
        if allow_cancel {
            guard.allow_cancel();
        }
        guard.expect_within(expected);
    };
    let work = || -> Result<(), RuntimeError> {
        shutdown::ensure_accepting_operations().map_err(RuntimeError::Unavailable)?;
        let request = read_metadata(&paths.metadata)?;
        let resources = host_resources()?;
        let _ = app.emit("silo://application-state-changed", ());
        let machine = request
            .machines
            .iter()
            .find(|m| m.id() == vm_id && m.is_vm())
            .ok_or_else(|| RuntimeError::Invalid("This VM no longer exists on this computer.".into()))?;
        explicit_workspace_action_with(&ProcessRunner, paths, &resources, &action, machine.name())
    };
    let result = if matches!(action.as_str(), "start" | "stop" | "restart") {
        gated_auto_retry(&base_label, acquire, prepare, work)
    } else {
        match acquire(&base_label) {
            Ok(guard) => {
                prepare(&guard);
                let outcome = work();
                drop(guard);
                outcome
            }
            Err(error) => Err(error),
        }
    };
    let _ = app.emit("silo://application-state-changed", ());
    result
        .map_err(|e| safe_activity_error(&e))
        .and_then(|_| {
            serde_json::to_value(
                read_application_state_with(&ProcessRunner, paths).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())
        })
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
