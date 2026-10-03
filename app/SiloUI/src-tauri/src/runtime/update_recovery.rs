//! Update installation changes the app, never VM disks. Keep the original running
//! set durable before stopping anything, then restore only those exact identities.
use super::*;
use std::io::Read;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct RunningMachine {
    id: String,
    name: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    machines: Vec<RunningMachine>,
}
fn path(paths: &RuntimePaths) -> PathBuf {
    paths.metadata.with_file_name("update-resume.json")
}
fn save(paths: &RuntimePaths, machines: &[RunningMachine]) -> Result<(), String> {
    let destination = path(paths);
    let parent = destination
        .parent()
        .ok_or("Update recovery storage is unavailable.")?;
    fs::create_dir_all(parent).map_err(|_| "Update recovery storage could not be created.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Update recovery could not be saved.")?;
    serde_json::to_writer(
        &mut temporary,
        &Journal {
            version: 1,
            machines: machines.to_vec(),
        },
    )
    .map_err(|_| "Update recovery could not be encoded.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Update recovery could not be synced.")?;
    temporary
        .persist(&destination)
        .map_err(|_| "Update recovery could not be saved.")?;
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Update recovery could not be synced.".into())
}
fn load(paths: &RuntimePaths) -> Result<Option<Journal>, String> {
    let file = match File::open(path(paths)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Update recovery could not be read.".into()),
    };
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Update recovery could not be read.")?;
    if bytes.len() > 1024 * 1024 {
        return Err("Update recovery is invalid; it was preserved.".into());
    }
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|_| "Update recovery is invalid; it was preserved.")?;
    let mut ids = HashSet::new();
    if journal.version != 1
        || journal.machines.iter().any(|m| {
            uuid::Uuid::parse_str(&m.id).is_err()
                || validate_name(&m.name).is_err()
                || !ids.insert(&m.id)
        })
    {
        return Err("Update recovery is invalid; it was preserved.".into());
    }
    Ok(Some(journal))
}
fn inspect_exact(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
    machine: &RunningMachine,
) -> Result<InspectedSandbox, String> {
    let saved = read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    if !saved
        .machines
        .iter()
        .any(|m| m.id() == machine.id && m.name() == machine.name)
    {
        return Err(format!(
            "{} was removed or replaced. No replacement sandbox was changed.",
            machine.name
        ));
    }
    let inspected = inspect_workspace(runner, paths, &machine.name).map_err(|e| e.to_string())?;
    ensure_managed(&inspected).map_err(|e| e.to_string())?;
    if inspected.name != machine.name
        || inspected
            .config
            .pointer("/labels/silo.machine-id")
            .and_then(Value::as_str)
            != Some(&machine.id)
    {
        return Err(format!(
            "{} has a different identity. No replacement sandbox was changed.",
            machine.name
        ));
    }
    Ok(inspected)
}
fn running(
    runner: &dyn RuntimeRunner,
    paths: &RuntimePaths,
) -> Result<Vec<RunningMachine>, String> {
    let metadata = read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    let mut result = vec![];
    let mut listed: Option<HashSet<String>> = None;
    let unfinished: Vec<_> = configuration_recovery::shutdown_machines(paths)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|machine| {
            !metadata
                .machines
                .iter()
                .any(|saved| saved.id() == machine.id() && saved.name() == machine.name())
        })
        .collect();
    if !unfinished.is_empty() {
        let present: HashSet<_> = list_managed(runner, paths)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        if let Some(machine) = unfinished
            .iter()
            .find(|machine| present.contains(machine.name()))
        {
            return Err(format!("{} has unfinished sandbox configuration. Retry or correct its setup before updating.", machine.name()));
        }
        listed = Some(present);
    }
    for m in metadata.machines.iter() {
        // Unstarted forks, restores and imports have no runtime VM yet, so they
        // cannot be running and must not block updates.
        if checkpoints::pending_view(paths, m.id(), false).map_err(|e| e.to_string())? {
            if listed.is_none() {
                listed = Some(
                    list_managed(runner, paths)
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .map(|entry| entry.name)
                        .collect(),
                );
            }
            let exists = listed
                .as_ref()
                .is_some_and(|names| names.contains(m.name()));
            if checkpoints::pending_view(paths, m.id(), exists).map_err(|e| e.to_string())? {
                continue;
            }
        }
        let machine = RunningMachine {
            id: m.id().into(),
            name: m.name().into(),
        };
        let inspected = inspect_exact(runner, paths, &machine)?;
        match inspected.status.to_ascii_lowercase().as_str() {
            "running" => result.push(machine),
            "created" | "stopped" | "crashed" => (),
            _ => {
                return Err(format!(
                    "Wait until {} has finished its current action before updating.",
                    m.name()
                ))
            }
        }
    }
    Ok(result)
}
pub(crate) fn running_names(app: &AppHandle) -> Result<Vec<String>, String> {
    // An unfinished storage migration holds the runtime back: nothing is running, and
    // it must not stop an update from installing.
    let Some(paths) = runtime_paths_if_in_use(app)? else {
        return Ok(Vec::new());
    };
    running(&ProcessRunner, &paths).map(|v| v.into_iter().map(|m| m.name).collect())
}
/// Caller holds the operation gate (computer scope) for the whole installation,
/// including every stop.
pub(crate) fn prepare(app: &AppHandle, consent: bool) -> Result<(), String> {
    debug_assert!(
        operation_gate::held(),
        "update preparation requires the operation gate"
    );
    let Some(paths) = runtime_paths_if_in_use(app)? else {
        return Ok(());
    };
    if load(&paths)?.is_some() {
        return Err(
            "A previous update still has sandboxes to resume. Relaunch Silo before updating again."
                .into(),
        );
    }
    let machines = running(&ProcessRunner, &paths)?;
    let host = host_resources().map_err(|e| e.to_string())?;
    stop_selected(&paths, &machines, consent, |machine| {
        inspect_exact(&ProcessRunner, &paths, machine)?;
        workspace_action_with(&ProcessRunner, &paths, &host, "stop", &machine.name)
            .map_err(|e| safe_activity_error(&e))
    })?;
    // Only the saved running set resumes after the update; a saved action for any
    // other VM (for example a failed start kept for Retry) must not start it (D-22).
    let resuming = machines.into_iter().map(|machine| machine.id).collect();
    lifecycle_recovery::retire_except(&paths, &resuming).map_err(|e| e.to_string())
}
fn stop_selected(
    paths: &RuntimePaths,
    machines: &[RunningMachine],
    consent: bool,
    mut stop: impl FnMut(&RunningMachine) -> Result<(), String>,
) -> Result<(), String> {
    if !machines.is_empty() && !consent {
        return Err("Confirm stopping the running sandboxes before installing this update.".into());
    }
    save(paths, machines)?;
    for machine in machines {
        stop(machine)?;
    }
    Ok(())
}

