//! Durable desired state for explicit local VM actions. Detached runtime children
//! own MicroSandbox's transition/lifecycle guards, not Silo's command-worker lock.
use super::*;

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    StopPending,
    StartPending,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    machine_id: String,
    name: String,
    action: String,
    phase: Phase,
    event: runtime_activity::Event,
}
fn error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::Unavailable(message.into())
}
fn directory(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("lifecycle-operations")
}
fn path(paths: &RuntimePaths, id: &str) -> PathBuf {
    directory(paths).join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}
fn store(paths: &RuntimePaths, intent: &Intent) -> Result<(), RuntimeError> {
    let directory = directory(paths);
    fs::create_dir_all(&directory)
        .map_err(|_| error("Sandbox action progress could not be saved."))?;
    let mut file = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| error("Sandbox action progress could not be saved."))?;
    serde_json::to_writer(&mut file, intent)
        .map_err(|_| error("Sandbox action progress could not be encoded."))?;
    file.as_file()
        .sync_all()
        .map_err(|_| error("Sandbox action progress could not be synced."))?;
    file.persist(path(paths, &intent.machine_id))
        .map_err(|_| error("Sandbox action progress could not be saved."))?;
    File::open(&directory)
        .and_then(|f| f.sync_all())
        .map_err(|_| error("Sandbox action progress could not be synced."))?;
    File::open(directory.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|_| error("Sandbox action progress could not be synced."))
}
fn load(file: &Path) -> Result<Option<Intent>, RuntimeError> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("Saved sandbox action could not be read.")),
    };
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err(error("Saved sandbox action is too large."));
    }
    let intent: Intent = serde_json::from_slice(&bytes)
        .map_err(|_| error("Saved sandbox action is invalid; it was preserved."))?;
    if intent.version != 1
        || uuid::Uuid::parse_str(&intent.machine_id).is_err()
        || validate_name(&intent.name).is_err()
        || !matches!(intent.action.as_str(), "start" | "stop" | "restart")
        || (intent.action == "start" && intent.phase != Phase::StartPending)
        || (intent.action == "stop" && intent.phase != Phase::StopPending)
        || !runtime_activity::matches(&intent.event, &intent.action, &intent.name)
    {
        return Err(error("Saved sandbox action is invalid; it was preserved."));
    }
    Ok(Some(intent))
}
fn machine(paths: &RuntimePaths, name: &str) -> Result<MachineConfiguration, RuntimeError> {
    validate_name(name)?;
    let metadata = read_metadata(&paths.metadata)?;
    metadata
        .machines
        .into_iter()
        .find(|m| m.name() == name && m.is_vm())
        .ok_or_else(|| {
            error(format!(
                "Sandbox '{name}' is not a configured local VM. No action was performed."
            ))
        })
}
fn inspect(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    intent: &Intent,
) -> Result<InspectedSandbox, RuntimeError> {
    if machine(paths, &intent.name)?.id() != intent.machine_id {
        return Err(error("The sandbox was replaced. Its data was preserved."));
    }
    let value = inspect_workspace(runner, paths, &intent.name)?;
    ensure_managed(&value)?;
    if value.name != intent.name
        || value
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(&intent.machine_id)
    {
        return Err(error(
            "The sandbox identity changed. No action was performed on the replacement.",
        ));
    }
    Ok(value)
}
fn stable(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    intent: &Intent,
    mut value: InspectedSandbox,
) -> Result<InspectedSandbox, RuntimeError> {
    let deadline = Instant::now() + MUTATION_TIMEOUT;
    while matches!(
        value.status.to_ascii_lowercase().as_str(),
        "starting" | "stopping" | "draining"
    ) {
        if Instant::now() >= deadline {
            return Err(error("The previous sandbox action is still finishing. Its saved progress was preserved; retry shortly."));
        }
        thread::sleep(Duration::from_millis(100));
        value = inspect(runner, paths, intent)?;
    }
    Ok(value)
}
fn stopped(value: &InspectedSandbox) -> bool {
    matches!(
        value.status.to_ascii_lowercase().as_str(),
        "stopped" | "created"
    )
}
fn advance(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    intent: &mut Intent,
    initial: InspectedSandbox,
) -> Result<(), RuntimeError> {
    let mut observed = stable(runner, paths, intent, initial)?;
    loop {
        let reached = match intent.phase {
            Phase::StopPending => stopped(&observed),
            Phase::StartPending => observed.status.eq_ignore_ascii_case("running"),
        };
        if reached {
            if intent.action == "restart" && intent.phase == Phase::StopPending {
                intent.phase = Phase::StartPending;
                store(paths, intent)?;
                continue;
            }
            return Ok(());
        }
        let command = match intent.phase {
            Phase::StopPending if observed.status.eq_ignore_ascii_case("running") => "stop",
            Phase::StartPending
                if stopped(&observed) || observed.status.eq_ignore_ascii_case("crashed") =>
            {
                validate_inspected_resources(&intent.name, &observed.config, host)?;
                "start"
            }
            _ => {
                return Err(error(format!(
                    "{} is not ready for this action. Check its status and retry.",
                    intent.name
                )))
            }
        };
        // A surviving detached start can win the runtime's own transition guard.
        // Verify the desired state even when its duplicate command reports failure.
        let result = runner.run(
            paths,
            &[command.into(), intent.name.clone(), "--quiet".into()],
            if command == "stop" {
                STOP_TIMEOUT
            } else {
                MUTATION_TIMEOUT
            },
        );
        observed = stable(runner, paths, intent, inspect(runner, paths, intent)?)?;
        let reached = if command == "stop" {
            stopped(&observed)
        } else {
            observed.status.eq_ignore_ascii_case("running")
        };
        if !reached {
            result?;
            return Err(error(format!(
                "{} did not reach the {} state. Retry to continue the saved action.",
                intent.name,
                if command == "stop" {
                    "Stopped"
                } else {
                    "Running"
                }
            )));
        }
    }
}
fn settle(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    intent: &mut Intent,
    initial: InspectedSandbox,
) -> Result<(), RuntimeError> {
    runtime_activity::resume(paths, &mut intent.event).map_err(error)?;
    let result = advance(runner, paths, host, intent, initial);
    runtime_activity::finish(paths, &mut intent.event, &result).map_err(error)?;
    if result.is_ok() {
        fs::remove_file(path(paths, &intent.machine_id)).map_err(|_| error("The sandbox action completed, but its saved progress could not be cleared. Retry to verify it."))?;
        File::open(directory(paths))
            .and_then(|f| f.sync_all())
            .map_err(|_| error("Completed sandbox action progress could not be synced."))?;
    }
    result
}
pub(super) fn perform(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
    action: &str,
    name: &str,
) -> Result<(), RuntimeError> {
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(RuntimeError::Invalid(format!(
            "Unknown sandbox action '{action}'. No sandbox operation was performed."
        )));
    }
    let machine = machine(paths, name)?;
    let existing = load(&path(paths, machine.id()))?;
    if let Some(mut previous) = existing.clone().filter(|saved| saved.action != action) {
        let result = Err(RuntimeError::Invalid(format!(
            "Replaced by the requested {action} action."
        )));
        runtime_activity::finish(paths, &mut previous.event, &result).map_err(error)?;
    }
    let mut intent = if let Some(saved) = existing.filter(|saved| saved.action == action) {
        saved
    } else {
        Intent {
            version: 1,
            machine_id: machine.id().into(),
            name: name.into(),
            action: action.into(),
            phase: if action == "start" {
                Phase::StartPending
            } else {
                Phase::StopPending
            },
            event: runtime_activity::begin(paths, action, name).map_err(error)?,
        }
    };
    let initial = match inspect(runner, paths, &intent).and_then(|initial| {
        if matches!(action, "start" | "restart") {
            validate_inspected_resources(name, &initial.config, host)?;
        }
        Ok(initial)
    }) {
        Ok(initial) => initial,
        Err(failure) => {
            let result = Err(failure);
            runtime_activity::finish(paths, &mut intent.event, &result).map_err(error)?;
            return result;
        }
    };
    store(paths, &intent)?;
    settle(runner, paths, host, &mut intent, initial)
}
// Called only after configuration deletion verified this exact ID and removed
// it from saved metadata, including its crash-recovery path.
pub(super) fn forget_removed(
    paths: &RuntimePaths,
    machine: &MachineConfiguration,
) -> Result<(), RuntimeError> {
    let target = path(paths, machine.id());
    if let Some(mut intent) = load(&target)? {
        if intent.machine_id != machine.id() || intent.name != machine.name() {
            return Err(error(
                "Saved sandbox action has a different identity; it was preserved.",
            ));
        }
        runtime_activity::finish(
            paths,
            &mut intent.event,
            &Err(RuntimeError::Invalid(
                "Sandbox was removed before this action finished.".into(),
            )),
        )
        .map_err(error)?;
        fs::remove_file(target)
            .map_err(|_| error("Removed sandbox action progress could not be cleared."))?;
        File::open(directory(paths))
            .and_then(|f| f.sync_all())
            .map_err(|_| error("Removed sandbox action progress could not be synced."))?;
    }
    Ok(())
}
pub(crate) fn recover(app: &AppHandle) -> Result<HashSet<String>, String> {
    let paths = runtime_paths(app)?;
    let _guard = MUTATION_LOCK
        .lock()
        .map_err(|_| "Sandbox action recovery is busy.")?;
    let resources = host_resources().map_err(|e| e.to_string())?;
    let result = recover_with(&ProcessRunner, &paths, &resources);
    let _ = app.emit("silo://application-state-changed", ());
    result.map_err(|e| e.to_string())
}
fn recover_with(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    host: &HostResources,
) -> Result<HashSet<String>, RuntimeError> {
    let entries = match fs::read_dir(directory(paths)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashSet::new()),
        Err(_) => return Err(error("Saved sandbox actions could not be read.")),
    };
    let mut stopped_ids = HashSet::new();
    let mut failures = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| error("Saved sandbox actions could not be read."))?;
        if entry
            .path()
            .extension()
            .is_none_or(|extension| extension != "json")
        {
            continue;
        }
        let Some(mut intent) = load(&entry.path())? else {
            continue;
        };
        if entry.path() != path(paths, &intent.machine_id) {
            return Err(error("Saved sandbox action identity is invalid."));
        }
        let result = inspect(runner, paths, &intent)
            .and_then(|initial| settle(runner, paths, host, &mut intent, initial));
        match result {
            Ok(()) if intent.action == "stop" => {
                stopped_ids.insert(intent.machine_id);
            }
            Ok(()) => {}
            Err(failure) => {
                failures.push(format!(
                    "{}: {}",
                    intent.name,
                    safe_activity_error(&failure)
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(stopped_ids)
    } else {
        Err(error(failures.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    struct Fake {
        state: Mutex<String>,
        calls: Mutex<Vec<String>>,
        fail_start: bool,
        start_wins: bool,
        replaced: bool,
    }
    impl Fake {
        fn new(state: &str) -> Self {
            Self {
                state: Mutex::new(state.into()),
                calls: Mutex::new(vec![]),
                fail_start: false,
                start_wins: false,
                replaced: false,
            }
        }
        fn mutations(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|s| *s != "inspect")
                .cloned()
                .collect()
        }
    }
    impl RuntimeRunner for Fake {
        fn run(
            &self,
            _paths: &RuntimePaths,
            args: &[String],
            _timeout: Duration,
        ) -> Result<CommandOutput, RuntimeError> {
            let action = args[0].as_str();
            self.calls.lock().unwrap().push(action.into());
            if action == "start" {
                if !self.fail_start || self.start_wins {
                    *self.state.lock().unwrap() = "Running".into();
                }
                if self.fail_start {
                    return Err(error("Synthetic start interruption."));
                }
            }
            if action == "stop" {
                *self.state.lock().unwrap() = "Stopped".into();
            }
            Ok(CommandOutput {
                stdout: if action == "inspect" {
                    json!({"name":"dev","status":*self.state.lock().unwrap(),"config":{"labels":{"silo.managed":"true","silo.machine-id":if self.replaced {"different"} else {ID}},"resources":{"cpus":1,"max_cpus":1,"memory_mib":1024,"max_memory_mib":1024}}}).to_string()
                } else {
                    "null".into()
                },
                stderr: String::new(),
            })
        }
    }
    fn host() -> HostResources {
        HostResources {
            logical_cpus: 2,
            physical_memory_bytes: Some(4 * 1024 * 1024 * 1024),
        }
    }
    fn setup() -> (tempfile::TempDir, RuntimePaths, MachineConfiguration) {
        let dir = tempfile::tempdir().unwrap();
        let paths = RuntimePaths {
            executable: dir.path().join("msb"),
            library: dir.path().join("library"),
            home: dir.path().join("home"),
            storage_home: None,
            guest_image: dir.path().join("image"),
            metadata: dir.path().join("machines.json"),
            volumes: dir.path().join("volumes"),
        };
        let machine = MachineConfiguration::Vm {
            id: ID.into(),
            name: "dev".into(),
            cpus: 1,
            max_cpus: 1,
            memory_gib: 1,
            max_memory_gib: 1,
            workspace_storage_gib: 1,
            runtime_storage_gib: 1,
        };
        write_metadata(
            &paths.metadata,
            &MachineConfigurationRequest {
                schema_version: 1,
                machines: vec![machine.clone()],
            },
        )
        .unwrap();
        (dir, paths, machine)
    }
    fn pending(paths: &RuntimePaths, action: &str, phase: Phase) -> Intent {
        let value = Intent {
            version: 1,
            machine_id: ID.into(),
            name: "dev".into(),
            action: action.into(),
            phase,
            event: runtime_activity::begin(paths, action, "dev").unwrap(),
        };
        store(paths, &value).unwrap();
        value
    }
    #[test]
    fn restart_recovers_each_checkpoint_without_repeating_a_finished_stop_or_restart() {
        for (phase, state, commands) in [
            (Phase::StopPending, "Running", vec!["stop", "start"]),
            (Phase::StopPending, "Stopped", vec!["start"]),
            (Phase::StartPending, "Stopped", vec!["start"]),
            (Phase::StartPending, "Running", vec![]),
        ] {
            let (_dir, paths, _) = setup();
            let original = pending(&paths, "restart", phase);
            let event_before = serde_json::to_value(&original.event).unwrap();
            let runner = Fake::new(state);
            recover_with(&runner, &paths, &host()).unwrap();
            assert_eq!(runner.mutations(), commands);
            assert!(!path(&paths, ID).exists());
            let history = runtime_activity::read(&paths).unwrap();
            let event = history
                .iter()
                .find(|event| event["id"] == event_before["id"])
                .unwrap();
            assert_eq!(event["tone"], "success");
            assert_eq!(event["title"], "Sandbox restarted");
            assert_eq!(history.len(), 1);
            recover_with(&runner, &paths, &host()).unwrap();
            assert_eq!(runner.mutations(), commands);
        }
    }
    #[test]
    fn stop_is_resumed_and_returned_for_startup_exclusion_but_crashed_is_not_success() {
        let (_dir, paths, _) = setup();
        pending(&paths, "stop", Phase::StopPending);
        let runner = Fake::new("Running");
        assert_eq!(
            recover_with(&runner, &paths, &host()).unwrap(),
            HashSet::from([ID.into()])
        );
        assert_eq!(runner.mutations(), vec!["stop"]);
        let crashed = Fake::new("Crashed");
        assert!(perform(&crashed, &paths, &host(), "stop", "dev").is_err());
        assert!(path(&paths, ID).exists());
        assert!(crashed.mutations().is_empty());
    }
    #[test]
    fn failed_start_keeps_intent_and_same_session_retry_reuses_activity() {
        let (_dir, paths, _) = setup();
        let mut runner = Fake::new("Stopped");
        runner.fail_start = true;
        assert!(perform(&runner, &paths, &host(), "start", "dev").is_err());
        assert!(path(&paths, ID).exists());
        runner.fail_start = false;
        perform(&runner, &paths, &host(), "start", "dev").unwrap();
        assert!(!path(&paths, ID).exists());
        let history = runtime_activity::read(&paths).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["tone"], "success");
    }
    #[test]
    fn surviving_detached_start_can_win_without_being_restarted() {
        let (_dir, paths, _) = setup();
        pending(&paths, "start", Phase::StartPending);
        let mut runner = Fake::new("Stopped");
        runner.fail_start = true;
        runner.start_wins = true;
        recover_with(&runner, &paths, &host()).unwrap();
        assert_eq!(runner.mutations(), vec!["start"]);
        assert!(!path(&paths, ID).exists());
    }
    #[test]
    fn replacement_runtime_is_preserved_and_confirmed_deletion_retires_only_its_intent() {
        let (_dir, paths, machine) = setup();
        pending(&paths, "restart", Phase::StopPending);
        let mut runner = Fake::new("Running");
        runner.replaced = true;
        assert!(recover_with(&runner, &paths, &host()).is_err());
        assert!(runner.mutations().is_empty());
        assert!(path(&paths, ID).exists());
        forget_removed(&paths, &machine).unwrap();
        assert!(!path(&paths, ID).exists());
        assert!(recover_with(&runner, &paths, &host()).unwrap().is_empty());
    }
    #[test]
    fn explicit_new_action_settles_the_superseded_activity() {
        let (_dir, paths, _) = setup();
        pending(&paths, "restart", Phase::StartPending);
        perform(&Fake::new("Running"), &paths, &host(), "stop", "dev").unwrap();
        let history = runtime_activity::read(&paths).unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().any(|event| event["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("Replaced by"))));
        assert!(history.iter().all(|event| event["status"] == "completed"));
    }
    fn live_paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            executable: PathBuf::from(std::env::var("SILO_TEST_MSB").expect("set SILO_TEST_MSB")),
            library: PathBuf::from(
                std::env::var("SILO_TEST_LIBKRUNFW").expect("set SILO_TEST_LIBKRUNFW"),
            ),
            home: root.join("msb"),
            storage_home: None,
            guest_image: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/guest-image"),
            metadata: root.join("machines.json"),
            volumes: root.join("volumes"),
        }
    }
    #[test]
    #[ignore = "child of the explicitly requested disposable lifecycle recovery test"]
    fn lifecycle_recovery_crash_child() {
        let root = std::env::var("SILO_TEST_LIFECYCLE_ROOT").expect("missing isolated test root");
        let action =
            std::env::var("SILO_TEST_LIFECYCLE_ACTION").expect("missing isolated test action");
        assert!(matches!(action.as_str(), "start" | "stop"));
        let paths = live_paths(Path::new(&root));
        ProcessRunner
            .run(
                &paths,
                &[
                    action.clone(),
                    "lifecycle-recovery-test".into(),
                    "--quiet".into(),
                ],
                MUTATION_TIMEOUT,
            )
            .unwrap();
        let observed =
            inspect_workspace(&ProcessRunner, &paths, "lifecycle-recovery-test").unwrap();
        assert_eq!(
            observed.status,
            if action == "start" {
                "Running"
            } else {
                "Stopped"
            }
        );
        // Exit without executing the next journal checkpoint or Rust cleanup.
        std::process::exit(73);
    }
    #[test]
    #[ignore = "requires signed bundled runtime, guest image and hardware virtualization; uses only a disposable VM"]
    fn lifecycle_recovery_survives_real_worker_exit_without_repeating_restart() {
        let directory = tempfile::Builder::new()
            .prefix("silo-lifecycle-live-")
            .tempdir_in("/tmp")
            .unwrap();
        let paths = live_paths(directory.path());
        let name = "lifecycle-recovery-test";
        let host = host_resources().unwrap();
        let result = (|| -> Result<(), RuntimeError> {
            let machine = create_disposable_test_machine(&paths, name)?;
            perform(&ProcessRunner, &paths, &host, "start", name)?;
            let boot = || {
                ProcessRunner
                    .run(
                        &paths,
                        &[
                            "exec".into(),
                            name.into(),
                            "--no-tty".into(),
                            "--quiet".into(),
                            "--".into(),
                            "cat".into(),
                            "/proc/sys/kernel/random/boot_id".into(),
                        ],
                        READ_TIMEOUT,
                    )
                    .map(|output| output.stdout)
            };
            let first_boot = boot()?;
            let checkpoint = |action: &str, phase: Phase| -> Result<(), RuntimeError> {
                store(
                    &paths,
                    &Intent {
                        version: 1,
                        machine_id: machine.id().into(),
                        name: name.into(),
                        action: action.into(),
                        phase,
                        event: runtime_activity::begin(&paths, action, name).map_err(error)?,
                    },
                )
            };
            let exit_child = |action: &str| -> Result<(), RuntimeError> {
                let status = Command::new(
                    std::env::current_exe().map_err(|_| error("Cannot locate test executable."))?,
                )
                .args([
                    "runtime::lifecycle_recovery::tests::lifecycle_recovery_crash_child",
                    "--exact",
                    "--ignored",
                    "--test-threads=1",
                ])
                .env("SILO_TEST_LIFECYCLE_ROOT", directory.path())
                .env("SILO_TEST_LIFECYCLE_ACTION", action)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|_| error("Cannot launch isolated recovery worker."))?;
                if status.code() != Some(73) {
                    return Err(error("Isolated worker did not reach its crash checkpoint."));
                }
                Ok(())
            };
            checkpoint("restart", Phase::StopPending)?;
            exit_child("stop")?;
            recover_with(&ProcessRunner, &paths, &host)?;
            let restarted_boot = boot()?;
            if first_boot == restarted_boot {
                return Err(error("Recovered restart did not boot a new VM generation."));
            }
            checkpoint("restart", Phase::StartPending)?;
            recover_with(&ProcessRunner, &paths, &host)?;
            if boot()? != restarted_boot {
                return Err(error("Completed restart was repeated after recovery."));
            }
            checkpoint("stop", Phase::StopPending)?;
            if !recover_with(&ProcessRunner, &paths, &host)?.contains(machine.id()) {
                return Err(error(
                    "Recovered explicit stop was not excluded from automatic start.",
                ));
            }
            checkpoint("start", Phase::StartPending)?;
            exit_child("start")?;
            let child_boot = boot()?;
            recover_with(&ProcessRunner, &paths, &host)?;
            if boot()? != child_boot {
                return Err(error(
                    "Surviving detached start was restarted during recovery.",
                ));
            }
            if path(&paths, machine.id()).exists() {
                return Err(error(
                    "Successful lifecycle recovery left a pending journal.",
                ));
            }
            Ok(())
        })();
        let _ = ProcessRunner.run(
            &paths,
            &["stop".into(), name.into(), "--quiet".into()],
            STOP_TIMEOUT,
        );
        let removed = ProcessRunner.run(
            &paths,
            &[
                "remove".into(),
                name.into(),
                "--force".into(),
                "--quiet".into(),
            ],
            STOP_TIMEOUT,
        );
        let absent = list_managed(&ProcessRunner, &paths)
            .is_ok_and(|machines| machines.iter().all(|machine| machine.name != name));
        assert!(
            removed.is_ok() && absent,
            "Disposable lifecycle VM cleanup failed."
        );
        assert!(result.is_ok(), "{}", result.unwrap_err());
    }
}
