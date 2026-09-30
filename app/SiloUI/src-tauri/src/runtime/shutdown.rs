//! Quit takes the same operation gate as normal VM operations. It never
//! follows saved SSH connections or sends commands to another computer.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static QUITTING: AtomicBool = AtomicBool::new(false);
/// Counts shutdowns that began (Quit or update installation), including ones later
/// cancelled. Work requested before a shutdown compares it to decide not to run
/// after that shutdown stopped the VMs, even when a failed Quit reopened admission.
static QUIT_GENERATION: AtomicU64 = AtomicU64::new(0);
static MAINTENANCE_DEADLINE: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) fn begin() {
    if let Ok(mut deadline) = MAINTENANCE_DEADLINE.lock() {
        *deadline = Some(Instant::now() + storage::TRIM_BUDGET);
    }
    QUIT_GENERATION.fetch_add(1, Ordering::SeqCst);
    QUITTING.store(true, Ordering::SeqCst);
}

/// The current shutdown generation. A retry sequence captures it before its first
/// attempt and stops once it changes (D-30).
pub(crate) fn generation() -> u64 {
    QUIT_GENERATION.load(Ordering::SeqCst)
}
pub(crate) fn cancel() {
    QUITTING.store(false, Ordering::SeqCst);
    if let Ok(mut deadline) = MAINTENANCE_DEADLINE.lock() { *deadline = None; }
}

pub(super) fn maintenance_budget() -> Duration {
    MAINTENANCE_DEADLINE.lock().map(|deadline| deadline
        .map_or(storage::TRIM_BUDGET, |at| at.saturating_duration_since(Instant::now())))
        .unwrap_or(Duration::ZERO)
}

/// Quit-safe only after taking the operation gate: every admitted operation must
/// call this once its turn arrives, so admission cannot race Quit. Callers may also
/// call it earlier to fail fast (for example before queueing), which is why it does
/// not assert `operation_gate::held()` (D-43).
pub(crate) fn ensure_accepting_operations() -> Result<(), String> {
    if QUITTING.load(Ordering::SeqCst) {
        Err("Silo is quitting and stopping its local VMs. Wait for shutdown to finish.".into())
    } else {
        Ok(())
    }
}

pub(crate) fn stop_local_vms(app: &AppHandle) -> Result<(), String> {
    let result = while_quitting(&OPERATIONS, |guard| {
        // Quit has stopped admission and holds the operation gate: the SSH monitor
        // cannot restore listeners while local VM shutdown is in progress.
        crate::ssh_access::close_all();
        crate::desktop_viewer::close_all();
        let paths = runtime_paths(app)?;
        // The quit overlay follows the queue and shows which VM is stopping (D-29).
        let progress = |name: &str, index: usize, total: usize| {
            guard.relabel(&format!("Stopping {name} ({index} of {total})"));
        };
        stop_local_vms_with(&ProcessRunner, &paths, &progress)
            .map_err(|error| safe_activity_error(&error))
    });
    let _ = app.emit("silo://application-state-changed", ());
    result
}

