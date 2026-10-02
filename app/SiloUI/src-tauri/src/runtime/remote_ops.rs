//! Targeted changes against the owner's current inventory, ordered by the operation gate.
use super::*;

pub(crate) fn dispatch(app: &AppHandle, method: &str, params: Value) -> Result<Value, BridgeError> {
    let paths = runtime_paths(app)?;
    if method == "runtime.snapshot" {
        return serde_json::to_value(tauri::async_runtime::block_on(read_application_state(
            app.clone(),
            params.get("refreshRepositories").and_then(Value::as_bool),
        ))?)
        .map_err(|e| BridgeError::from(e.to_string()));
    }
    if method == "runtime.logs" {
        let request = serde_json::from_value(params).map_err(|_| "Invalid log query.")?;
        let (id, name) = crate::remote::log_identity()?;
        return serde_json::to_value(runtime_logs::query_local(&paths, request, &id, &name)?)
            .map_err(|e| BridgeError::from(e.to_string()));
    }
    if method == "runtime.configuration" {
        return serde_json::to_value(read_metadata(&paths.metadata).map_err(BridgeError::from)?)
            .map_err(|e| BridgeError::from(e.to_string()));
    }
    // A remote lifecycle action changes only one VM's runtime, so it shares that VM's
    // lane (keyed by stable id, with the same dedupe key as the local lifecycle command)
    // and, for the idempotent start/stop/restart, auto-retries transient failures exactly
    // like the local `workspace_action` command.
    if method == "runtime.action" {
        return remote_action(app, &paths, &params);
    }
    // Anything else is unknown: refuse it before taking the gate or announcing a change.
    if !matches!(method, "runtime.upsert" | "runtime.delete") {
        return Err(BridgeError::unsupported());
    }
    // Inventory changes (upsert/delete) stay computer-scoped: they rewrite the shared
    // metadata file. They run once, holding the gate for the whole operation.
    let removed: Vec<String> = (method == "runtime.delete")
        .then(|| params["vmId"].as_str().map(str::to_owned))
        .flatten()
        .into_iter()
        .collect();
    let _guard = OPERATIONS
        .removing(&removed, "Applying remote change")
        .map_err(BridgeError::from)?;
    shutdown::ensure_accepting_operations()?;
    let mut request = read_metadata(&paths.metadata).map_err(BridgeError::from)?;
    let resources = host_resources().map_err(BridgeError::from)?;
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
                change_machine(
                    &mut request.machines,
                    id,
                    expected.as_ref(),
                    replacement.as_ref(),
                )
                .map_err(|rejection| match rejection {
                    ChangeRejection::Missing => "This VM no longer exists.".to_string(),
                    ChangeRejection::Stale | ChangeRejection::WrongTarget => {
                        "This VM changed on its computer. Refresh before trying again.".to_string()
                    }
                })?;
                validate_request(&request).map_err(BridgeError::from)?;
                validate_requested_resources(&request, &resources).map_err(BridgeError::from)?;
                // A remote change must not silently replace a local change
                // that is waiting for Retry on this computer.
                if configuration_recovery::pending_request(&paths)
                    .map_err(BridgeError::from)?
                    .is_some()
                {
                    return Err("A sandbox change on this computer is waiting to be retried. Retry or correct it there first.".into());
                }
                configuration_recovery::prepare_retry(&ProcessRunner, &paths, Some(&request))
                    .map_err(BridgeError::from)?;
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
                .map_err(BridgeError::from)?;
                configuration_recovery::finish(&paths).map_err(BridgeError::from)?;
            }
            _ => return Err(BridgeError::unsupported()),
        }
        serde_json::to_value(application_state_response(app, &paths).map_err(BridgeError::from)?)
            .map_err(|e| BridgeError::from(e.to_string()))
    })();
    let _ = app.emit("silo://application-state-changed", ());
    result
}