/// Caller holds the operation gate. Each success is persisted, making replay idempotent.
pub(crate) fn restore_locked(app: &AppHandle) -> Result<(), String> {
    debug_assert!(
        operation_gate::held(),
        "update restore requires the operation gate"
    );
    let Some(paths) = runtime_paths_if_in_use(app)? else {
        return Ok(());
    };
    let host = host_resources().map_err(|e| e.to_string())?;
    restore_pending(&paths, |machine| {
        resume_unless_removed(&paths, machine, |machine| {
            let inspected = inspect_exact(&ProcessRunner, &paths, machine)?;
            if !inspected.status.eq_ignore_ascii_case("running") {
                workspace_action_with(&ProcessRunner, &paths, &host, "start", &machine.name)
                    .map_err(|e| safe_activity_error(&e))?;
            }
            Ok(())
        })
    })
}
/// A sandbox deleted after an update stopped it has nothing left to resume. Treat
/// it as resolved so a stale entry cannot block startup and every later update.
fn resume_unless_removed(
    paths: &RuntimePaths,
    machine: &RunningMachine,
    resume: impl FnOnce(&RunningMachine) -> Result<(), String>,
) -> Result<(), String> {
    let saved = read_saved_metadata(&paths.metadata)
        .map_err(|e| e.to_string())?
        .ok_or("Silo's sandbox configuration is missing. Update recovery was preserved; restore the configuration before retrying.")?;
    let configured = saved.machines.iter().any(|m| m.id() == machine.id);
    if !configured {
        return Ok(());
    }
    resume(machine)
}
fn restore_pending(
    paths: &RuntimePaths,
    mut resume: impl FnMut(&RunningMachine) -> Result<(), String>,
) -> Result<(), String> {
    let Some(mut journal) = load(paths)? else {
        return Ok(());
    };
    let mut failures = vec![];
    for machine in journal.machines.clone() {
        match resume(&machine) {
            Ok(()) => {
                journal.machines.retain(|m| m.id != machine.id);
                save(paths, &journal.machines)?;
            }
            Err(error) => failures.push(error),
        }
    }
    if !failures.is_empty() {
        return Err(failures.join("\n"));
    }
    fs::remove_file(path(paths)).map_err(|_| "Completed update recovery could not be cleared.")?;
    File::open(paths.metadata.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|_| "Completed update recovery could not be synced.".into())
}

