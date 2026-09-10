//! Update installation changes the app, never VM disks. Keep the original running
//! set durable before stopping anything, then restore only those exact identities.
use super::*;

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
    let bytes = match fs::read(path(paths)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Update recovery could not be read.".into()),
    };
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
        .any(|m| m.is_vm() && m.id() == machine.id && m.name() == machine.name)
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
    if !paths.metadata.exists() {
        return Ok(vec![]);
    }
    let metadata = read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    let mut result = vec![];
    for m in metadata.machines.iter().filter(|m| m.is_vm()) {
        let machine = RunningMachine {
            id: m.id().into(),
            name: m.name().into(),
        };
        let inspected = inspect_exact(runner, paths, &machine)?;
        match inspected.status.to_ascii_lowercase().as_str() {
            "running" => result.push(machine),
            "created" | "stopped" => (),
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
    running(&ProcessRunner, &runtime_paths(app)?).map(|v| v.into_iter().map(|m| m.name).collect())
}
/// Caller owns MUTATION_LOCK for the whole installation, including every stop.
pub(crate) fn prepare(app: &AppHandle, consent: bool) -> Result<(), String> {
    let paths = runtime_paths(app)?;
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
    })
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

/// Caller owns MUTATION_LOCK. Each success is persisted, making replay idempotent.
pub(crate) fn restore_locked(app: &AppHandle) -> Result<(), String> {
    let paths = runtime_paths(app)?;
    let host = host_resources().map_err(|e| e.to_string())?;
    restore_pending(&paths, |machine| {
        let inspected = inspect_exact(&ProcessRunner, &paths, machine)?;
        if !inspected.status.eq_ignore_ascii_case("running") {
            workspace_action_with(&ProcessRunner, &paths, &host, "start", &machine.name)
                .map_err(|e| safe_activity_error(&e))?;
        }
        Ok(())
    })
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
    let _guard = MUTATION_LOCK
        .lock()
        .map_err(|_| "Sandbox operations are unavailable.")?;
    let existed = load(&runtime_paths(app)?)?.is_some();
    restore_locked(app)?;
    Ok(existed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_journal_round_trips_and_rejects_duplicate_or_unknown_identity() {
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
    fn stop_requires_consent_and_persists_entire_running_set_before_first_action() {
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
        let dir = tempfile::tempdir().unwrap();
        let paths = super::super::tests::paths(&dir);
        stop_selected(&paths, &[], false, |_| panic!("no running machines")).unwrap();
        assert!(load(&paths).unwrap().is_some());
        restore_pending(&paths, |_| panic!("no machines to resume")).unwrap();
        assert!(load(&paths).unwrap().is_none());
    }
    #[test]
    fn replacement_runtime_identity_is_never_accepted() {
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
        let request: MachineConfigurationRequest = serde_json::from_value(json!({"schemaVersion":1,"machines":[{"kind":"vm","id":id,"name":"dev","cpus":2,"maxCPUs":2,"memoryGiB":2,"maxMemoryGiB":2,"workspaceStorageGiB":10,"runtimeStorageGiB":10}]})).unwrap();
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