/// A remote start/stop/restart/dismiss-error against one local VM. Start/stop/restart are
/// idempotent, so transient runtime failures retry through `gated_auto_retry`, which
/// re-acquires this VM's gate per attempt (released between attempts) with the same lane,
/// dedupe key, labels, cancellability, and expected durations as the local command;
/// dismiss-error runs once. `silo://application-state-changed` is emitted after the work.
fn remote_action(
    app: &AppHandle,
    paths: &RuntimePaths,
    params: &Value,
) -> Result<Value, BridgeError> {
    let changed = || {
        let _ = app.emit("silo://application-state-changed", ());
    };
    run_remote_action(
        &ProcessRunner,
        paths,
        params,
        &AUTO_RETRY_DELAYS,
        &host_resources,
        &changed,
    )?;
    serde_json::to_value(application_state_response(app, paths).map_err(BridgeError::from)?)
        .map_err(|e| BridgeError::from(e.to_string()))
}

/// The lifecycle part of `remote_action`, before the state read. A duplicate of a
/// request already waiting is handed to it, like the local command (D-13), so a
/// repeated remote click is not reported as a failure.
fn run_remote_action(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    params: &Value,
    delays: &[Duration],
    resources: &dyn Fn() -> Result<HostResources, RuntimeError>,
    changed: &dyn Fn(),
) -> Result<(), BridgeError> {
    let vm_id = params["vmId"]
        .as_str()
        .ok_or("Missing VM identity.")?
        .to_owned();
    let action = params["action"]
        .as_str()
        .ok_or("Missing VM action.")?
        .to_owned();
    if !matches!(
        action.as_str(),
        "start" | "stop" | "restart" | "dismiss-error"
    ) {
        return Err("Unsupported remote lifecycle action.".into());
    }
    // Resolve the display name from fresh metadata before acquiring; the work re-reads and
    // re-checks the VM still exists once each attempt's turn arrives.
    let name = read_metadata(&paths.metadata)
        .map_err(BridgeError::from)?
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
        let resources = resources()?;
        // The queue event shows the action; state is announced once the gate is released.
        let machine = request
            .machines
            .iter()
            .find(|m| m.id() == vm_id && m.is_vm())
            .ok_or_else(|| {
                RuntimeError::Invalid("This VM no longer exists on this computer.".into())
            })?;
        explicit_workspace_action_with(runner, paths, &resources, &action, machine.name())
    };
    let result = if matches!(action.as_str(), "start" | "stop" | "restart") {
        gated_auto_retry_with(delays, &base_label, acquire, prepare, work)
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
    changed();
    hand_off_duplicate(result).0.map_err(BridgeError::from)
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
    const ID: &str = "00000000-0000-4000-8000-0000000000d4";

    /// A local runtime for one VM named "dev": starts may time out a set number of
    /// times, or block until the running operation is cancelled.
    #[derive(Default)]
    struct Runtime {
        state: Mutex<String>,
        mutations: Mutex<Vec<String>>,
        timeouts: std::sync::atomic::AtomicUsize,
        started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    }
    impl Runtime {
        fn stopped() -> Self {
            Self {
                state: Mutex::new("Stopped".into()),
                ..Self::default()
            }
        }
        fn mutations(&self) -> Vec<String> {
            self.mutations.lock().unwrap().clone()
        }
    }
    impl RuntimeRunner for Runtime {
        fn run(
            &self,
            _: &RuntimePaths,
            args: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            use std::sync::atomic::Ordering;
            let output = |stdout: String| {
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            };
            match args[0].as_str() {
                "inspect" => output(json!({"name":"dev","status":*self.state.lock().unwrap(),"config":{"labels":{"silo.managed":"true","silo.machine-id":ID},"resources":{"cpus":1,"max_cpus":1,"memory_mib":1024,"max_memory_mib":1024}}}).to_string()),
                "start" => {
                    self.mutations.lock().unwrap().push("start".into());
                    if let Some(started) = self.started.lock().unwrap().take() {
                        started.send(()).unwrap();
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while !operation_gate::cancel_requested() && Instant::now() < deadline {
                            thread::sleep(Duration::from_millis(2));
                        }
                        return Err(RuntimeError::Cancelled { operation: "start dev".into() });
                    }
                    if self.timeouts.load(Ordering::SeqCst) > 0 {
                        self.timeouts.fetch_sub(1, Ordering::SeqCst);
                        return Err(RuntimeError::TimedOut { operation: "Starting dev".into() });
                    }
                    *self.state.lock().unwrap() = "Running".into();
                    output("null".into())
                }
                "stop" => {
                    self.mutations.lock().unwrap().push("stop".into());
                    *self.state.lock().unwrap() = "Stopped".into();
                    output("null".into())
                }
                _ => output("null".into()),
            }
        }
    }
    fn configured() -> (tempfile::TempDir, RuntimePaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let mut machine = vm(ID);
        if let MachineConfiguration::Vm {
            name,
            cpus,
            max_cpus,
            memory_gib,
            max_memory_gib,
            ..
        } = &mut machine
        {
            (*name, *cpus, *max_cpus, *memory_gib, *max_memory_gib) = ("dev".into(), 1, 1, 1, 1);
        }
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine],
            },
        )
        .unwrap();
        (dir, paths)
    }
    fn generous() -> Result<HostResources, RuntimeError> {
        Ok(HostResources {
            logical_cpus: 64,
            physical_memory_bytes: Some(256 * 1024 * 1024 * 1024),
        })
    }
    const QUICK: [Duration; 2] = [Duration::from_millis(1), Duration::from_millis(1)];

    #[test]
    fn remote_start_retries_a_transient_failure_in_the_vm_lane() {
        let _test_state = crate::test_support::global_state();
        let (_dir, paths) = configured();
        let runtime = Runtime::stopped();
        runtime
            .timeouts
            .store(1, std::sync::atomic::Ordering::SeqCst);
        let changed = std::sync::atomic::AtomicUsize::new(0);
        let count = || {
            changed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        };
        run_remote_action(
            &runtime,
            &paths,
            &json!({"vmId": ID, "action": "start"}),
            &QUICK,
            &generous,
            &count,
        )
        .unwrap();
        assert_eq!(runtime.mutations(), vec!["start", "start"]);
        assert_eq!(*runtime.state.lock().unwrap(), "Running");
        assert!(!lifecycle_recovery::has_intent(&paths, ID));
        assert!(OPERATIONS.is_vm_idle(ID));
        assert_eq!(
            changed.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "state is announced once, after the work (D-18)"
        );
    }

    #[test]
    fn a_repeated_remote_request_is_handed_to_the_one_already_waiting() {
        let _test_state = crate::test_support::global_state();
        let (_dir, paths) = configured();
        let runtime = std::sync::Arc::new(Runtime::stopped());
        let blocker = OPERATIONS.vm(ID, "dev", "Creating checkpoint").unwrap();
        let first = {
            let (runtime, paths) = (runtime.clone(), paths.clone());
            thread::spawn(move || {
                run_remote_action(
                    &*runtime,
                    &paths,
                    &json!({"vmId": ID, "action": "start"}),
                    &QUICK,
                    &generous,
                    &|| {},
                )
            })
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while OPERATIONS
            .snapshot()
            .waiting
            .iter()
            .all(|entry| entry.vm_id.as_deref() != Some(ID))
        {
            assert!(Instant::now() < deadline, "the first request never queued");
            thread::sleep(Duration::from_millis(2));
        }
        let second = {
            let (runtime, paths) = (runtime.clone(), paths.clone());
            thread::spawn(move || {
                run_remote_action(
                    &*runtime,
                    &paths,
                    &json!({"vmId": ID, "action": "start"}),
                    &QUICK,
                    &generous,
                    &|| {},
                )
            })
        };
        assert_eq!(
            second.join().unwrap(),
            Ok(()),
            "a duplicate is not a failure"
        );
        assert!(runtime.mutations().is_empty(), "the duplicate did not run");
        drop(blocker);
        assert_eq!(first.join().unwrap(), Ok(()));
        assert_eq!(runtime.mutations(), vec!["start"]);
    }

    #[test]
    fn a_cancelled_remote_start_is_not_retried_or_resumed() {
        let _test_state = crate::test_support::global_state();
        let (_dir, paths) = configured();
        let runtime = std::sync::Arc::new(Runtime::stopped());
        let (started, running) = std::sync::mpsc::channel();
        *runtime.started.lock().unwrap() = Some(started);
        let action = {
            let (runtime, paths) = (runtime.clone(), paths.clone());
            thread::spawn(move || {
                run_remote_action(
                    &*runtime,
                    &paths,
                    &json!({"vmId": ID, "action": "start"}),
                    &QUICK,
                    &generous,
                    &|| {},
                )
            })
        };
        running.recv_timeout(Duration::from_secs(5)).unwrap();
        let entry = OPERATIONS
            .snapshot()
            .running
            .into_iter()
            .find(|entry| entry.vm_id.as_deref() == Some(ID))
            .unwrap();
        assert!(entry.cancellable);
        OPERATIONS.cancel(entry.id).unwrap();
        let error = action.join().unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(runtime.mutations(), vec!["start"]);
        assert!(
            !lifecycle_recovery::has_intent(&paths, ID),
            "launch will not resume it"
        );
        assert!(OPERATIONS.is_vm_idle(ID));
    }

    #[test]
    fn remote_actions_reject_unknown_actions_and_vms_before_queueing() {
        let _test_state = crate::test_support::global_state();
        let (_dir, paths) = configured();
        let runtime = Runtime::stopped();
        for params in [
            json!({"vmId": ID, "action": "remove"}),
            json!({"vmId": "missing", "action": "start"}),
            json!({"action": "start"}),
        ] {
            assert!(
                run_remote_action(&runtime, &paths, &params, &QUICK, &generous, &|| {}).is_err()
            );
        }
        assert!(runtime.mutations().is_empty());
    }

    #[test]
    fn targeted_change_preserves_other_vms_and_rejects_stale_configuration() {
        let _test_state = crate::test_support::global_state();
        let a = vm("a");
        let b = vm("b");
        let mut machines = vec![a.clone(), b.clone()];
        assert!(change_machine(&mut machines, "a", None, Some(&a)).is_err());
        assert_eq!(machines, vec![a.clone(), b.clone()]);
        change_machine(&mut machines, "a", Some(&a), None).unwrap();
        assert_eq!(machines, vec![b]);
        assert!(change_machine(&mut machines, "a", Some(&a), None).is_err());
    }

    fn with_desktop(mut machine: MachineConfiguration, built_in: bool) -> MachineConfiguration {
        if let MachineConfiguration::Vm { desktop, .. } = &mut machine {
            *desktop = Some(crate::desktop::DesktopConfiguration {
                start_with_sandbox: true,
                built_in,
            });
        }
        machine
    }

    #[test]
    fn an_older_controllers_edit_that_cannot_see_built_in_still_applies() {
        let _test_state = crate::test_support::global_state();
        let owned = with_desktop(vm("a"), true);
        // The older controller parsed the snapshot and lost `builtIn`.
        let expected = with_desktop(vm("a"), false);
        let mut edited = with_desktop(vm("a"), false);
        if let MachineConfiguration::Vm { cpus, .. } = &mut edited {
            *cpus = 3;
        }
        let mut machines = vec![owned.clone()];
        change_machine(&mut machines, "a", Some(&expected), Some(&edited)).unwrap();
        assert!(crate::computer_use::is_built_in(&machines[0]));
        assert!(matches!(
            &machines[0],
            MachineConfiguration::Vm { cpus: 3, .. }
        ));
        // A real difference is still stale.
        let mut other = expected.clone();
        if let MachineConfiguration::Vm { cpus, .. } = &mut other {
            *cpus = 1;
        }
        assert!(change_machine(&mut machines, "a", Some(&other), None).is_err());
        // Deleting works from the older controller too.
        let expected = with_desktop(edited, false);
        change_machine(&mut machines, "a", Some(&expected), None).unwrap();
        assert!(machines.is_empty());
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