pub(crate) fn recover(app: &AppHandle) -> Result<bool, String> {
    let _guard = OPERATIONS
        .computer("Resuming sandboxes after update")
        .map_err(|_| "Sandbox operations are unavailable.")?;
    let Some(paths) = runtime_paths_if_in_use(app)? else {
        return Ok(false);
    };
    let existed = load(&paths)?.is_some();
    restore_locked(app)?;
    Ok(existed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uncommitted_runtime_vm_blocks_update_without_replaying_configuration() {
        let _test_state = crate::test_support::global_state();
        struct Runtime {
            committed: Option<MachineConfiguration>,
        }
        impl RuntimeRunner for Runtime {
            fn run(
                &self,
                _: &RuntimePaths,
                args: &[String],
                _: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                let stdout = match args[0].as_str() {
                    "list" => json!([{"name":"unfinished"}]).to_string(),
                    "inspect" => {
                        let machine = self.committed.as_ref().unwrap();
                        assert_eq!(args[1], machine.name());
                        json!({"name":machine.name(),"status":"Stopped","config":{"labels":{"silo.managed":"true","silo.machine-id":machine.id()}}}).to_string()
                    }
                    _ => panic!("update inventory must not mutate VMs: {args:?}"),
                };
                Ok(CommandOutput {
                    stdout,
                    stderr: String::new(),
                })
            }
        }
        for has_committed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let paths = super::super::tests::paths(&dir);
            let mut request: MachineConfigurationRequest = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"id":uuid::Uuid::new_v4().to_string(),"name":"unfinished","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
            let committed = has_committed.then(|| {
                let mut machine = request.machines[0].clone();
                {
                    let MachineConfiguration { id, name, .. } = &mut machine;
                    *id = uuid::Uuid::new_v4().to_string();
                    *name = "committed".into();
                }
                machine
            });
            if let Some(machine) = &committed {
                let saved = MachineConfigurationRequest {
                    schema_version: 1,
                    machines: vec![machine.clone()],
                };
                write_metadata(&paths.metadata, &saved).unwrap();
                request.machines.push(machine.clone());
            }
            configuration_recovery::begin(&paths, &request).unwrap();
            let error = running(&Runtime { committed }, &paths).unwrap_err();
            assert!(error.contains("unfinished"), "{error}");
            assert_eq!(
                configuration_recovery::pending_request(&paths).unwrap(),
                Some(request)
            );
            assert!(!path(&paths).exists());
        }
    }

    #[test]
    fn unfinished_configuration_without_a_runtime_vm_does_not_block_update() {
        let _test_state = crate::test_support::global_state();
        struct EmptyRuntime;
        impl RuntimeRunner for EmptyRuntime {
            fn run(
                &self,
                _: &RuntimePaths,
                args: &[String],
                _: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                assert_eq!(args[0], "list");
                Ok(CommandOutput {
                    stdout: "[]".into(),
                    stderr: String::new(),
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let request = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"id":uuid::Uuid::new_v4().to_string(),"name":"unfinished","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
        configuration_recovery::begin(&paths, &request).unwrap();
        assert!(running(&EmptyRuntime, &paths).unwrap().is_empty());
    }

    #[test]
    fn update_journal_round_trips_and_rejects_duplicate_or_unknown_identity() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let machine = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "dev".into(),
        };
        save(&paths, std::slice::from_ref(&machine)).unwrap();
        assert_eq!(
            load(&paths).unwrap().unwrap().machines,
            vec![machine.clone()]
        );
        save(&paths, &[machine.clone(), machine]).unwrap();
        assert!(load(&paths).is_err());
        assert!(path(&paths).exists());
        fs::write(path(&paths), br#"{"version":2,"machines":[]}"#).unwrap();
        assert!(load(&paths).is_err());
    }
    #[test]
    fn completed_resume_is_not_repeated_after_process_interruption() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let first = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "first".into(),
        };
        let second = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "second".into(),
        };
        save(&paths, &[first, second.clone()]).unwrap();
        let interrupted = std::panic::catch_unwind(|| {
            restore_pending(&paths, |machine| {
                if machine.name == "second" {
                    panic!("simulated process interruption");
                }
                Ok(())
            })
        });
        assert!(interrupted.is_err());
        assert_eq!(load(&paths).unwrap().unwrap().machines, vec![second]);
        let mut resumed = vec![];
        restore_pending(&paths, |machine| {
            resumed.push(machine.name.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(resumed, vec!["second"]);
        assert!(!path(&paths).exists());
    }
    #[test]
    fn failed_resume_preserves_only_failed_identity_and_continues_others() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let first = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "first".into(),
        };
        let second = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "second".into(),
        };
        save(&paths, &[first.clone(), second]).unwrap();
        let mut calls = vec![];
        assert!(restore_pending(&paths, |machine| {
            calls.push(machine.name.clone());
            if machine.name == "first" {
                Err("start failed".into())
            } else {
                Ok(())
            }
        })
        .is_err());
        assert_eq!(calls, vec!["first", "second"]);
        assert_eq!(load(&paths).unwrap().unwrap().machines, vec![first]);
    }

    #[test]
    fn journal_large_input_memory_is_bounded() {
        const PROBE: &str = "SILO_TEST_UPDATE_JOURNAL_MEMORY_PROBE";
        if std::env::var_os(PROBE).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtime::update_recovery::tests::journal_large_input_memory_is_bounded",
                    "--nocapture",
                ])
                .env(PROBE, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed;"));
            return;
        }

        fn peak_bytes() -> u64 {
            // SAFETY: getrusage initializes the supplied rusage structure.
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) }, 0);
            #[cfg(target_os = "macos")]
            return usage.ru_maxrss as u64;
            #[cfg(not(target_os = "macos"))]
            return usage.ru_maxrss as u64 * 1024;
        }

        let directory = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&directory);
        let file = path(&paths);
        fs::File::create(&file)
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();
        let before = peak_bytes();
        assert!(
            matches!(load(&paths), Err(message) if message == "Update recovery is invalid; it was preserved.")
        );
        let extra = peak_bytes().saturating_sub(before);
        eprintln!("large update journal peak RSS increase: {extra} bytes");
        assert!(
            extra < 32 * 1024 * 1024,
            "oversized update journal allocated {extra} bytes"
        );
        assert_eq!(fs::metadata(&file).unwrap().len(), 128 * 1024 * 1024);
    }
    #[test]
    fn missing_metadata_preserves_the_update_resume_journal() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let machine = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "saved".into(),
        };
        save(&paths, &[machine]).unwrap();
        let before = fs::read(path(&paths)).unwrap();
        assert!(read_metadata(&paths.metadata).unwrap().machines.is_empty());
        let error = restore_pending(&paths, |machine| {
            resume_unless_removed(&paths, machine, |_| {
                panic!("unknown configuration must not start a VM")
            })
        })
        .unwrap_err();
        assert!(error.contains("configuration"), "{error}");
        assert_eq!(fs::read(path(&paths)).unwrap(), before);
        let empty = MachineConfigurationRequest {
            schema_version: 1,
            machines: vec![],
        };
        write_metadata(&paths.metadata, &empty).unwrap();
        restore_pending(&paths, |machine| {
            resume_unless_removed(&paths, machine, |_| {
                panic!("a confirmed removed VM must not start")
            })
        })
        .unwrap();
        assert!(!path(&paths).exists());
    }
    #[test]
    fn removed_sandbox_entries_are_resolved_instead_of_blocking_every_launch() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let kept = uuid::Uuid::new_v4().to_string();
        let request = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"id":kept,"name":"kept","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
        write_metadata(&paths.metadata, &request).unwrap();
        let removed = RunningMachine {
            id: uuid::Uuid::new_v4().to_string(),
            name: "removed".into(),
        };
        let kept = RunningMachine {
            id: kept,
            name: "kept".into(),
        };
        save(&paths, &[removed, kept]).unwrap();
        let mut resumed = vec![];
        restore_pending(&paths, |machine| {
            resume_unless_removed(&paths, machine, |machine| {
                resumed.push(machine.name.clone());
                Ok(())
            })
        })
        .unwrap();
        assert_eq!(resumed, vec!["kept"]);
        assert!(!path(&paths).exists());
    }

    #[test]
    fn unstarted_pending_sandbox_does_not_block_updates() {
        let _test_state = crate::test_support::global_state();
        struct NoRuntime;
        impl RuntimeRunner for NoRuntime {
            fn run(
                &self,
                _: &RuntimePaths,
                args: &[String],
                _: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                assert_eq!(
                    args[0], "list",
                    "a pending sandbox has no runtime VM to inspect"
                );
                Ok(CommandOutput {
                    stdout: "[]".into(),
                    stderr: String::new(),
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let id = uuid::Uuid::new_v4().to_string();
        let request = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"id":id,"name":"fork","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
        write_metadata(&paths.metadata, &request).unwrap();
        let mut record = checkpoints::Record::default();
        record.pending_checkpoint_restore = Some(checkpoints::PendingRestore {
            checkpoint_id: "c000000000000000000000000000000".into(),
            source_workspace: "dev".into(),
            state: "full".into(),
        });
        checkpoints::save(&paths, &id, &record).unwrap();
        assert!(running(&NoRuntime, &paths).unwrap().is_empty());
    }

    #[test]
    fn stop_requires_consent_and_persists_entire_running_set_before_first_action() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let machines = vec![
            RunningMachine {
                id: uuid::Uuid::new_v4().to_string(),
                name: "first".into(),
            },
            RunningMachine {
                id: uuid::Uuid::new_v4().to_string(),
                name: "second".into(),
            },
        ];
        assert!(stop_selected(&paths, &machines, false, |_| panic!(
            "must not stop without consent"
        ))
        .is_err());
        assert!(!path(&paths).exists());
        assert!(stop_selected(&paths, &machines, true, |_| {
            assert_eq!(load(&paths).unwrap().unwrap().machines, machines);
            Err("stop failed".into())
        })
        .is_err());
        assert_eq!(load(&paths).unwrap().unwrap().machines, machines);
    }
    #[test]
    fn empty_running_set_is_still_a_durable_update_recovery() {
        let _test_state = crate::test_support::global_state();
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        stop_selected(&paths, &[], false, |_| panic!("no running machines")).unwrap();
        assert!(load(&paths).unwrap().is_some());
        restore_pending(&paths, |_| panic!("no machines to resume")).unwrap();
        assert!(load(&paths).unwrap().is_none());
    }
    #[test]
    fn crashed_sandbox_does_not_block_update_but_transitions_and_unknown_states_do() {
        let _test_state = crate::test_support::global_state();
        struct Inspect(Value);
        impl RuntimeRunner for Inspect {
            fn run(
                &self,
                _: &RuntimePaths,
                args: &[String],
                _: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                assert_eq!(args[0], "inspect");
                Ok(CommandOutput {
                    stdout: self.0.to_string(),
                    stderr: String::new(),
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let id = uuid::Uuid::new_v4().to_string();
        let request = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"id":id,"name":"dev","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
        write_metadata(&paths.metadata, &request).unwrap();
        for status in [
            "Crashed", "Stopped", "Created", "Running", "Starting", "Draining", "Unknown",
        ] {
            let runner = Inspect(
                json!({"name":"dev","status":status,"config":{"labels":{"silo.managed":"true","silo.machine-id":id}}}),
            );
            let result = running(&runner, &paths);
            match status {
                "Crashed" | "Stopped" | "Created" => {
                    assert!(result.unwrap().is_empty(), "{status}")
                }
                "Running" => assert_eq!(result.unwrap()[0].name, "dev"),
                _ => assert!(result.is_err(), "{status}"),
            }
        }
    }

    #[test]
    fn replacement_runtime_identity_is_never_accepted() {
        let _test_state = crate::test_support::global_state();
        struct Inspect(Value);
        impl RuntimeRunner for Inspect {
            fn run(
                &self,
                _: &RuntimePaths,
                args: &[String],
                _: Duration,
            ) -> Result<CommandOutput, RuntimeError> {
                assert_eq!(args[0], "inspect");
                Ok(CommandOutput {
                    stdout: self.0.to_string(),
                    stderr: String::new(),
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        let id = uuid::Uuid::new_v4().to_string();
        let request: MachineConfigurationRequest = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"id":id,"name":"dev","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
        write_metadata(&paths.metadata, &request).unwrap();
        let runner = Inspect(
            json!({"name":"dev","status":"running","config":{"labels":{"silo.managed":"true","silo.machine-id":uuid::Uuid::new_v4().to_string()}}}),
        );
        assert!(inspect_exact(
            &runner,
            &paths,
            &RunningMachine {
                id,
                name: "dev".into()
            }
        )
        .unwrap_err()
        .contains("different identity"));
    }
}