/// Run Quit's shutdown `work` holding the computer-wide gate.
fn while_quitting<T>(
    gate: &'static operation_gate::OperationGate,
    work: impl FnOnce(&operation_gate::OperationGuard<'static>) -> Result<T, String>,
) -> Result<T, String> {
    // Admission is already refused, so any waiter would only be rejected when its turn
    // came. Cancel every waiting entry up front so Quit is not queued behind work that
    // can no longer start, and so the quit overlay reflects only the running blockers.
    gate.cancel_all_waiting();
    let guard = gate
        .kind(operation_gate::OperationKind::Shutdown)
        .computer("Stopping local sandboxes")
        .map_err(|_| {
            "A sandbox operation failed unexpectedly. Check local VM status before retrying Quit."
                .to_string()
        })?;
    let result = work(&guard);
    // Work that queued behind Quit was requested before its VMs stopped. If Quit
    // fails and admission reopens, it must not start a VM Quit just stopped (D-30),
    // so it leaves the queue before the gate is released.
    gate.cancel_all_waiting();
    drop(guard);
    result
}

/// Stop every present local VM. `progress` receives each VM that needs a stop with
/// its one-based position among them, before that VM's stop starts.
fn stop_local_vms_with(
    runner: &(dyn RuntimeRunner + Sync),
    paths: &RuntimePaths,
    progress: &dyn Fn(&str, usize, usize),
) -> Result<(), RuntimeError> {
    let committed = read_metadata(&paths.metadata)?.machines;
    let mut machines = committed.clone();
    for pending in configuration_recovery::shutdown_machines(paths)? {
        if !machines.iter().any(|machine| machine.id() == pending.id()) {
            machines.push(pending);
        }
    }
    if runtime_never_initialized(paths)
        || (!machines.iter().any(MachineConfiguration::is_vm) && !paths.home.exists())
    {
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
    let mut targets = Vec::new();
    for machine in machines
        .iter()
        .filter(|machine| machine.is_vm() && present.contains(machine.name()))
    {
        let committed_vm = committed.iter().any(|entry| entry.id() == machine.id());
        // A VM that is already stopped with no saved action needs no stop and
        // no "Sandbox stopped" activity entry. Anything else goes through
        // perform, which verifies identity and settles transitions.
        if committed_vm && !lifecycle_recovery::has_intent(paths, machine.id())
            && inspect_workspace(runner, paths, machine.name()).is_ok_and(|vm| matches!(
                vm.status.to_ascii_lowercase().as_str(), "stopped" | "created" | "crashed"))
        {
            continue;
        }
        targets.push((machine, committed_vm));
    }
    if !targets.is_empty() {
        // One cross-process worker flock covers the entire shutdown transaction.
        // Separate flock acquisitions in the workers would serialize every stop.
        let worker_lock = configuration_recovery::command_lock(paths, STOP_TIMEOUT)?;
        let locks = targets.iter().map(|_| worker_lock.duplicate_for_shutdown()).collect::<Result<Vec<_>, _>>()?;
        let host = &host;
        thread::scope(|scope| {
            let mut workers = Vec::new();
            for (index, ((machine, committed_vm), lock)) in targets.iter().zip(locks).enumerate() {
                progress(machine.name(), index + 1, targets.len());
                workers.push((machine.name(), scope.spawn(move || with_shutdown_worker_lock(lock, || {
                    // Every worker verifies ownership and immutable identity before
                    // stopping, while the parent retains the computer operation gate.
                    if *committed_vm {
                        checkpoints::release_paused_restore(runner, paths, machine);
                        lifecycle_recovery::perform(runner, paths, host, "stop", machine.name())
                    } else {
                        stop_uncommitted_vm(runner, paths, machine)
                    }
                }))));
            }
            for (name, worker) in workers {
                let result = worker.join().unwrap_or_else(|_| Err(RuntimeError::Unavailable("The shutdown worker failed unexpectedly.".into())));
                if let Err(error) = result {
                    failures.push(format!("{name}: {}", safe_activity_error(&error)));
                }
            }
        });
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

// Failed first-run recovery in older versions can leave a directory in place
// of the runtime alias. Only bypass the runtime when BOTH locations contain no
// runtime state, and no surviving command owns one of the bootstrap locks.
fn runtime_never_initialized(paths: &RuntimePaths) -> bool {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let Some(storage) = paths.storage_home.as_deref() else { return false; };
    let mut locks = Vec::new();
    for path in [&paths.home, storage] {
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata) if metadata.is_dir() => {}
            _ => return false,
        }
        let Ok(entries) = fs::read_dir(path) else { return false; };
        for entry in entries {
            let Ok(entry) = entry else { return false; };
            if !matches!(entry.file_name().to_str(), Some(".silo-configuration-worker.lock" | ".silo-backup-worker.lock")) {
                return false;
            }
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) { return false; }
            let Ok(file) = fs::OpenOptions::new().read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(entry.path()) else { return false; };
            // SAFETY: the open file owns the descriptor. Keep every lock until
            // both directories have been checked, without waiting on children.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return false; }
            locks.push(file);
        }
    }
    true
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
            "stopped" | "created" | "crashed" => return Ok(()),
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
        stop_barrier: Option<std::sync::Barrier>,
    }
    impl RuntimeRunner for Runner {
        fn run(
            &self,
            _: &RuntimePaths,
            args: &[String],
            _: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            self.calls.lock().unwrap().push(args.to_vec());
            if args[0] == "stop" {
                if let Some(barrier) = &self.stop_barrier { barrier.wait(); }
            }
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
            stop_barrier: None,
        }
    }
    #[test]
    fn work_queued_behind_a_failed_quit_does_not_run_when_it_releases_the_gate() {
        let gate: &'static operation_gate::OperationGate =
            Box::leak(Box::new(operation_gate::OperationGate::new()));
        let mut waiter = None;
        let result: Result<(), String> = while_quitting(gate, |_guard| {
            waiter = Some(std::thread::spawn(move || gate.vm("id-a", "a", "Starting a").map(drop)));
            let deadline = Instant::now() + Duration::from_secs(5);
            while gate.snapshot().waiting.is_empty() {
                assert!(Instant::now() < deadline, "the start never queued behind Quit");
                thread::sleep(Duration::from_millis(2));
            }
            Err("Some local VMs could not stop.".into())
        });
        assert!(result.is_err());
        assert_eq!(
            waiter.unwrap().join().unwrap(),
            Err(operation_gate::GateError::Cancelled)
        );
        assert!(gate.is_idle());
    }

    #[test]
    fn quit_accepts_crashed_vm_and_still_stops_running_vm() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        runner.states.lock().unwrap().insert("first".into(), "Crashed".into());
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
        assert_eq!(runner.states.lock().unwrap()["first"], "Crashed");
        assert_eq!(runner.states.lock().unwrap()["second"], "Stopped");
        let calls = runner.calls.lock().unwrap();
        assert!(!calls.iter().any(|args| args[0] == "stop" && args[1] == "first"));
        assert!(calls.iter().any(|args| args[0] == "stop" && args[1] == "second"));
        assert_eq!(read_metadata(&paths.metadata).unwrap().machines.len(), 2);
    }

    #[test]
    fn quit_reports_each_vm_it_stops_with_its_position() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        runner.states.lock().unwrap().insert("first".into(), "Stopped".into());
        let seen = Mutex::new(Vec::new());
        stop_local_vms_with(&runner, &paths, &|name, index, total| {
            // Reported before the stop starts.
            assert_eq!(runner.states.lock().unwrap()[name], "Running");
            seen.lock().unwrap().push((name.to_owned(), index, total));
        })
        .unwrap();
        assert_eq!(seen.into_inner().unwrap(), vec![("second".to_owned(), 1, 1)]);
    }

    #[test]
    fn quit_skips_already_stopped_vms_without_recording_a_stop() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        runner.states.lock().unwrap().insert("first".into(), "Stopped".into());
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
        let calls = runner.calls.lock().unwrap();
        assert!(!calls.iter().any(|args| args[0] == "stop" && args[1] == "first"));
        assert!(calls.iter().any(|args| args[0] == "stop" && args[1] == "second"));
        let history = runtime_activity::read(&paths).unwrap();
        assert!(!history.iter().any(|event| event["workspace"] == "first"));
        assert!(history.iter().any(|event| event["workspace"] == "second"));
    }

    #[test]
    fn quit_stops_and_verifies_each_local_vm_without_removing_it() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(None);
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
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
    fn quit_dispatches_all_stops_before_waiting_for_one_to_finish() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let mut runner = runner(None);
        runner.stop_barrier = Some(std::sync::Barrier::new(2));
        let (done, received) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let result = stop_local_vms_with(&runner, &paths, &|_, _, _| {});
            done.send((result, runtime_activity::read(&paths).unwrap())).unwrap();
        });
        let (result, history) = received.recv_timeout(Duration::from_secs(5))
            .expect("both stop commands must enter before either finishes");
        result.unwrap();
        assert!(history.iter().any(|event| event["workspace"] == "first"));
        assert!(history.iter().any(|event| event["workspace"] == "second"));
    }

    #[test]
    fn one_failed_stop_preserves_failure_and_still_stops_other_vms() {
        let dir = tempfile::tempdir().unwrap();
        let paths = setup(&dir);
        let runner = runner(Some("first"));
        let error = stop_local_vms_with(&runner, &paths, &|_, _, _| {})
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
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
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
        assert!(stop_local_vms_with(&runner, &paths, &|_, _, _| {}).is_err());
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
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
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
        let error = stop_local_vms_with(&runner, &paths, &|_, _, _| {})
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
        let error = stop_local_vms_with(&runner, &paths, &|_, _, _| {})
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
    fn quit_after_failed_first_setup_does_not_require_a_working_alias() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = setup(&dir);
        let pending = read_metadata(&paths.metadata).unwrap();
        fs::remove_file(&paths.metadata).unwrap();
        configuration_recovery::begin(&paths, &pending).unwrap();
        paths.storage_home = Some(dir.path().join("storage"));
        fs::create_dir(&paths.home).unwrap();
        fs::write(paths.home.join(".silo-configuration-worker.lock"), b"").unwrap();
        let runner = runner(None);
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
        assert_eq!(configuration_recovery::shutdown_machines(&paths).unwrap(), pending.machines);
    }

    #[test]
    fn bootstrap_shortcut_rejects_runtime_state_in_either_location() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = super::super::tests::paths(&dir);
        let storage = dir.path().join("storage");
        paths.storage_home = Some(storage.clone());
        for location in [&paths.home, &storage] {
            fs::create_dir_all(location).unwrap();
            let state = location.join("run");
            fs::create_dir(&state).unwrap();
            assert!(!runtime_never_initialized(&paths));
            fs::remove_dir(state).unwrap();
        }
        assert!(runtime_never_initialized(&paths));
    }

    #[test]
    fn bootstrap_shortcut_rejects_active_workers_and_symlinks() {
        use std::os::fd::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        let mut paths = super::super::tests::paths(&dir);
        paths.storage_home = Some(dir.path().join("storage"));
        fs::create_dir(&paths.home).unwrap();
        let lock_path = paths.home.join(".silo-configuration-worker.lock");
        let file = File::create(&lock_path).unwrap();
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
        assert!(!runtime_never_initialized(&paths));
        drop(file);
        assert!(runtime_never_initialized(&paths));
        fs::remove_file(&lock_path).unwrap();
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), &lock_path).unwrap();
        assert!(!runtime_never_initialized(&paths));
        fs::remove_file(lock_path).unwrap();
        fs::remove_dir(&paths.home).unwrap();
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), &paths.home).unwrap();
        assert!(!runtime_never_initialized(&paths));
    }

    #[test]
    fn empty_configuration_quits_without_needing_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let runner = runner(None);
        stop_local_vms_with(&runner, &paths, &|_, _, _| {}).unwrap();
        assert!(runner.calls.lock().unwrap().is_empty());
    }
}
