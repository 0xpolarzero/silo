//! Quit owns the same local runtime lock as normal VM operations. It never
//! follows saved SSH connections or sends commands to another computer.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

static QUITTING: AtomicBool = AtomicBool::new(false);

pub(crate) fn begin() {
    QUITTING.store(true, Ordering::SeqCst);
}
pub(crate) fn cancel() {
    QUITTING.store(false, Ordering::SeqCst);
}

/// Call after taking the runtime mutation lock, so admission cannot race Quit.
pub(crate) fn ensure_accepting_operations() -> Result<(), String> {
    if QUITTING.load(Ordering::SeqCst) {
        Err("Silo is quitting and stopping its local VMs. Wait for shutdown to finish.".into())
    } else {
        Ok(())
    }
}

pub(crate) fn stop_local_vms(app: &AppHandle) -> Result<(), String> {
    let _guard = MUTATION_LOCK.lock().map_err(|_| {
        "A sandbox operation failed unexpectedly. Check local VM status before retrying Quit."
            .to_string()
    })?;
    let paths = runtime_paths(app)?;
    let result =
        stop_local_vms_with(&ProcessRunner, &paths).map_err(|error| safe_activity_error(&error));
    let _ = app.emit("silo://application-state-changed", ());
    result
}

fn stop_local_vms_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
) -> Result<(), RuntimeError> {
    let committed = read_metadata(&paths.metadata)?.machines;
    let mut machines = committed.clone();
    for pending in configuration_recovery::shutdown_machines(paths)? {
        if !machines.iter().any(|machine| machine.id() == pending.id()) {
            machines.push(pending);
        }
    }
    if !machines.iter().any(MachineConfiguration::is_vm) && !paths.home.exists() {
        return Ok(());
    }
    let present: HashSet<_> = list_managed(runner, paths)?
        .into_iter()
        .map(|vm| vm.name)
        .collect();
    // Stopping does not require host capacity, unlike creating or starting.
    let host = HostResources {
        logical_cpus: 0,
        physical_memory_bytes: None,
    };
    let mut failures: Vec<String> = present.iter()
        .filter(|name| !machines.iter().any(|machine| machine.is_vm() && machine.name() == name.as_str()))
        .map(|name| format!("{name}: Silo found a managed VM without a matching saved identity. Repair its configuration before quitting."))
        .collect();
    for machine in machines
        .iter()
        .filter(|machine| machine.is_vm() && present.contains(machine.name()))
    {
        // perform verifies both Silo ownership and the immutable machine ID,
        // settles an in-flight transition, and verifies the resulting stop.
        let result = if committed.iter().any(|entry| entry.id() == machine.id()) {
            lifecycle_recovery::perform(runner, paths, &host, "stop", machine.name())
        } else {
            stop_uncommitted_vm(runner, paths, machine)
        };
        if let Err(error) = result {
            failures.push(format!(
                "{}: {}",
                machine.name(),
                safe_activity_error(&error)
            ));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(RuntimeError::Unavailable(format!(
            "Some local VMs could not stop:\n{}",
            failures.join("\n")
        )))
    }
}

// A failed guest verification can leave a real VM before metadata publication.
// Stop that exact journal-owned VM, preserving the unfinished configuration.
fn stop_uncommitted_vm(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let inspect = || {
        let observed = inspect_workspace(runner, paths, machine.name())?;
        ensure_managed(&observed)?;
        if observed.name != machine.name()
            || observed
                .config
                .pointer("/labels/silo.machine-id")
                .and_then(Value::as_str)
                != Some(machine.id())
        {
            return Err(RuntimeError::Invalid(
                "The unfinished VM changed identity. No stop was requested.".into(),
            ));
        }
        Ok(observed)
    };
    let until = Instant::now() + MUTATION_TIMEOUT;
    let mut requested_stop = false;
    loop {
        let observed = inspect()?;
        match observed.status.to_ascii_lowercase().as_str() {
            "stopped" | "created" => return Ok(()),
            "running" if !requested_stop => {
                runner.run(
                    paths,
                    &["stop".into(), machine.name().into(), "--quiet".into()],
                    STOP_TIMEOUT,
                )?;
                requested_stop = true;
                continue;
            }
            "starting" | "stopping" | "draining" => {}
            _ => {
                return Err(RuntimeError::Unavailable(
                    "The unfinished VM did not stop. Check its status and retry Quit.".into(),
                ))
            }
        }
        if Instant::now() >= until {
            return Err(RuntimeError::TimedOut {
                operation: "Stopping the unfinished VM".into(),
            });
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Runner {
        states: Mutex<HashMap<String, String>>,
        calls: Mutex<Vec<Vec<String>>>,
        fail: Option<String>,
    }
    impl RuntimeRunner for Runner {
        fn run(
            &self,
            _: &RuntimePaths,
            args: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args.to_vec());
            let mut states = self.states.lock().unwrap();
            let stdout = match args[0].as_str() {
                "list" => serde_json::to_string(&states.keys().map(|name| json!({"name":name})).collect::<Vec<_>>()).unwrap(),
                "inspect" => json!({"name":args[1],"status":states[&args[1]],"config":{"labels":{"silo.managed":"true","silo.machine-id":id(&args[1])}}}).to_string(),
                "stop" => {
                    if self.fail.as_deref() == Some(args[1].as_str()) { return Err(RuntimeError::Unavailable("Stop failed".into())); }
                    states.insert(args[1].clone(), "Stopped".into()); String::new()
                }
                _ => panic!("Unexpected command: {args:?}"),
            };
            Ok(CommandOutput {
                stdout,
                stderr: String::new(),
            })
        }
    }
    fn id(name: &str) -> String {
        format!(
            "00000000-0000-4000-8000-{:012}",
            if name == "first" { 1 } else { 2 }
        )
    }
    fn setup(directory: &tempfile::TempDir) -> RuntimePaths {
        let paths = super::super::tests::paths(directory);
        let machines = ["first", "second"].map(|name| json!({"kind":"vm","id":id(name),"name":name,"cpus":1,"maxCPUs":1,"memoryGiB":1,"maxMemoryGiB":1,"workspaceStorageGiB":10,"runtimeStorageGiB":10}));
        fs::write(
            &paths.metadata,
            json!({"schemaVersion":1,"machines":machines}).to_string(),
        )
        .unwrap();
        paths
    }
    fn runner(fail: Option<&str>) -> Runner {
        Runner {
            states: Mutex::new(HashMap::from([
                ("first".into(), "Running".into()),
                ("second".into(), "Running".into()),
            ])),
            calls: Mutex::new(vec![]),
            fail: fail.map(str::to_owned),
        }
    }
    #[test]
    fn quit_stops_and_verifies_each_local_vm_without_removing_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        stop_local_vms_with(&runner, &paths).unwrap();
        assert!(runner
            .states
            .lock()
            .unwrap()
            .values()
            .all(|state| state == "Stopped"));
        assert_eq!(read_metadata(&paths.metadata).unwrap().machines.len(), 2);
        assert_eq!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|args| args[0] == "stop")
                .count(),
            2
        );
    }
    #[test]
    fn one_failed_stop_preserves_failure_and_still_stops_other_vms() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(Some("first"));
        let error = stop_local_vms_with(&runner, &paths)
            .unwrap_err()
            .to_string();
        assert!(error.contains("first"));
        assert_eq!(runner.states.lock().unwrap()["first"], "Running");
        assert_eq!(runner.states.lock().unwrap()["second"], "Stopped");
    }
    #[test]
    fn saved_ssh_connections_are_never_contacted_or_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        let mut metadata = read_metadata(&paths.metadata).unwrap();
        metadata.machines.push(MachineConfiguration::Ssh {
            id: "00000000-0000-4000-8000-000000000003".into(),
            name: "remote".into(),
            host: "office.example".into(),
            user: "owner".into(),
            port: 22,
        });
        write_metadata(&paths.metadata, &metadata).unwrap();
        stop_local_vms_with(&runner, &paths).unwrap();
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .flatten()
            .any(|arg| arg == "remote" || arg == "office.example"));
        assert_eq!(read_metadata(&paths.metadata).unwrap().machines.len(), 3);
    }
    #[test]
    fn replaced_vm_is_not_stopped_and_prevents_successful_quit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        let mut metadata = read_metadata(&paths.metadata).unwrap();
        if let MachineConfiguration::Vm { id, .. } = &mut metadata.machines[0] {
            *id = "00000000-0000-4000-8000-000000000004".into();
        }
        write_metadata(&paths.metadata, &metadata).unwrap();
        assert!(stop_local_vms_with(&runner, &paths).is_err());
        assert_eq!(runner.states.lock().unwrap()["first"], "Running");
        assert_eq!(runner.states.lock().unwrap()["second"], "Stopped");
    }

    #[test]
    fn quit_stops_created_vms_when_guest_verification_failed_before_metadata_commit() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let candidate = read_metadata(&paths.metadata).unwrap();
        fs::remove_file(&paths.metadata).unwrap();
        configuration_recovery::begin(&paths, &candidate).unwrap();
        let runner = runner(None);
        stop_local_vms_with(&runner, &paths).unwrap();
        assert!(runner
            .states
            .lock()
            .unwrap()
            .values()
            .all(|state| state == "Stopped"));
        assert!(read_metadata(&paths.metadata).unwrap().machines.is_empty());
        assert_eq!(
            configuration_recovery::shutdown_machines(&paths).unwrap(),
            candidate.machines
        );
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| matches!(args[0].as_str(), "start" | "create" | "remove" | "exec")));
    }

    #[test]
    fn quit_does_not_silently_leave_an_unidentified_managed_vm_running() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let mut metadata = read_metadata(&paths.metadata).unwrap();
        metadata.machines.truncate(1);
        write_metadata(&paths.metadata, &metadata).unwrap();
        let runner = runner(None);
        let error = stop_local_vms_with(&runner, &paths)
            .unwrap_err()
            .to_string();
        assert!(error.contains("second"));
        assert_eq!(runner.states.lock().unwrap()["first"], "Stopped");
        assert_eq!(runner.states.lock().unwrap()["second"], "Running");
    }

    #[test]
    fn missing_metadata_does_not_hide_managed_vms_in_an_existing_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        fs::create_dir_all(&paths.home).unwrap();
        let runner = runner(None);
        let error = stop_local_vms_with(&runner, &paths)
            .unwrap_err()
            .to_string();
        assert!(error.contains("matching saved identity"));
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args[0] == "stop"));
    }

    #[test]
    fn empty_configuration_quits_without_needing_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let runner = runner(None);
        stop_local_vms_with(&runner, &paths).unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
    }
}
