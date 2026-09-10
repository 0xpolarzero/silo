//! The journal records intent before side effects. Recovery retries copying, never
//! adopts an unverified output or overwrites a VM merely because its name matches.
use super::*;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    version: u32,
    id: String,
    archive: Archive,
    request: Request,
    cancelled: bool,
    terminal: Option<Terminal>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Backup {
        names: Vec<String>,
        machines: Vec<(String, String)>,
        running: Vec<(String, String)>,
    },
    Restore {
        name: String,
        source: Option<String>,
        id: Option<String>,
    },
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Terminal {
    outcome: String,
    title: String,
    message: String,
    detail: Option<String>,
    running: Vec<String>,
}
impl Journal {
    pub(super) fn is_pending(&self) -> bool {
        self.terminal.is_none()
    }
    pub(super) fn identity(&self) -> &str {
        &self.id
    }
    pub(super) fn backup(archive: Archive, names: Vec<String>) -> Self {
        Self {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            archive,
            request: Request::Backup {
                names,
                machines: vec![],
                running: vec![],
            },
            cancelled: false,
            terminal: None,
        }
    }
    pub(super) fn restore(archive: Archive, name: String, source: Option<String>) -> Self {
        Self {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            archive,
            request: Request::Restore {
                name,
                source,
                id: None,
            },
            cancelled: false,
            terminal: None,
        }
    }
    fn kind(&self) -> &'static str {
        match self.request {
            Request::Backup { .. } => "backup",
            Request::Restore { .. } => "restore",
        }
    }
    fn target(&self) -> Option<String> {
        match &self.request {
            Request::Restore { name, .. } => Some(name.clone()),
            _ => None,
        }
    }
    fn operation(&self) -> Operation {
        match &self.terminal {
            Some(result) => Operation::Result {
                operation: self.kind(),
                archive: self.archive.clone(),
                running_names: result.running.clone(),
                target_name: self.target(),
                outcome: match result.outcome.as_str() {
                    "success" => "success",
                    "cancelled" => "cancelled",
                    "restart-required" => "restart-required",
                    _ => "failed",
                },
                title: result.title.clone(),
                message: result.message.clone(),
                detail: result.detail.clone(),
            },
            None => Operation::Running {
                operation: self.kind(),
                archive: self.archive.clone(),
                running_names: vec![],
                target_name: self.target(),
                progress: 0,
                indeterminate: Some(true),
                phases: vec![Phase {
                    title: if self.cancelled {
                        "Finishing cancellation"
                    } else {
                        "Resuming interrupted operation"
                    }
                    .into(),
                    detail: "Checking saved progress before continuing.".into(),
                    tone: "running",
                }],
            },
        }
    }
}
fn journal_path(history: &Path) -> PathBuf {
    history.with_file_name("backup-operation.json")
}
fn write(history: &Path, journal: &Journal) -> Result<(), String> {
    let path = journal_path(history);
    let parent = path
        .parent()
        .ok_or("Missing operation storage directory.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, journal).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(&path).map_err(|e| e.to_string())?;
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}
pub(super) fn load(history: &Path) -> Result<Option<Journal>, String> {
    let bytes = match fs::read(journal_path(history)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Silo could not read interrupted backup work: {e}")),
    };
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|e| {
        format!("Silo could not read interrupted backup work. The saved file was preserved: {e}")
    })?;
    uuid::Uuid::parse_str(&journal.id).map_err(|_| "Invalid saved backup operation identity.")?;
    if journal.version != 1 || !Path::new(&journal.archive.archive_path).is_absolute() {
        return Err("Unsupported saved backup operation. The file was preserved.".into());
    }
    match &journal.request {
        Request::Backup {
            names,
            machines,
            running,
        } => {
            for name in names
                .iter()
                .chain(machines.iter().map(|(name, _)| name))
                .chain(running.iter().map(|(name, _)| name))
            {
                runtime::validate_name(name).map_err(|e| e.to_string())?;
            }
        }
        Request::Restore { name, source, id } => {
            runtime::validate_name(name).map_err(|e| e.to_string())?;
            if let Some(source) = source {
                runtime::validate_name(source).map_err(|e| e.to_string())?;
            }
            if let Some(id) = id {
                uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(Some(journal))
}
pub(super) fn begin(controller: &Controller, journal: Journal) -> Result<(), String> {
    if let Some(error) = &controller
        .view
        .lock()
        .map_err(|_| "Backup state unavailable.")?
        .history_error
    {
        return Err(error.clone());
    }
    let mut saved = controller
        .journal
        .lock()
        .map_err(|_| "Saved operation unavailable.")?;
    if saved.as_ref().is_some_and(|j| j.terminal.is_none()) {
        return Err(
            "An interrupted operation still needs to finish. Relaunch Silo to resume it.".into(),
        );
    }
    write(&controller.history_path, &journal)?;
    *saved = Some(journal);
    Ok(())
}
fn update(controller: &Controller, change: impl FnOnce(&mut Journal)) -> Result<(), String> {
    let mut saved = controller
        .journal
        .lock()
        .map_err(|_| "Saved operation unavailable.")?;
    if let Some(journal) = saved.as_ref() {
        let mut next = journal.clone();
        change(&mut next);
        write(&controller.history_path, &next)?;
        *saved = Some(next);
    }
    Ok(())
}
pub(super) fn unresolved(controller: &Controller) -> Result<bool, String> {
    Ok(!controller.busy.load(Ordering::Acquire)
        && controller
            .journal
            .lock()
            .map_err(|_| "Saved operation unavailable.")?
            .as_ref()
            .is_some_and(Journal::is_pending))
}
pub(super) fn token(controller: &Controller) -> Result<Option<String>, String> {
    Ok(controller
        .journal
        .lock()
        .map_err(|_| "Saved operation unavailable.")?
        .as_ref()
        .map(|j| j.id.clone()))
}
fn cleanup_archive_partial(journal: &Journal) -> Result<(), String> {
    if !matches!(journal.request, Request::Backup { .. }) {
        return Ok(());
    }
    let parent = Path::new(&journal.archive.archive_path)
        .parent()
        .ok_or("Missing backup destination.")?;
    let prefix = format!(".silo-backup-{}-", journal.id);
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix)
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn save_sources(
    controller: &Controller,
    sources: &[backup::BackupSource],
) -> Result<(), String> {
    update(controller, |journal| {
        if let Request::Backup {
            machines, running, ..
        } = &mut journal.request
        {
            *machines = sources
                .iter()
                .filter_map(|s| {
                    s.machine_config
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|id| (s.name.clone(), id.into()))
                })
                .collect();
            *running = sources
                .iter()
                .filter(|s| s.was_running)
                .filter_map(|s| {
                    s.machine_config
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|id| (s.name.clone(), id.into()))
                })
                .collect();
        }
    })
}
pub(super) fn save_restore_identity(controller: &Controller, identity: &str) -> Result<(), String> {
    update(controller, |journal| {
        if let Request::Restore { id, .. } = &mut journal.request {
            *id = Some(identity.into());
        }
    })
}
pub(super) fn clear_restore_identity(controller: &Controller) -> Result<(), String> {
    update(controller, |journal| {
        if let Request::Restore { id, .. } = &mut journal.request {
            *id = None;
        }
    })
}
pub(super) fn claim_disk(directory: &Path, id: &str) -> Result<(), String> {
    let parent = directory
        .parent()
        .ok_or("Missing restored disk directory.")?;
    if directory.exists() {
        fs::remove_dir(directory)
            .map_err(|_| "Restored disk storage is occupied. No files were changed.".to_string())?;
    }
    let stage = tempfile::Builder::new()
        .prefix(&format!(".silo-restore-claim-{id}-"))
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(stage.path().join(".silo-restore-owner"))
        .map_err(|e| e.to_string())?;
    file.write_all(id.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::File::open(stage.path())
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(stage.path(), directory).map_err(|e| e.to_string())?;
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

pub(super) fn remove_disk_marker(directory: &Path) -> Result<(), String> {
    match fs::remove_file(directory.join(".silo-restore-owner")) {
        Ok(()) => fs::File::open(directory)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Could not finish restored disk ownership cleanup: {e}"
        )),
    }
}
pub(super) fn cancel(controller: &Controller) -> Result<(), String> {
    update(controller, |j| j.cancelled = true)
}
pub(super) fn dismiss(controller: &Controller) -> Result<(), String> {
    let mut saved = controller
        .journal
        .lock()
        .map_err(|_| "Saved operation unavailable.")?;
    if saved.as_ref().is_some_and(|j| j.terminal.is_none()) {
        return Ok(());
    }
    let path = journal_path(&controller.history_path);
    match fs::remove_file(&path) {
        Ok(()) => fs::File::open(path.parent().unwrap())
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not dismiss saved backup result: {e}")),
    }
    *saved = None;
    Ok(())
}

pub(super) fn complete(controller: &Controller, mut operation: Operation) -> Operation {
    let cleanup_pending = controller
        .journal
        .lock()
        .ok()
        .and_then(|journal| {
            journal
                .as_ref()
                .map(|j| matches!(&j.request, Request::Restore { id: Some(_), .. }))
        })
        .unwrap_or(false);
    if cleanup_pending {
        if let Operation::Result {
            outcome, message, ..
        } = &mut operation
        {
            if !matches!(*outcome, "success" | "restart-required") {
                message
                    .push_str(" Saved progress was preserved. Relaunch Silo to finish recovery.");
                return operation;
            }
        }
    }
    if let Operation::Result {
        archive,
        outcome,
        title,
        message,
        detail,
        running_names,
        ..
    } = &operation
    {
        if let Err(error) = update(controller, |j| {
            j.archive = archive.clone();
            j.terminal = Some(Terminal {
                outcome: (*outcome).into(),
                title: title.clone(),
                message: message.clone(),
                detail: detail.clone(),
                running: running_names.clone(),
            });
        }) {
            if let Operation::Result {
                outcome,
                title,
                message,
                ..
            } = &mut operation
            {
                *outcome = "failed";
                *title = "Could not save the operation result".into();
                *message = format!("{error} Silo will check the output again on next launch.");
            }
        }
    }
    operation
}
pub(super) fn resume(
    app: AppHandle,
    controller: Arc<Controller>,
    journal: Journal,
) -> Result<(), String> {
    set_operation(&controller, journal.operation())?;
    if journal.terminal.is_some() {
        return Ok(());
    }
    controller.busy.store(true, Ordering::Release);
    let cancellation = backup::Cancellation::default();
    controller
        .view
        .lock()
        .map_err(|_| "Backup state unavailable.")?
        .cancellation = Some(cancellation.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let result = recover(&app, &controller, &journal, &cancellation);
        match result {
            Ok(true) => {
                let journal = controller
                    .journal
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or(journal);
                let operation = Operation::Result {
                    operation: journal.kind(),
                    archive: journal.archive.clone(),
                    target_name: journal.target(),
                    running_names: vec![],
                    outcome: if journal.cancelled {
                        "cancelled"
                    } else {
                        "success"
                    },
                    title: if journal.cancelled {
                        "Operation cancelled"
                    } else {
                        "Operation complete"
                    }
                    .into(),
                    message: if journal.cancelled {
                        "The interrupted operation was cancelled safely."
                    } else {
                        "Silo verified the completed operation after relaunch."
                    }
                    .into(),
                    detail: None,
                };
                let operation = complete(&controller, operation);
                let _ = set_operation(&controller, operation);
                finish(&controller);
                publish(&app, &controller);
            }
            Ok(false) => match journal.request {
                Request::Backup { names, .. } => run_backup(
                    app,
                    controller,
                    PathBuf::from(&journal.archive.archive_path),
                    names,
                    cancellation,
                    journal.archive,
                ),
                Request::Restore { name, source, .. } => run_restore(
                    app,
                    controller,
                    PathBuf::from(&journal.archive.archive_path),
                    name,
                    source,
                    cancellation,
                    journal.archive,
                ),
            },
            Err(error) => {
                // Retain the pending checkpoint: never discard ownership after an
                // uncertain cleanup. The next launch may safely retry recovery.
                let _ = set_operation(
                    &controller,
                    Operation::Result {
                        operation: journal.kind(),
                        archive: journal.archive.clone(),
                        target_name: journal.target(),
                        running_names: vec![],
                        outcome: "failed",
                        title: "Could not resume the interrupted operation".into(),
                        message: error,
                        detail: Some(
                            "Saved progress was preserved. Relaunch Silo to retry.".into(),
                        ),
                    },
                );
                finish(&controller);
                publish(&app, &controller);
            }
        }
    });
    Ok(())
}
fn recover(
    app: &AppHandle,
    controller: &Controller,
    journal: &Journal,
    cancellation: &backup::Cancellation,
) -> Result<bool, String> {
    let paths = runtime::runtime_paths(app)?;
    recover_at_paths(&paths, controller, journal, cancellation)
}
pub(super) fn recover_at_paths(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    journal: &Journal,
    cancellation: &backup::Cancellation,
) -> Result<bool, String> {
    let _guard = runtime::MUTATION_LOCK
        .lock()
        .map_err(|_| "Sandbox operations unavailable.")?;
    let _command = backup::wait_for_interrupted_command(&paths.home, Duration::from_secs(60))
        .map_err(|e| e.to_string())?;
    // A cleanup `remove` from the previous process uses the general runtime
    // worker lock. Drain it before inspecting disks, then release before cleanup.
    drop(
        runtime::configuration_recovery::command_lock(paths, Duration::from_secs(60))
            .map_err(|e| e.to_string())?,
    );
    controller
        .service
        .cleanup_interrupted_staging()
        .map_err(|e| format!("Could not clear interrupted working files: {e}"))?;
    cleanup_archive_partial(journal)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
    match &journal.request {
        Request::Backup {
            machines,
            running,
            names,
        } => {
            for (name, id) in machines {
                if !metadata
                    .machines
                    .iter()
                    .any(|m| m.name() == name && m.id() == id)
                {
                    return Err(format!("Sandbox {name} changed since backup started. Its current state was preserved."));
                }
            }
            for (name, id) in running {
                if !metadata
                    .machines
                    .iter()
                    .any(|m| m.name() == name && m.id() == id)
                {
                    return Err(format!("Sandbox {name} changed since backup started. Its current state was preserved."));
                }
                let vm = inspect(&paths, name)?;
                if vm
                    .config
                    .pointer("/labels/silo.machine-id")
                    .and_then(Value::as_str)
                    != Some(id)
                {
                    return Err(format!(
                        "Sandbox {name} changed ownership. Its current state was preserved."
                    ));
                }
                if vm.status != "Running" {
                    runtime::run_msb(
                        &paths,
                        &["start".into(), name.clone()],
                        Duration::from_secs(60),
                    )
                    .map_err(|e| e.to_string())?;
                    if inspect(&paths, name)?.status != "Running" {
                        return Err(format!(
                            "Sandbox {name} did not restart. Saved backup progress was preserved."
                        ));
                    }
                }
            }
            let path = Path::new(&journal.archive.archive_path);
            if path.exists() {
                let checked = controller
                    .service
                    .inspect_archive(path, cancellation)
                    .map_err(|e| e.to_string())?;
                if checked.sandboxes != *names {
                    return Err("The archive at the saved destination contains different sandboxes. It was preserved.".into());
                }
                let archive = archive_from(path, &checked);
                record_archive(controller, &archive)?;
                update(controller, |j| {
                    j.archive = archive;
                    j.cancelled = false;
                })?;
                return Ok(true);
            }
            Ok(journal.cancelled)
        }
        Request::Restore { name, id, .. } => {
            if let Some(id) = id {
                if let Some(machine) = metadata.machines.iter().find(|m| m.name() == name) {
                    if machine.id() != id {
                        return Err(format!(
                            "A different sandbox owns {name}. It was preserved."
                        ));
                    }
                    let vm = inspect(&paths, name)?;
                    runtime::ensure_managed(&vm).map_err(|e| e.to_string())?;
                    if vm
                        .config
                        .pointer("/labels/silo.machine-id")
                        .and_then(Value::as_str)
                        != Some(id)
                    {
                        return Err(
                            "The restored sandbox changed ownership. It was preserved.".into()
                        );
                    }
                    if !matches!(vm.status.as_str(), "Created" | "Stopped" | "Running") {
                        return Err(format!(
                            "The restored sandbox is in state {}. Saved progress was preserved.",
                            vm.status
                        ));
                    }
                    backup_volumes(&paths, machine, &vm)?;
                    remove_disk_marker(&paths.volumes.join(name))?;
                    update(controller, |j| j.cancelled = false)?;
                    return Ok(true);
                }
                let disk = paths.volumes.join(name);
                if disk.exists() {
                    let owner = fs::read_to_string(disk.join(".silo-restore-owner"));
                    if owner.as_deref().ok() == Some(id.as_str()) {
                        cleanup_restored(&paths, name, id)?;
                        clear_restore_identity(controller)?;
                    } else if fs::remove_dir(&disk).is_err() {
                        return Err(format!("Could not verify ownership of incomplete storage for {name}. No files were removed."));
                    }
                }
            }
            clear_restore_identity(controller)?;
            Ok(journal.cancelled)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{completed_archive, history_controller};
    use super::*;

    #[test]
    fn an_old_dismissal_cannot_clear_an_identical_later_restore_result() {
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let result = || Operation::Result {
            operation: "restore",
            archive: completed_archive(),
            target_name: Some("restored".into()),
            running_names: vec![],
            outcome: "success",
            title: "Restore complete".into(),
            message: "Sandbox restored successfully.".into(),
            detail: None,
        };
        begin(
            &controller,
            Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        let old_id = token(&controller).unwrap().unwrap();
        complete(&controller, result());
        begin(
            &controller,
            Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        complete(&controller, result());
        set_operation(&controller, result()).unwrap();
        assert!(!super::super::dismiss_finished_operation(
            &controller,
            Some(&serde_json::to_value(result()).unwrap()),
            Some(&old_id)
        )
        .unwrap());
        assert!(controller.view.lock().unwrap().operation.is_some());
        let current_id = token(&controller).unwrap().unwrap();
        assert!(super::super::dismiss_finished_operation(
            &controller,
            Some(&serde_json::to_value(result()).unwrap()),
            Some(&current_id)
        )
        .unwrap());
    }

    #[test]
    fn failed_restore_with_unfinished_cleanup_keeps_ownership_until_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_identity(&controller, &uuid::Uuid::new_v4().to_string()).unwrap();
        let failure = || Operation::Result {
            operation: "restore",
            archive: completed_archive(),
            target_name: Some("restored".into()),
            running_names: vec![],
            outcome: "failed",
            title: "Restore failed".into(),
            message: "Cleanup failed".into(),
            detail: None,
        };
        let result = complete(&controller, failure());
        assert!(
            matches!(result, Operation::Result { message, .. } if message.contains("Relaunch Silo"))
        );
        assert!(load(&path).unwrap().unwrap().terminal.is_none());
        dismiss(&controller).unwrap();
        assert!(load(&path).unwrap().is_some());
        assert!(begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()])
        )
        .is_err());
        clear_restore_identity(&controller).unwrap();
        complete(&controller, failure());
        assert!(load(&path).unwrap().unwrap().terminal.is_some());
    }

    #[test]
    fn abandoned_archive_cleanup_only_removes_this_operations_files() {
        let directory = tempfile::tempdir().unwrap();
        let mut archive = completed_archive();
        archive.archive_path = directory
            .path()
            .join("saved.silo-backup")
            .to_string_lossy()
            .into_owned();
        let journal = Journal::backup(archive, vec!["dev".into()]);
        let owned = directory
            .path()
            .join(format!(".silo-backup-{}-partial", journal.id));
        let other = directory
            .path()
            .join(".silo-backup-other-operation-partial");
        fs::write(&owned, b"incomplete").unwrap();
        fs::write(&other, b"preserve").unwrap();
        fs::write(&journal.archive.archive_path, b"completed archive").unwrap();
        cleanup_archive_partial(&journal).unwrap();
        assert!(!owned.exists());
        assert_eq!(fs::read(other).unwrap(), b"preserve");
        assert_eq!(
            fs::read(&journal.archive.archive_path).unwrap(),
            b"completed archive"
        );
    }

    #[test]
    fn dismissing_a_terminal_result_survives_reload_but_pending_work_is_retained() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()]),
        )
        .unwrap();
        dismiss(&controller).unwrap();
        assert!(load(&path).unwrap().is_some());
        complete(
            &controller,
            Operation::Result {
                operation: "backup",
                archive: completed_archive(),
                running_names: vec![],
                target_name: None,
                outcome: "success",
                title: "Done".into(),
                message: "Done".into(),
                detail: None,
            },
        );
        dismiss(&controller).unwrap();
        assert!(load(&path).unwrap().is_none());
    }

    #[test]
    fn durable_intent_and_cancellation_survive_relaunch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        save_restore_identity(&controller, &id).unwrap();
        cancel(&controller).unwrap();
        let reloaded = load(&path).unwrap().unwrap();
        assert!(reloaded.cancelled);
        assert!(reloaded.terminal.is_none());
        assert!(
            matches!(reloaded.request, Request::Restore { id: Some(ref saved), ref name, .. } if saved == &id && name == "restored")
        );
        assert!(matches!(reloaded.operation(), Operation::Running { .. }));
        assert!(begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()])
        )
        .is_err());
    }

    #[test]
    fn result_is_durable_but_never_inferred_from_pending_progress() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()]),
        )
        .unwrap();
        assert!(matches!(
            load(&path).unwrap().unwrap().operation(),
            Operation::Running { .. }
        ));
        complete(
            &controller,
            Operation::Result {
                operation: "backup",
                archive: completed_archive(),
                target_name: None,
                running_names: vec!["dev".into()],
                outcome: "restart-required",
                title: "Backup complete; restart failed".into(),
                message: "Restart dev to continue.".into(),
                detail: None,
            },
        );
        assert!(
            matches!(load(&path).unwrap().unwrap().operation(), Operation::Result { outcome: "restart-required", running_names, .. } if running_names == ["dev"])
        );
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()]),
        )
        .unwrap();
    }

    #[test]
    fn failed_checkpoint_write_preserves_previous_intent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()]),
        )
        .unwrap();
        fs::remove_file(journal_path(&path)).unwrap();
        fs::create_dir(journal_path(&path)).unwrap();
        assert!(cancel(&controller).is_err());
        assert!(
            !controller
                .journal
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .cancelled
        );
    }

    #[test]
    fn malformed_and_future_checkpoints_are_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let saved = journal_path(&path);
        fs::write(&saved, b"broken").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read(&saved).unwrap(), b"broken");
        let mut journal = Journal::backup(completed_archive(), vec!["dev".into()]);
        journal.version = 99;
        write(&path, &journal).unwrap();
        assert!(load(&path).is_err());
        assert!(saved.is_file());
    }

    #[test]
    fn restore_marker_cleanup_allows_empty_disk_directory_to_be_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let disks = directory.path().join("restored");
        fs::create_dir(&disks).unwrap();
        claim_disk(&disks, "operation-id").unwrap();
        assert!(claim_disk(&disks, "different-operation").is_err());
        remove_disk_marker(&disks).unwrap();
        remove_disk_marker(&disks).unwrap();
        fs::remove_dir(&disks).unwrap();
        fs::create_dir(&disks).unwrap();
    }
}
