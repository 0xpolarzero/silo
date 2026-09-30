//! The journal records intent before side effects. After a relaunch, recovery
//! never repeats an export or import: it removes this operation's partial
//! output and reports what happened. It adopts only a verified export file or
//! an import whose sandbox was saved under the identity journaled for it.
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
        /// Unused: older builds stopped sandboxes for an export and listed them
        /// here to restart them. Kept (empty) so older builds can still read it.
        #[serde(default)]
        machines: Vec<(String, String)>,
        #[serde(default)]
        running: Vec<(String, String)>,
        /// Present when the export packages a stored checkpoint rather than the
        /// sandbox's current state. Absent in journals written before this field.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_id: Option<String>,
    },
    Restore {
        name: String,
        source: Option<String>,
        /// The new sandbox's id, saved before its checkpoint record and settings
        /// are written. A saved sandbox with this id means the import finished.
        id: Option<String>,
        /// The native snapshot group the import loaded, saved with `id`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        group: Option<String>,
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
    pub(super) fn backup(
        archive: Archive,
        names: Vec<String>,
        checkpoint_id: Option<String>,
    ) -> Self {
        Self {
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            archive,
            request: Request::Backup {
                names,
                machines: vec![],
                running: vec![],
                checkpoint_id,
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
                group: None,
            },
            cancelled: false,
            terminal: None,
        }
    }
    /// Whether startup should let this operation's recovery finish before
    /// other sandbox recovery and automatic starts. Only an import touches
    /// sandbox records; an export's recovery only checks files it wrote.
    pub(super) fn blocks_startup(&self) -> bool {
        matches!(self.request, Request::Restore { .. })
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
                running_names: Vec::new(),
                target_name: self.target(),
                outcome: match result.outcome.as_str() {
                    // Older builds reported a complete export whose sandbox did not
                    // restart as "restart-required"; exports no longer stop sandboxes.
                    "success" | "restart-required" => "success",
                    "cancelled" => "cancelled",
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
                // Recovery removes this operation's own output; it is short and
                // is not interrupted part-way.
                can_cancel: Some(false),
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
        Err(e) => return Err(format!("Silo could not read the interrupted export or import: {e}")),
    };
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|e| {
        format!("Silo could not read the interrupted export or import. The saved file was preserved: {e}")
    })?;
    validate(&journal)?;
    Ok(Some(journal))
}
/// The rules a saved journal must meet to be loaded. `begin` applies them too,
/// so Silo never saves a journal the next launch would refuse (E-51).
fn validate(journal: &Journal) -> Result<(), String> {
    uuid::Uuid::parse_str(&journal.id).map_err(|_| "Invalid saved backup operation identity.")?;
    if journal.version != 1 || !Path::new(&journal.archive.archive_path).is_absolute() {
        return Err("Unsupported saved export or import. The file was preserved.".into());
    }
    match &journal.request {
        Request::Backup {
            names,
            machines,
            running,
            ..
        } => {
            for name in names
                .iter()
                .chain(machines.iter().map(|(name, _)| name))
                .chain(running.iter().map(|(name, _)| name))
            {
                runtime::validate_name(name).map_err(|e| e.to_string())?;
            }
        }
        Request::Restore {
            name,
            source,
            id,
            group,
        } => {
            runtime::validate_name(name).map_err(|e| e.to_string())?;
            if let Some(source) = source {
                runtime::validate_name(source).map_err(|e| e.to_string())?;
            }
            if let Some(id) = id {
                uuid::Uuid::parse_str(id).map_err(|e| e.to_string())?;
            }
            if let Some(group) = group {
                validate_import_group(group)?;
            }
        }
    }
    Ok(())
}
/// The exact `silo-import-<32 hex>` form `BackupService::prepare_restore` creates.
fn validate_import_group(group: &str) -> Result<(), String> {
    let suffix = group.strip_prefix("silo-import-").unwrap_or_default();
    if suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("Invalid saved import snapshot group.".into())
    }
}
pub(super) fn begin(controller: &Controller, journal: Journal) -> Result<(), String> {
    if let Some(error) = &controller
        .view
        .lock()
        .map_err(|_| "Backup state unavailable.")?
        .journal_error
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
    validate(&journal)?;
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
    Ok(!controller.busy.load(Ordering::Acquire) && pending(controller)?)
}
/// Whether the saved journal still describes an unfinished operation,
/// regardless of whether this process currently holds the worker slot.
pub(super) fn pending(controller: &Controller) -> Result<bool, String> {
    Ok(controller
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
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        // An unplugged or renamed destination holds no partial file that this
        // process could reach; failing here would block recovery until the
        // drive returns (E-36).
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix)
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Journal the new sandbox's id and the loaded snapshot group before the
/// import writes its checkpoint record and settings (E-24).
pub(super) fn save_restore_identity(
    controller: &Controller,
    identity: &str,
    import_group: &str,
) -> Result<(), String> {
    uuid::Uuid::parse_str(identity).map_err(|_| "Invalid imported sandbox identity.")?;
    validate_import_group(import_group)?;
    update(controller, |journal| {
        if let Request::Restore { id, group, .. } = &mut journal.request {
            *id = Some(identity.into());
            *group = Some(import_group.into());
        }
    })
}
pub(super) fn clear_restore_identity(controller: &Controller) -> Result<(), String> {
    update(controller, |journal| {
        if let Request::Restore { id, group, .. } = &mut journal.request {
            *id = None;
            *group = None;
        }
    })
}
/// Remove what an import wrote before its settings were saved: the new
/// sandbox's checkpoint record. The loaded snapshot group stays in the
/// runtime's store (logged here) until native cleanup removes it (E-23).
pub(super) fn discard_uncommitted_import(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    identity: &str,
    import_group: Option<&str>,
) -> Result<(), String> {
    runtime::checkpoints::forget_removed(paths, identity).map_err(|e| e.to_string())?;
    if let Some(group) = import_group {
        eprintln!("Retained imported snapshot group {group} after an import that did not finish.");
    }
    clear_restore_identity(controller)
}
pub(super) fn cancel(controller: &Controller) -> Result<(), String> {
    update(controller, |j| j.cancelled = true)
}
/// Stop retrying an interrupted operation whose recovery failed. The journal
/// becomes a terminal failure so it can be dismissed; no files are removed.
pub(super) fn abandon(controller: &Controller) -> Result<(), String> {
    update(controller, |j| {
        if j.terminal.is_none() {
            j.terminal = Some(Terminal {
                outcome: "failed".into(),
                title: "Interrupted operation abandoned".into(),
                message: "Silo stopped retrying this interrupted export or import. Files it left were kept.".into(),
                detail: None,
                running: vec![],
            });
        }
    })
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
        Err(e) => return Err(format!("Could not dismiss the saved export or import result: {e}")),
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
            if *outcome != "success" {
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
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .cancellation = Some(cancellation.clone());
    let (kind, archive, target) = (journal.kind(), journal.archive.clone(), journal.target());
    let (outer_app, outer_controller) = (app.clone(), controller.clone());
    let work = move || {
        let operation = match recover(&app, &controller, &journal, &cancellation) {
            Ok(operation) => complete(&controller, operation),
            // Retain the journal: never discard ownership after an uncertain
            // cleanup. The next launch retries; dismissing abandons it (E-43).
            Err(error) => Operation::Result {
                operation: journal.kind(),
                archive: journal.archive.clone(),
                target_name: journal.target(),
                running_names: vec![],
                outcome: "failed",
                title: "Could not resume the interrupted operation".into(),
                message: error,
                detail: Some(
                    "Saved progress was preserved. Relaunch Silo to retry, or dismiss this to stop retrying. Dismissing keeps any files it left."
                        .into(),
                ),
            },
        };
        let _ = set_operation(&controller, operation);
        finish(&controller);
        publish(&app, &controller);
    };
    tauri::async_runtime::spawn_blocking(move || {
        if super::contain_worker_panic(&outer_controller, kind, &archive, target, work) {
            publish(&outer_app, &outer_controller);
        }
    });
    Ok(())
}
fn recover(
    app: &AppHandle,
    controller: &Controller,
    journal: &Journal,
    cancellation: &backup::Cancellation,
) -> Result<Operation, String> {
    let paths = runtime::runtime_paths(app)?;
    recover_at_paths(&paths, controller, journal, cancellation)
}
/// Settle an operation interrupted by a relaunch without repeating it (E-31):
/// remove this operation's partial output and return the result to report.
/// An error means cleanup is uncertain and the journal must be kept.
pub(super) fn recover_at_paths(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    journal: &Journal,
    cancellation: &backup::Cancellation,
) -> Result<Operation, String> {
    let _guard = runtime::OPERATIONS
        .computer("Recovering backup")
        .map_err(|_| "Sandbox operations unavailable.")?;
    runtime::prepare_runtime_home(&paths.home, paths.storage_home.as_deref())
        .map_err(|e| e.to_string())?;
    // A snapshot command from the previous process can outlive it while
    // writing into the working folder; let it finish before cleaning up.
    let _command = backup::wait_for_interrupted_command(&paths.home, Duration::from_secs(60))
        .map_err(|e| e.to_string())?;
    controller
        .service
        .cleanup_interrupted_staging()
        .map_err(|e| format!("Could not clear interrupted working files: {e}"))?;
    cleanup_archive_partial(journal)?;
    let result = |archive: Archive, outcome: &'static str, title: &str, message: &str, detail: Option<&str>| {
        Operation::Result {
            operation: journal.kind(),
            archive,
            running_names: vec![],
            target_name: journal.target(),
            outcome,
            title: title.into(),
            message: message.into(),
            detail: detail.map(Into::into),
        }
    };
    match &journal.request {
        Request::Backup { names, .. } => {
            let path = Path::new(&journal.archive.archive_path);
            if path.exists() {
                // The file appears only after it was written and verified;
                // check it again before reporting it as this export.
                return Ok(match controller.service.inspect_archive(path, cancellation) {
                    Ok(checked) if checked.sandboxes == *names => {
                        let archive = Archive {
                            checkpoint_name: journal.archive.checkpoint_name.clone(),
                            ..archive_from(path, &checked)
                        };
                        result(archive, "success", "Export complete", "Silo verified this export after relaunching.", None)
                    }
                    _ => result(
                        journal.archive.clone(),
                        "failed",
                        "Export interrupted",
                        "Silo closed before this export finished. The file it left could not be verified and was kept.",
                        Some("Export the sandbox again."),
                    ),
                });
            }
            Ok(if journal.cancelled {
                result(journal.archive.clone(), "cancelled", "Export cancelled", "The export was cancelled.", Some("No export file was saved."))
            } else {
                result(
                    journal.archive.clone(),
                    "failed",
                    "Export interrupted",
                    "Silo closed before this export finished.",
                    Some("No export file was saved. Export the sandbox again."),
                )
            })
        }
        Request::Restore { id, group, .. } => {
            if let Some(id) = id {
                let metadata = runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
                // Saved settings are the import's commit point.
                if metadata.machines.iter().any(|machine| machine.id() == id) {
                    return Ok(result(journal.archive.clone(), "success", "Import complete", "Silo verified this import after relaunching.", None));
                }
                discard_uncommitted_import(paths, controller, id, group.as_deref())?;
            }
            Ok(if journal.cancelled {
                result(journal.archive.clone(), "cancelled", "Import cancelled", "The import was cancelled.", Some("No sandbox was added."))
            } else {
                result(
                    journal.archive.clone(),
                    "failed",
                    "Import interrupted",
                    "Silo closed before this import finished.",
                    Some("No sandbox was added. Import the file again."),
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{completed_archive, history_controller};
    use super::*;

    /// Runtime paths in a temp dir whose `msb` does not exist: any runtime
    /// command recovery runs fails the test.
    fn temp_paths(directory: &Path) -> runtime::RuntimePaths {
        runtime::RuntimePaths {
            guest_image: directory.join("guest-image"),
            executable: directory.join("missing-msb"),
            home: directory.join("home"),
            storage_home: None,
            library: directory.join("library"),
            metadata: directory.join("machines.json"),
            volumes: directory.join("volumes"),
        }
    }

    fn export_to(directory: &Path) -> Archive {
        let mut archive = completed_archive();
        archive.destination = directory.join("exports").to_string_lossy().into_owned();
        archive.archive_path = directory
            .join("exports/dev-2026-09-29.silo-backup")
            .to_string_lossy()
            .into_owned();
        fs::create_dir_all(&archive.destination).unwrap();
        archive
    }

    fn result_of(operation: &Operation) -> (&'static str, String, String, Option<String>) {
        match operation {
            Operation::Result { outcome, title, message, detail, .. } => {
                (*outcome, title.clone(), message.clone(), detail.clone())
            }
            Operation::Running { .. } => panic!("recovery must report a result"),
        }
    }

    fn save_machine(paths: &runtime::RuntimePaths, name: &str, id: &str) {
        let request: runtime::MachineConfigurationRequest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "machines": [{"kind":"vm","id":id,"name":name,"cpus":1,"maxCPUs":1,"memoryGiB":1,"maxMemoryGiB":1,"workspaceStorageGiB":1,"runtimeStorageGiB":1}]
        }))
        .unwrap();
        runtime::write_metadata(&paths.metadata, &request).unwrap();
    }

    const IMPORT_GROUP: &str = "silo-import-0123456789abcdef0123456789abcdef";
    const IMPORT_MEMBER: &str = "silo-backup-0-1-2";

    #[test]
    fn relaunch_reports_an_interrupted_export_without_rerunning_it_or_starting_sandboxes() {
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let mut journal = Journal::backup(export_to(directory.path()), vec!["dev".into()], None);
        // Journals from older builds list sandboxes that were running when the
        // export began; relaunch used to start them again.
        let id = uuid::Uuid::new_v4().to_string();
        if let Request::Backup { machines, running, .. } = &mut journal.request {
            *machines = vec![("dev".into(), id.clone())];
            *running = vec![("dev".into(), id)];
        }
        let partial = Path::new(&journal.archive.destination).join(format!(".silo-backup-{}-partial", journal.id));
        fs::write(&partial, b"incomplete").unwrap();
        begin(&controller, journal.clone()).unwrap();
        let recovered =
            recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default()).unwrap();
        let (outcome, title, _message, detail) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("failed", "Export interrupted"));
        assert!(detail.unwrap().contains("No export file was saved"));
        assert!(!partial.exists());
        // The result is final: completing it leaves nothing to resume.
        complete(&controller, recovered);
        assert!(!pending(&controller).unwrap());
    }

    #[test]
    fn relaunch_reports_a_cancelled_export_and_keeps_an_unverifiable_file() {
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let mut journal = Journal::backup(export_to(directory.path()), vec!["dev".into()], None);
        journal.cancelled = true;
        let recovered =
            recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default()).unwrap();
        assert_eq!(result_of(&recovered).0, "cancelled");

        fs::write(&journal.archive.archive_path, b"not an export").unwrap();
        let recovered =
            recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default()).unwrap();
        let (outcome, title, message, _) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("failed", "Export interrupted"));
        assert!(message.contains("could not be verified"), "{message}");
        assert_eq!(fs::read(&journal.archive.archive_path).unwrap(), b"not an export");
    }

    #[test]
    fn recovery_settles_a_journal_from_before_a_runtime_migration_without_the_runtime() {
        // While the runtime migration blocks sandbox operations, the saved
        // settings may be unreadable and msb unusable. Recovery must still
        // settle the journal, since migration refuses to run while one is
        // pending (E-50). Older builds never journaled an import's identity.
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        fs::create_dir_all(&paths.metadata).unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        for journal in [
            Journal::backup(export_to(directory.path()), vec!["dev".into()], None),
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        ] {
            let recovered =
                recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default())
                    .unwrap();
            assert_eq!(result_of(&recovered).0, "failed");
        }
    }

    #[test]
    fn only_an_interrupted_import_holds_back_startup() {
        assert!(!Journal::backup(completed_archive(), vec!["dev".into()], None).blocks_startup());
        assert!(Journal::restore(completed_archive(), "copy".into(), None).blocks_startup());
    }

    #[test]
    fn relaunch_adopts_an_import_whose_sandbox_was_saved() {
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let id = uuid::Uuid::new_v4().to_string();
        begin(&controller, Journal::restore(completed_archive(), "copy".into(), Some("dev".into()))).unwrap();
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        runtime::checkpoints::import_pending_restore(&paths, &id, IMPORT_GROUP, IMPORT_MEMBER).unwrap();
        save_machine(&paths, "copy", &id);
        let journal = load(&controller.history_path).unwrap().unwrap();
        let recovered =
            recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default()).unwrap();
        let (outcome, title, ..) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("success", "Import complete"));
        assert!(paths.metadata.with_file_name("checkpoints").join(format!("{id}.json")).exists());
        complete(&controller, recovered);
        assert!(!pending(&controller).unwrap());
    }

    #[test]
    fn relaunch_forgets_an_import_that_was_never_saved() {
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let id = uuid::Uuid::new_v4().to_string();
        begin(&controller, Journal::restore(completed_archive(), "copy".into(), Some("dev".into()))).unwrap();
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        runtime::checkpoints::import_pending_restore(&paths, &id, IMPORT_GROUP, IMPORT_MEMBER).unwrap();
        // Another sandbox now uses the requested name; it is not this import's.
        save_machine(&paths, "copy", &uuid::Uuid::new_v4().to_string());
        let journal = load(&controller.history_path).unwrap().unwrap();
        let recovered =
            recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default()).unwrap();
        let (outcome, title, _message, detail) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("failed", "Import interrupted"));
        assert!(detail.unwrap().contains("No sandbox was added"));
        assert!(!paths.metadata.with_file_name("checkpoints").join(format!("{id}.json")).exists());
        assert_eq!(runtime::read_metadata(&paths.metadata).unwrap().machines.len(), 1);
        complete(&controller, recovered);
        assert!(!pending(&controller).unwrap());
    }

    #[test]
    fn relaunch_reports_an_import_interrupted_before_it_saved_anything() {
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let journal = Journal::restore(completed_archive(), "copy".into(), Some("dev".into()));
        let recovered =
            recover_at_paths(&paths, &controller, &journal, &backup::Cancellation::default()).unwrap();
        assert_eq!(result_of(&recovered).1, "Import interrupted");
        let mut cancelled = journal;
        cancelled.cancelled = true;
        let recovered =
            recover_at_paths(&paths, &controller, &cancelled, &backup::Cancellation::default()).unwrap();
        assert_eq!(result_of(&recovered).0, "cancelled");
    }

    #[test]
    fn a_saved_import_identity_and_group_survive_reload_and_are_validated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(&controller, Journal::restore(completed_archive(), "copy".into(), None)).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        assert!(matches!(
            load(&path).unwrap().unwrap().request,
            Request::Restore { id: Some(ref saved), group: Some(ref group), .. } if *saved == id && group == IMPORT_GROUP
        ));
        assert!(save_restore_identity(&controller, &id, "../outside").is_err());
        let mut journal = load(&path).unwrap().unwrap();
        if let Request::Restore { group, .. } = &mut journal.request {
            *group = Some("../outside".into());
        }
        write(&path, &journal).unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn a_journal_that_relaunch_could_not_read_is_never_saved() {
        // Whatever begin saves, load must accept; otherwise a crash would leave
        // a journal that blocks exports and imports on every launch (E-51).
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        let mut relative = completed_archive();
        relative.archive_path = "Downloads/dev.silo-backup".into();
        for journal in [
            Journal::restore(relative, "copy".into(), None),
            Journal::restore(completed_archive(), "copy".into(), Some("../dev".into())),
            Journal::restore(completed_archive(), "Bad Name".into(), None),
            Journal::backup(completed_archive(), vec!["../dev".into()], None),
        ] {
            assert!(begin(&controller, journal).is_err());
            assert!(!journal_path(&path).exists());
            assert!(token(&controller).unwrap().is_none());
        }
        begin(&controller, Journal::restore(completed_archive(), "copy".into(), Some("dev".into()))).unwrap();
        assert!(load(&path).unwrap().is_some());
    }

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
        assert!(
            !super::super::dismiss_finished_operation(
                &controller,
                Some(&serde_json::to_value(result()).unwrap()),
                Some(&old_id)
            )
            .unwrap()
        );
        assert!(controller.view.lock().unwrap().operation.is_some());
        let current_id = token(&controller).unwrap().unwrap();
        assert!(
            super::super::dismiss_finished_operation(
                &controller,
                Some(&serde_json::to_value(result()).unwrap()),
                Some(&current_id)
            )
            .unwrap()
        );
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
        save_restore_identity(&controller, &uuid::Uuid::new_v4().to_string(), IMPORT_GROUP).unwrap();
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
        assert!(
            begin(
                &controller,
                Journal::backup(completed_archive(), vec!["dev".into()], None)
            )
            .is_err()
        );
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
        let journal = Journal::backup(archive, vec!["dev".into()], None);
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
    fn archive_cleanup_treats_a_missing_destination_as_nothing_to_clean() {
        let directory = tempfile::tempdir().unwrap();
        let mut archive = completed_archive();
        archive.archive_path = directory
            .path()
            .join("unplugged")
            .join("saved.silo-backup")
            .to_string_lossy()
            .into_owned();
        let journal = Journal::backup(archive, vec!["dev".into()], None);
        cleanup_archive_partial(&journal).unwrap();
    }

    #[test]
    fn dismissing_a_terminal_result_survives_reload_but_pending_work_is_retained() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
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
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        cancel(&controller).unwrap();
        let reloaded = load(&path).unwrap().unwrap();
        assert!(reloaded.cancelled);
        assert!(reloaded.terminal.is_none());
        assert!(
            matches!(reloaded.request, Request::Restore { id: Some(ref saved), ref name, .. } if saved == &id && name == "restored")
        );
        assert!(matches!(reloaded.operation(), Operation::Running { .. }));
        assert!(
            begin(
                &controller,
                Journal::backup(completed_archive(), vec!["dev".into()], None)
            )
            .is_err()
        );
    }

    #[test]
    fn result_is_durable_but_never_inferred_from_pending_progress() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
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
                running_names: vec![],
                outcome: "success",
                title: "Export complete".into(),
                message: "Sandbox exported.".into(),
                detail: None,
            },
        );
        assert!(matches!(
            load(&path).unwrap().unwrap().operation(),
            Operation::Result { outcome: "success", .. }
        ));
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
    }

    #[test]
    fn a_saved_restart_required_result_from_an_older_silo_reads_as_a_completed_export() {
        // Older builds could end an export as "restart-required" (the export was
        // complete; a sandbox did not restart). That outcome no longer exists.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let mut journal = Journal::backup(completed_archive(), vec!["dev".into()], None);
        journal.terminal = Some(Terminal {
            outcome: "restart-required".into(),
            title: "Export complete; restart failed".into(),
            message: "The export is complete and verified, but a previously running sandbox did not restart.".into(),
            detail: Some("dev: start failed".into()),
            running: vec!["dev".into()],
        });
        write(&path, &journal).unwrap();
        let operation = load(&path).unwrap().unwrap().operation();
        let serialized = serde_json::to_value(&operation).unwrap();
        assert_eq!(serialized["outcome"], "success");
        assert_eq!(serialized["runningNames"], serde_json::json!([]));
    }

    #[test]
    fn failed_checkpoint_write_preserves_previous_intent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
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
        let mut journal = Journal::backup(completed_archive(), vec!["dev".into()], None);
        journal.version = 99;
        write(&path, &journal).unwrap();
        assert!(load(&path).is_err());
        assert!(saved.is_file());
    }
}
