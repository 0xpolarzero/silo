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
        /// Saved before snapshot create; cleared after capture verification.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pending_capture: Option<ExportCapture>,
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
struct ExportCapture {
    workspace_id: String,
    group: String,
    member: String,
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
                pending_capture: None,
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
        Err(e) => {
            return Err(format!(
                "Silo could not read the interrupted export or import: {e}"
            ))
        }
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
    uuid::Uuid::parse_str(&journal.id).map_err(|_| "Invalid saved export operation identity.")?;
    if journal.version != 1 || !Path::new(&journal.archive.archive_path).is_absolute() {
        return Err("Unsupported saved export or import. The file was preserved.".into());
    }
    match &journal.request {
        Request::Backup {
            names,
            machines,
            running,
            pending_capture,
            ..
        } => {
            for name in names
                .iter()
                .chain(machines.iter().map(|(name, _)| name))
                .chain(running.iter().map(|(name, _)| name))
            {
                runtime::validate_name(name).map_err(|e| e.to_string())?;
            }
            if let Some(capture) = pending_capture {
                validate_export_capture(capture)?;
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
        Err("Invalid saved import checkpoint group.".into())
    }
}
fn validate_export_capture(capture: &ExportCapture) -> Result<(), String> {
    uuid::Uuid::parse_str(&capture.workspace_id).map_err(|_| "Invalid export capture identity.")?;
    runtime::validate_name(&capture.group)
        .map_err(|error| error.to_string())
        .or_else(|_| validate_import_group(&capture.group))?;
    let parts: Vec<_> = capture
        .member
        .strip_prefix("silo-backup-")
        .unwrap_or_default()
        .split('-')
        .collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Invalid saved export capture member.".into());
    }
    Ok(())
}

/// Save intent in the existing operation journal before an export capture writes
/// native data. A verified complete capture clears that intent.
pub(super) fn export_capture_intent(
    controller: &Controller,
    source: &backup::BackupSource,
    member: Option<&str>,
) -> Result<(), backup::BackupError> {
    let capture = member.map(|member| ExportCapture {
        workspace_id: source.machine_config["id"]
            .as_str()
            .unwrap_or_default()
            .into(),
        group: source.snapshot_group.clone(),
        member: member.into(),
    });
    if let Some(capture) = &capture {
        validate_export_capture(capture).map_err(backup::BackupError::InvalidRequest)?;
    }
    update(controller, |journal| {
        if let Request::Backup {
            pending_capture, ..
        } = &mut journal.request
        {
            *pending_capture = capture;
        }
    })
    .map_err(backup::BackupError::InvalidRequest)
}

pub(super) fn settle_export_capture(
    runner: &dyn runtime::RuntimeRunner,
    paths: &runtime::RuntimePaths,
    controller: &Controller,
) -> Result<(), String> {
    let capture = controller
        .journal
        .lock()
        .map_err(|_| "Saved operation unavailable.")?
        .as_ref()
        .and_then(|journal| match &journal.request {
            Request::Backup {
                pending_capture, ..
            } => pending_capture.clone(),
            _ => None,
        });
    let Some(capture) = capture else {
        return Ok(());
    };
    if !runtime::checkpoints::discard_failed_capture(
        runner,
        paths,
        &capture.workspace_id,
        (capture.group.clone(), capture.member.clone()),
    ) && !controller
        .service
        .export_capture_ready(&capture.group, &capture.member)
        .map_err(|error| error.to_string())?
    {
        return Err(format!("The incomplete export capture {}:{} could not be removed. Its cleanup progress was kept.", capture.group, capture.member));
    }
    update(controller, |journal| {
        if let Request::Backup {
            pending_capture, ..
        } = &mut journal.request
        {
            *pending_capture = None;
        }
    })
}

pub(super) fn begin(controller: &Controller, journal: Journal) -> Result<(), String> {
    if let Some(error) = &controller
        .view
        .lock()
        .map_err(|_| "Export and import status could not be read. Relaunch Silo and retry.")?
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
        .ok_or("Missing export destination.")?;
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

/// Own the new group and its suffix as the deterministic `--stage-id` before
/// `snapshot load` writes any native data. The new
/// sandbox's identity is added later, before its checkpoint record is saved.
pub(super) fn save_restore_group(
    controller: &Controller,
    import_group: &str,
) -> Result<(), String> {
    validate_import_group(import_group)?;
    update(controller, |journal| {
        if let Request::Restore { group, .. } = &mut journal.request {
            *group = Some(import_group.into());
        }
    })
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
/// sandbox's checkpoint record and the loaded snapshot group (E-23, E-24).
/// The identity stays journaled until both are gone, so a failure here is
/// retried on the next launch.
pub(super) fn discard_uncommitted_import(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    identity: &str,
    import_group: Option<&str>,
) -> Result<(), String> {
    runtime::checkpoints::forget_removed(paths, identity).map_err(|e| e.to_string())?;
    if let Some(group) = import_group {
        controller
            .service
            .discard_import_group(group)
            .map_err(|error| {
                format!("Silo could not remove the unfinished import {group}: {error}")
            })?;
    }
    clear_restore_identity(controller)
}
/// Includes a load interrupted before Silo allocated the sandbox identity.
/// Only the journaled group and its two deterministic stage roots are removed.
/// Unrelated stages, including older random stages, stay untouched at relaunch.
pub(super) fn discard_pending_import(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
) -> Result<(), String> {
    let saved = controller
        .journal
        .lock()
        .map_err(|_| "Saved operation unavailable.")?
        .as_ref()
        .and_then(|journal| match &journal.request {
            Request::Restore { id, group, .. } => Some((id.clone(), group.clone())),
            _ => None,
        });
    let Some((id, group)) = saved else {
        return Ok(());
    };
    if let Some(id) = id {
        return discard_uncommitted_import(paths, controller, &id, group.as_deref());
    }
    if let Some(group) = group {
        controller
            .service
            .discard_import_group(&group)
            .map_err(|error| {
                format!("Silo could not remove the unfinished import {group}: {error}")
            })?;
        clear_restore_identity(controller)?;
    }
    Ok(())
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
        Err(e) => {
            return Err(format!(
                "Could not dismiss the saved export or import result: {e}"
            ))
        }
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
            journal.as_ref().map(|j| {
                matches!(
                    &j.request,
                    Request::Restore { id: Some(_), .. }
                        | Request::Restore { group: Some(_), .. }
                        | Request::Backup {
                            pending_capture: Some(_),
                            ..
                        }
                )
            })
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
    // The storage migration refuses to start while a journal is pending (E-50), so an
    // interrupted operation settles before it. Until the migration finishes, the
    // previous generation is a pre-upgrade backup: nothing may start `msb` against it
    // or write to it, so the operation is settled without the runtime.
    if crate::runtime_migration::blocks_operations(app) {
        let paths = runtime::inert_runtime_paths(app)?;
        return settle_before_migration(&paths, controller, journal, cancellation);
    }
    recover_at_paths(
        &runtime::runtime_paths(app)?,
        controller,
        journal,
        cancellation,
    )
}

/// The result of an interrupted operation. `archive` is the file the result names.
fn settled(
    journal: &Journal,
    archive: Archive,
    outcome: &'static str,
    title: &str,
    message: &str,
    detail: Option<&str>,
) -> Operation {
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
}

/// The file an interrupted export left at its destination, if any. It appears only
/// after it was written and verified, so it is kept whatever it holds; a file that
/// verifies again as this export is reported as complete.
fn left_export(
    journal: &Journal,
    names: &[String],
    controller: &Controller,
    cancellation: &backup::Cancellation,
    interrupted: &str,
) -> Option<Operation> {
    let path = Path::new(&journal.archive.archive_path);
    if !path.exists() {
        return None;
    }
    Some(match controller.service.inspect_archive(path, cancellation) {
        Ok(checked) if checked.sandboxes == *names => {
            let archive = Archive {
                checkpoint_name: journal.archive.checkpoint_name.clone(),
                ..archive_from(path, &checked)
            };
            settled(journal, archive, "success", "Export complete", "Silo verified this export after relaunching.", None)
        }
        _ => settled(
            journal,
            journal.archive.clone(),
            "failed",
            interrupted,
            "Silo closed before this export finished. The file it left could not be verified and was kept.",
            Some("Export the sandbox again."),
        ),
    })
}

/// Settle an operation interrupted before the storage migration, without the runtime
/// and without writing to the previous generation: until the migration finishes it is
/// a pre-upgrade backup, which the migration copies and never edits. What the
/// operation left outside that folder is handled as in [`recover_at_paths`]: its
/// working files and partial export file are removed, and a finished export file is
/// kept. What only the runtime could clean up (an export capture, a loaded import
/// group, the sandbox of an unfinished import) is left as it is and reported: the
/// migration converts only the sandboxes saved in the settings, so an import that
/// never saved its sandbox is never converted.
pub(super) fn settle_before_migration(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    journal: &Journal,
    cancellation: &backup::Cancellation,
) -> Result<Operation, String> {
    let _guard = runtime::OPERATIONS
        .computer("Recovering export or import")
        .map_err(|_| "Sandbox operations unavailable.")?;
    // A snapshot command from the previous process can outlive it while writing
    // into the working folder. Wait for it without creating the lock file, which
    // would add a file to the previous generation.
    let command = backup::wait_for_interrupted_command_in_place(
        paths.storage_home.as_deref().unwrap_or(&paths.home),
        Duration::from_secs(60),
    )
    .map_err(|e| e.to_string())?;
    // Files outside the previous generation. Leaving some behind harms nothing, so a
    // failure here never keeps the migration waiting; the result says so.
    let staging = controller.service.cleanup_interrupted_staging();
    let partial = cleanup_archive_partial(journal);
    drop(command);
    let leftover = match &journal.request {
        Request::Backup {
            pending_capture, ..
        } => pending_capture.is_some(),
        Request::Restore { id, group, .. } => id.is_some() || group.is_some(),
    };
    let kept = if leftover {
        " Silo did not clean up the data it had started."
    } else {
        ""
    };
    let archive = journal.archive.clone();
    let result = match &journal.request {
        Request::Backup { names, .. } => left_export(
            journal,
            names,
            controller,
            cancellation,
            "Export interrupted before the upgrade",
        )
        .unwrap_or_else(|| {
            let (outcome, title, message, again) = if journal.cancelled {
                (
                    "cancelled",
                    "Export cancelled",
                    "The export was cancelled.",
                    "",
                )
            } else {
                (
                    "failed",
                    "Export interrupted before the upgrade",
                    "Silo closed before this export finished.",
                    " Export the sandbox again.",
                )
            };
            let files = if staging.is_err() || partial.is_err() {
                " Some files it left in the export folder could not be removed."
            } else {
                ""
            };
            let detail = format!("No export file was saved.{kept}{files}{again}");
            settled(journal, archive, outcome, title, message, Some(&detail))
        }),
        Request::Restore { id, .. } => {
            // Saved settings are the import's commit point: a sandbox saved under the
            // journaled identity is complete and is converted like any other.
            let saved = match id {
                Some(id) => runtime::read_metadata(&paths.metadata)
                    .map_err(|e| e.to_string())?
                    .machines
                    .iter()
                    .any(|machine| machine.id() == id),
                None => false,
            };
            if saved {
                let message = "Silo verified this import after relaunching.";
                settled(
                    journal,
                    archive,
                    "success",
                    "Import complete",
                    message,
                    None,
                )
            } else {
                let (outcome, title, message, again) = if journal.cancelled {
                    (
                        "cancelled",
                        "Import cancelled",
                        "The import was cancelled.",
                        "",
                    )
                } else {
                    (
                        "failed",
                        "Import interrupted before the upgrade",
                        "Silo closed before this import finished.",
                        if leftover {
                            " Import the file again, under another name if Silo says the name is taken."
                        } else {
                            " Import the file again."
                        },
                    )
                };
                let detail = format!("No sandbox was added.{kept}{again}");
                settled(journal, archive, outcome, title, message, Some(&detail))
            }
        }
    };
    // The cleanup only the runtime could do is given up, so the result can be recorded.
    if leftover {
        give_up_runtime_cleanup(controller)?;
    }
    Ok(result)
}

/// Stop owning the cleanup of an export capture or an unfinished import, which only
/// the runtime can do, so the journal may record its result (see `complete`).
fn give_up_runtime_cleanup(controller: &Controller) -> Result<(), String> {
    update(controller, |journal| match &mut journal.request {
        Request::Backup {
            pending_capture, ..
        } => *pending_capture = None,
        Request::Restore { id, group, .. } => {
            *id = None;
            *group = None;
        }
    })
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
        .computer("Recovering export or import")
        .map_err(|_| "Sandbox operations unavailable.")?;
    runtime::prepare_runtime_home(&paths.home, paths.storage_home.as_deref())
        .map_err(|e| e.to_string())?;
    // A snapshot command from the previous process can outlive it while
    // writing into the working folder; let it finish before cleaning up.
    let command = backup::wait_for_interrupted_command(&paths.home, Duration::from_secs(60))
        .map_err(|e| e.to_string())?;
    controller
        .service
        .cleanup_interrupted_staging()
        .map_err(|e| format!("Could not clear interrupted working files: {e}"))?;
    cleanup_archive_partial(journal)?;
    // The previous process's command has finished. Release the lock so the
    // snapshot commands that remove an unfinished import can take it.
    drop(command);
    settle_export_capture(&runtime::ProcessRunner, paths, controller)?;
    let result = |archive: Archive,
                  outcome: &'static str,
                  title: &str,
                  message: &str,
                  detail: Option<&str>| {
        settled(journal, archive, outcome, title, message, detail)
    };
    match &journal.request {
        Request::Backup { names, .. } => {
            if let Some(operation) = left_export(
                journal,
                names,
                controller,
                cancellation,
                "Export interrupted",
            ) {
                return Ok(operation);
            }
            Ok(if journal.cancelled {
                result(
                    journal.archive.clone(),
                    "cancelled",
                    "Export cancelled",
                    "The export was cancelled.",
                    Some("No export file was saved."),
                )
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
                let metadata =
                    runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?;
                // Saved settings are the import's commit point.
                if metadata.machines.iter().any(|machine| machine.id() == id) {
                    return Ok(result(
                        journal.archive.clone(),
                        "success",
                        "Import complete",
                        "Silo verified this import after relaunching.",
                        None,
                    ));
                }
                discard_uncommitted_import(paths, controller, id, group.as_deref())?;
            } else if group.is_some() {
                discard_pending_import(paths, controller)?;
            }
            Ok(if journal.cancelled {
                result(
                    journal.archive.clone(),
                    "cancelled",
                    "Import cancelled",
                    "The import was cancelled.",
                    Some("No sandbox was added."),
                )
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
    use super::super::tests::{
        completed_archive, controller_with_scripted_msb, history_controller, scripted_calls,
    };
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
            Operation::Result {
                outcome,
                title,
                message,
                detail,
                ..
            } => (*outcome, title.clone(), message.clone(), detail.clone()),
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
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let mut journal = Journal::backup(export_to(directory.path()), vec!["dev".into()], None);
        // Journals from older builds list sandboxes that were running when the
        // export began; relaunch used to start them again.
        let id = uuid::Uuid::new_v4().to_string();
        if let Request::Backup {
            machines, running, ..
        } = &mut journal.request
        {
            *machines = vec![("dev".into(), id.clone())];
            *running = vec![("dev".into(), id)];
        }
        let partial = Path::new(&journal.archive.destination)
            .join(format!(".silo-backup-{}-partial", journal.id));
        fs::write(&partial, b"incomplete").unwrap();
        begin(&controller, journal.clone()).unwrap();
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
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
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let mut journal = Journal::backup(export_to(directory.path()), vec!["dev".into()], None);
        journal.cancelled = true;
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert_eq!(result_of(&recovered).0, "cancelled");

        fs::write(&journal.archive.archive_path, b"not an export").unwrap();
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        let (outcome, title, message, _) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("failed", "Export interrupted"));
        assert!(message.contains("could not be verified"), "{message}");
        assert_eq!(
            fs::read(&journal.archive.archive_path).unwrap(),
            b"not an export"
        );
    }

    #[test]
    fn recovery_settles_a_journal_from_before_a_runtime_migration_without_the_runtime() {
        let _test_state = crate::test_support::global_state();
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
            let recovered = recover_at_paths(
                &paths,
                &controller,
                &journal,
                &backup::Cancellation::default(),
            )
            .unwrap();
            assert_eq!(result_of(&recovered).0, "failed");
        }
    }

    fn export_source(id: &str) -> backup::BackupSource {
        backup::BackupSource {
            name: "dev".into(),
            snapshot_group: "dev".into(),
            was_running: false,
            runtime_config: Value::Null,
            machine_config: serde_json::json!({"id":id}),
            existing_member: None,
        }
    }

    struct PartialCaptureRuntime {
        calls: Mutex<Vec<Vec<String>>>,
        fail_remove: bool,
        live_parent: bool,
    }
    impl runtime::RuntimeRunner for PartialCaptureRuntime {
        fn run(
            &self,
            _: &runtime::RuntimePaths,
            arguments: &[String],
            _: Duration,
        ) -> Result<runtime::CommandOutput, runtime::RuntimeError> {
            self.calls.lock().unwrap().push(arguments.to_vec());
            let stdout = match arguments.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                ["snapshot", "list", "--format", "json"] => serde_json::json!([
                    {"snapshot_id":"snap_00000000000000000000000000000000", "group":"dev", "name":"silo-backup-0-1-2"},
                    {"snapshot_id":"snap_11111111111111111111111111111111", "group":"other", "name":"silo-backup-0-3-4"}
                ]).to_string(),
                ["list", "--format", "json"] => if self.live_parent { r#"[{"name":"dev","status":"Stopped"}]"#.into() } else { "[]".into() },
                ["inspect", "dev", "--format", "json"] => serde_json::json!({"name":"dev","status":"Stopped","config":{"snapshot_parent":"snap_00000000000000000000000000000000"}}).to_string(),
                ["snapshot", "head", "dev", "--format", "json"] => serde_json::json!({"head":"snap_00000000000000000000000000000000"}).to_string(),
                ["snapshot", "remove", "dev:silo-backup-0-1-2", "--quiet"] if self.fail_remove => {
                    return Err(runtime::RuntimeError::Invalid("test removal refused".into()));
                }
                ["snapshot", "remove", "dev:silo-backup-0-1-2", "--quiet"] => String::new(),
                _ => panic!("unexpected cleanup command: {arguments:?}"),
            };
            Ok(runtime::CommandOutput {
                stdout,
                stderr: String::new(),
            })
        }
    }

    #[test]
    fn failed_export_removes_only_its_journaled_capture_and_clears_intent_afterward() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        let source = export_source(&uuid::Uuid::new_v4().to_string());
        export_capture_intent(&controller, &source, Some("silo-backup-0-1-2")).unwrap();
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Backup {
                pending_capture: Some(_),
                ..
            }
        ));
        let runner = PartialCaptureRuntime {
            calls: Mutex::new(Vec::new()),
            fail_remove: false,
            live_parent: false,
        };
        settle_export_capture(&runner, &paths, &controller).unwrap();
        assert_eq!(
            runner
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|args| args.get(1).is_some_and(|arg| arg == "remove"))
                .cloned()
                .collect::<Vec<_>>(),
            vec![vec![
                "snapshot",
                "remove",
                "dev:silo-backup-0-1-2",
                "--quiet"
            ]]
        );
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Backup {
                pending_capture: None,
                ..
            }
        ));
    }

    #[test]
    fn failed_capture_cleanup_keeps_its_journal_for_next_launch() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        export_capture_intent(
            &controller,
            &export_source(&uuid::Uuid::new_v4().to_string()),
            Some("silo-backup-0-1-2"),
        )
        .unwrap();
        let runner = PartialCaptureRuntime {
            calls: Mutex::new(Vec::new()),
            fail_remove: true,
            live_parent: false,
        };
        assert!(settle_export_capture(&runner, &paths, &controller).is_err());
        complete(
            &controller,
            Operation::Result {
                operation: "backup",
                archive: completed_archive(),
                running_names: vec![],
                target_name: None,
                outcome: "failed",
                title: "Export failed".into(),
                message: "Interrupted capture".into(),
                detail: None,
            },
        );
        let saved = load(&controller.history_path).unwrap().unwrap();
        assert!(saved.terminal.is_none());
        assert!(matches!(
            saved.request,
            Request::Backup {
                pending_capture: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn crash_after_verified_capture_keeps_the_live_lineage_parent_and_clears_intent() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
        let artifact = paths
            .home
            .join("snapshots/dev/snap_00000000000000000000000000000000");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(directory.path().join("snapshots.json"), serde_json::json!([
            {"snapshot_id":"snap_00000000000000000000000000000000", "group":"dev", "name":"silo-backup-0-1-2", "availability":"ready", "artifact_path":artifact}
        ]).to_string()).unwrap();
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        export_capture_intent(
            &controller,
            &export_source(&uuid::Uuid::new_v4().to_string()),
            Some("silo-backup-0-1-2"),
        )
        .unwrap();
        let runner = PartialCaptureRuntime {
            calls: Mutex::new(Vec::new()),
            fail_remove: false,
            live_parent: true,
        };
        settle_export_capture(&runner, &paths, &controller).unwrap();
        assert!(!runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|args| args.get(1).is_some_and(|arg| arg == "remove")));
        assert!(scripted_calls(directory.path())
            .iter()
            .any(|call| call.starts_with("snapshot verify")));
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Backup {
                pending_capture: None,
                ..
            }
        ));
    }

    #[test]
    fn capture_journal_rejects_unowned_members_and_invalid_identities() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        for (id, group, member) in [
            ("invalid", "dev", "silo-backup-0-1-2"),
            (id.as_str(), "../other", "silo-backup-0-1-2"),
            (id.as_str(), "dev", "checkpoint-to-keep"),
        ] {
            let mut source = export_source(id);
            source.snapshot_group = group.into();
            assert!(export_capture_intent(&controller, &source, Some(member)).is_err());
        }
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Backup {
                pending_capture: None,
                ..
            }
        ));
    }

    #[test]
    fn only_an_interrupted_import_holds_back_startup() {
        let _test_state = crate::test_support::global_state();
        assert!(!Journal::backup(completed_archive(), vec!["dev".into()], None).blocks_startup());
        assert!(Journal::restore(completed_archive(), "copy".into(), None).blocks_startup());
    }

    #[test]
    fn relaunch_adopts_an_import_whose_sandbox_was_saved() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let id = uuid::Uuid::new_v4().to_string();
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        runtime::checkpoints::import_pending_restore(&paths, &id, IMPORT_GROUP, IMPORT_MEMBER)
            .unwrap();
        save_machine(&paths, "copy", &id);
        let journal = load(&controller.history_path).unwrap().unwrap();
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        let (outcome, title, ..) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("success", "Import complete"));
        assert!(paths
            .metadata
            .with_file_name("checkpoints")
            .join(format!("{id}.json"))
            .exists());
        complete(&controller, recovered);
        assert!(!pending(&controller).unwrap());
    }

    #[test]
    fn relaunch_forgets_an_import_that_was_never_saved() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
        let id = uuid::Uuid::new_v4().to_string();
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        runtime::checkpoints::import_pending_restore(&paths, &id, IMPORT_GROUP, IMPORT_MEMBER)
            .unwrap();
        // Another sandbox now uses the requested name; it is not this import's.
        save_machine(&paths, "copy", &uuid::Uuid::new_v4().to_string());
        let journal = load(&controller.history_path).unwrap().unwrap();
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        let (outcome, title, _message, detail) = result_of(&recovered);
        assert_eq!((outcome, title.as_str()), ("failed", "Import interrupted"));
        assert!(detail.unwrap().contains("No sandbox was added"));
        assert!(!paths
            .metadata
            .with_file_name("checkpoints")
            .join(format!("{id}.json"))
            .exists());
        assert_eq!(
            runtime::read_metadata(&paths.metadata)
                .unwrap()
                .machines
                .len(),
            1
        );
        // The journaled import group was removed from the runtime store,
        // child first and root last, and nothing else was touched.
        let removals = scripted_calls(directory.path())
            .into_iter()
            .filter(|call| call.starts_with("snapshot remove") || call.starts_with("snapshot head"))
            .collect::<Vec<_>>();
        assert_eq!(
            removals,
            [
                format!("snapshot head {IMPORT_GROUP}:imported-parent"),
                format!("snapshot remove --quiet {IMPORT_GROUP}:imported-member"),
                format!("snapshot remove --quiet {IMPORT_GROUP}:imported-parent"),
            ]
        );
        complete(&controller, recovered);
        assert!(!pending(&controller).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn relaunch_keeps_stage_ownership_when_a_stage_or_parent_is_redirected() {
        let _test_state = crate::test_support::global_state();
        for redirect_parent in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let paths = temp_paths(directory.path());
            let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
            fs::write(directory.path().join("snapshots.json"), b"[]").unwrap();
            begin(
                &controller,
                Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
            )
            .unwrap();
            save_restore_group(&controller, IMPORT_GROUP).unwrap();
            let snapshot = paths
                .home
                .join("snapshots/.msb-snapshot-load-0123456789abcdef0123456789abcdef");
            fs::create_dir_all(&snapshot).unwrap();
            fs::write(snapshot.join("keep"), b"owned").unwrap();
            let redirected = if redirect_parent {
                paths.home.join("cache")
            } else {
                paths
                    .home
                    .join("cache/tmp/snapshot-load-0123456789abcdef0123456789abcdef")
            };
            fs::create_dir_all(redirected.parent().unwrap()).unwrap();
            fs::write(outside.path().join("keep"), b"outside").unwrap();
            std::os::unix::fs::symlink(outside.path(), &redirected).unwrap();
            let journal = load(&controller.history_path).unwrap().unwrap();
            let error = recover_at_paths(
                &paths,
                &controller,
                &journal,
                &backup::Cancellation::default(),
            )
            .err()
            .expect("redirected stage must fail closed");
            assert!(error.contains("preserved"));
            assert_eq!(fs::read(snapshot.join("keep")).unwrap(), b"owned");
            assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"outside");
            assert!(matches!(
                load(&controller.history_path).unwrap().unwrap().request,
                Request::Restore { group: Some(_), .. }
            ));
            fs::remove_file(redirected).unwrap();
            recover_at_paths(
                &paths,
                &controller,
                &journal,
                &backup::Cancellation::default(),
            )
            .unwrap();
            assert!(!snapshot.exists());
            assert_eq!(fs::read(outside.path().join("keep")).unwrap(), b"outside");
        }
    }

    /// Opt-in fixture proof with the rebuilt CLI; never starts a VM or launches Silo.
    #[cfg(unix)]
    #[test]
    #[ignore = "requires SILO_E03_MSB pointing to this worktree's rebuilt CLI"]
    fn rebuilt_cli_killed_load_is_removed_by_next_launch_recovery() {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::process::ExitStatusExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let _test_state = crate::test_support::global_state();
        let executable =
            fs::canonicalize(std::env::var_os("SILO_E03_MSB").expect("SILO_E03_MSB is required"))
                .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = Controller {
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: executable.clone(),
                    home: paths.home.clone(),
                    storage_home: None,
                    library: paths.library.clone(),
                },
                directory.path().join("scratch"),
            ),
            ..history_controller(directory.path().join("backup-history.json"))
        };
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_group(&controller, IMPORT_GROUP).unwrap();
        let owned = [
            paths
                .home
                .join("snapshots/.msb-snapshot-load-0123456789abcdef0123456789abcdef"),
            paths
                .home
                .join("cache/tmp/snapshot-load-0123456789abcdef0123456789abcdef"),
        ];
        let unrelated = [
            paths
                .home
                .join("snapshots/.msb-snapshot-load-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            paths
                .home
                .join("cache/tmp/snapshot-load-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            paths.home.join("snapshots/.msb-snapshot-import-legacy"),
        ];
        for stage in &unrelated {
            fs::create_dir_all(stage).unwrap();
            fs::write(stage.join("keep"), b"unrelated").unwrap();
        }
        let fifo = directory.path().join("partial.tar");
        assert!(Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        // Keep the writer open so msb must block in a large tar member. The partial
        // fixture uses an accepted legacy disk entry; its full payload never arrives.
        let mut stream = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let mut child = Command::new(&executable)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", directory.path())
            .env("MSB_HOME", &paths.home)
            .env("XDG_CONFIG_HOME", directory.path().join("config"))
            .args(["snapshot", "load"])
            .arg(&fifo)
            .args([
                "--group",
                IMPORT_GROUP,
                "--stage-id",
                "0123456789abcdef0123456789abcdef",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_path("fixture/upper.ext4").unwrap();
        header.set_size(1024 * 1024 * 1024);
        header.set_mode(0o600);
        header.set_cksum();
        let written = stream
            .write_all(header.as_bytes())
            .and_then(|()| stream.write_all(&[42; 4096]));
        fn has_partial_file(root: &Path) -> bool {
            fs::read_dir(root).is_ok_and(|entries| {
                entries.flatten().any(|entry| {
                    entry.file_type().is_ok_and(|kind| {
                        if kind.is_dir() {
                            has_partial_file(&entry.path())
                        } else {
                            entry
                                .metadata()
                                .is_ok_and(|metadata| metadata.len() >= 4096)
                        }
                    })
                })
            })
        }
        let started = Instant::now();
        while written.is_ok()
            && !has_partial_file(&owned[0])
            && started.elapsed() < Duration::from_secs(20)
        {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let partial_written = has_partial_file(&owned[0]);
        let alive = child.try_wait().unwrap().is_none();
        // This PID comes directly from our spawned child, never from a process-name search.
        if alive {
            assert_eq!(
                unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) },
                0
            );
        }
        let output = child.wait_with_output().unwrap();
        drop(stream);
        assert!(
            written.is_ok() && partial_written && alive,
            "fixture load did not block after writing data: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.signal(), Some(libc::SIGTERM));
        for stage in &owned {
            assert!(stage.is_dir(), "killed load lost stage {}", stage.display());
        }
        drop(controller);
        let controller = Controller {
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: executable.clone(),
                    home: paths.home.clone(),
                    storage_home: None,
                    library: paths.library.clone(),
                },
                directory.path().join("scratch"),
            ),
            ..history_controller(directory.path().join("backup-history.json"))
        };
        let journal = load(&controller.history_path).unwrap().unwrap();
        *controller.journal.lock().unwrap() = Some(journal.clone());
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert_eq!(result_of(&recovered).1, "Import interrupted");
        for stage in owned {
            assert!(!stage.exists());
        }
        for stage in unrelated {
            assert_eq!(fs::read(stage.join("keep")).unwrap(), b"unrelated");
        }
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Restore { group: None, .. }
        ));
        println!("Fixture proof: {} wrote partial data; SIGTERM left both owned stages; launch recovery removed them and preserved three unrelated stages. No VM started.", executable.display());
    }

    #[test]
    fn relaunch_removes_only_journaled_stages_before_or_after_load_starts() {
        let _test_state = crate::test_support::global_state();
        for load_started in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let paths = temp_paths(directory.path());
            let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
            fs::write(directory.path().join("snapshots.json"), b"[]").unwrap();
            begin(
                &controller,
                Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
            )
            .unwrap();
            save_restore_group(&controller, IMPORT_GROUP).unwrap();
            let owned = [
                paths
                    .home
                    .join("snapshots/.msb-snapshot-load-0123456789abcdef0123456789abcdef"),
                paths
                    .home
                    .join("cache/tmp/snapshot-load-0123456789abcdef0123456789abcdef"),
            ];
            let unrelated = [
                paths
                    .home
                    .join("snapshots/.msb-snapshot-load-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                paths
                    .home
                    .join("cache/tmp/snapshot-load-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
                paths.home.join("snapshots/.msb-snapshot-import-legacy"),
            ];
            for stage in &unrelated {
                fs::create_dir_all(stage).unwrap();
                fs::write(stage.join("keep"), b"unrelated").unwrap();
            }
            if load_started {
                for stage in &owned {
                    fs::create_dir_all(stage.join("partial/nested")).unwrap();
                    fs::write(stage.join("partial/nested/payload"), b"incomplete").unwrap();
                }
            }
            // Discard all in-process state: launch reloads only the durable journal.
            drop(controller);
            let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
            fs::write(directory.path().join("snapshots.json"), b"[]").unwrap();
            let journal = load(&controller.history_path).unwrap().unwrap();
            *controller.journal.lock().unwrap() = Some(journal.clone());
            let recovered = recover_at_paths(
                &paths,
                &controller,
                &journal,
                &backup::Cancellation::default(),
            )
            .unwrap();
            assert_eq!(result_of(&recovered).1, "Import interrupted");
            for stage in owned {
                assert!(!stage.exists());
            }
            for stage in unrelated {
                assert_eq!(fs::read(stage.join("keep")).unwrap(), b"unrelated");
            }
            assert!(scripted_calls(directory.path())
                .iter()
                .all(|call| !call.starts_with("snapshot load") && !call.starts_with("start")));
            assert!(matches!(
                load(&controller.history_path).unwrap().unwrap().request,
                Request::Restore { group: None, .. }
            ));
        }
    }

    #[test]
    fn relaunch_discards_a_load_group_before_a_sandbox_identity_was_allocated() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_group(&controller, IMPORT_GROUP).unwrap();
        // Older runtimes left random stages without operation identities.
        // Recovery preserves these rather than inferring ownership.
        let stages = [
            paths.home.join("cache/tmp/snapshot-import-unattributed"),
            paths
                .home
                .join("snapshots/.msb-snapshot-import-unattributed"),
        ];
        for stage in &stages {
            fs::create_dir_all(stage).unwrap();
            fs::write(stage.join("payload"), b"unattributed").unwrap();
        }
        let journal = load(&controller.history_path).unwrap().unwrap();
        assert!(
            matches!(&journal.request, Request::Restore { id: None, group: Some(group), .. } if group == IMPORT_GROUP)
        );
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert_eq!(result_of(&recovered).1, "Import interrupted");
        assert_eq!(
            scripted_calls(directory.path())
                .into_iter()
                .filter(|call| call.starts_with("snapshot remove"))
                .collect::<Vec<_>>(),
            [
                format!("snapshot remove --quiet {IMPORT_GROUP}:imported-member"),
                format!("snapshot remove --quiet {IMPORT_GROUP}:imported-parent"),
            ]
        );
        for stage in stages {
            assert_eq!(fs::read(stage.join("payload")).unwrap(), b"unattributed");
        }
        complete(&controller, recovered);
        assert!(!pending(&controller).unwrap());
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Restore {
                id: None,
                group: None,
                ..
            }
        ));
    }

    #[test]
    fn failed_load_group_cleanup_keeps_ownership_without_a_sandbox_identity() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), None),
        )
        .unwrap();
        save_restore_group(&controller, IMPORT_GROUP).unwrap();
        fs::write(directory.path().join("refuse-remove"), b"").unwrap();
        let journal = load(&controller.history_path).unwrap().unwrap();
        assert!(recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default()
        )
        .is_err());
        complete(
            &controller,
            Operation::Result {
                operation: "restore",
                archive: completed_archive(),
                running_names: vec![],
                target_name: Some("copy".into()),
                outcome: "failed",
                title: "Import failed".into(),
                message: "Cleanup failed".into(),
                detail: None,
            },
        );
        let saved = load(&controller.history_path).unwrap().unwrap();
        assert!(saved.terminal.is_none());
        assert!(
            matches!(saved.request, Request::Restore { id: None, group: Some(ref group), .. } if group == IMPORT_GROUP)
        );
    }

    #[test]
    fn relaunch_keeps_the_import_identity_when_its_group_cannot_be_removed() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = controller_with_scripted_msb(directory.path(), &paths, IMPORT_GROUP);
        fs::write(directory.path().join("refuse-remove"), b"").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_identity(&controller, &id, IMPORT_GROUP).unwrap();
        let journal = load(&controller.history_path).unwrap().unwrap();
        let error = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap_err();
        assert!(error.contains(IMPORT_GROUP), "{error}");
        // The next launch retries the cleanup.
        assert!(matches!(
            load(&controller.history_path).unwrap().unwrap().request,
            Request::Restore { id: Some(ref saved), group: Some(ref group), .. } if *saved == id && group == IMPORT_GROUP
        ));
    }

    #[test]
    fn relaunch_reports_an_import_interrupted_before_it_saved_anything() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = temp_paths(directory.path());
        let controller = history_controller(directory.path().join("backup-history.json"));
        let journal = Journal::restore(completed_archive(), "copy".into(), Some("dev".into()));
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert_eq!(result_of(&recovered).1, "Import interrupted");
        let mut cancelled = journal;
        cancelled.cancelled = true;
        let recovered = recover_at_paths(
            &paths,
            &controller,
            &cancelled,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert_eq!(result_of(&recovered).0, "cancelled");
    }

    #[test]
    fn a_saved_import_identity_and_group_survive_reload_and_are_validated() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), None),
        )
        .unwrap();
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
        let _test_state = crate::test_support::global_state();
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
        begin(
            &controller,
            Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        assert!(load(&path).unwrap().is_some());
    }

    #[test]
    fn an_old_dismissal_cannot_clear_an_identical_later_restore_result() {
        let _test_state = crate::test_support::global_state();
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
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        begin(
            &controller,
            Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        save_restore_identity(&controller, &uuid::Uuid::new_v4().to_string(), IMPORT_GROUP)
            .unwrap();
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
            Journal::backup(completed_archive(), vec!["dev".into()], None)
        )
        .is_err());
        clear_restore_identity(&controller).unwrap();
        complete(&controller, failure());
        assert!(load(&path).unwrap().unwrap().terminal.is_some());
    }

    #[test]
    fn abandoned_archive_cleanup_only_removes_this_operations_files() {
        let _test_state = crate::test_support::global_state();
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
        let _test_state = crate::test_support::global_state();
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
        let _test_state = crate::test_support::global_state();
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
        let _test_state = crate::test_support::global_state();
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
        assert!(begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None)
        )
        .is_err());
    }

    #[test]
    fn result_is_durable_but_never_inferred_from_pending_progress() {
        let _test_state = crate::test_support::global_state();
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
            Operation::Result {
                outcome: "success",
                ..
            }
        ));
        begin(
            &controller,
            Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
    }

    #[test]
    fn a_saved_restart_required_result_from_an_older_silo_reads_as_a_completed_export() {
        let _test_state = crate::test_support::global_state();
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
        let _test_state = crate::test_support::global_state();
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
        let _test_state = crate::test_support::global_state();
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

    const OLD_VM: &str = "fcfbc268-ae3f-40ff-8dfa-8af78911e52f";
    const IMPORT_ID: &str = "0f6d5c1a-7a63-4b0a-9a36-4a6f1d3f6e11";
    const JOURNAL_ID: &str = "5b0c8e3e-3b8e-4c4c-9a0b-1f0f5f2d2b77";
    const LOAD_STAGE: &str = "snapshots/.msb-snapshot-load-0123456789abcdef0123456789abcdef";

    /// The previous runtime generation of an installation upgrading from a released
    /// Silo: its saved sandboxes, database and disk, and what an interrupted import
    /// or export leaves in it. Returns the paths recovery gets while the migration
    /// blocks the runtime: the same files and no way to start `msb`.
    fn previous_generation(app_data: &Path, saved: &[(&str, &str)]) -> runtime::RuntimePaths {
        let old = app_data.join("runtime");
        fs::create_dir_all(old.join("microsandbox/db")).unwrap();
        fs::write(old.join("microsandbox/db/msb.db"), b"released database").unwrap();
        fs::create_dir_all(old.join("volumes/dev")).unwrap();
        fs::write(old.join("volumes/dev/workspace.raw"), b"workspace").unwrap();
        // An import that stopped while it wrote its disk, and a native snapshot load.
        fs::create_dir_all(old.join("volumes/copy")).unwrap();
        fs::write(old.join("volumes/copy/.silo-restore-owner"), IMPORT_ID).unwrap();
        fs::write(old.join("volumes/copy/workspace.raw"), b"partial disk").unwrap();
        fs::create_dir_all(old.join("microsandbox").join(LOAD_STAGE).join("partial")).unwrap();
        let machines: Vec<_> = saved
            .iter()
            .map(|(name, id)| serde_json::json!({"kind":"vm","id":id,"name":name,"cpus":1,"maxCPUs":1,"memoryGiB":1,"maxMemoryGiB":1,"workspaceStorageGiB":1,"runtimeStorageGiB":1}))
            .collect();
        let request: runtime::MachineConfigurationRequest =
            serde_json::from_value(serde_json::json!({"schemaVersion": 1, "machines": machines}))
                .unwrap();
        runtime::write_metadata(&old.join("machines.json"), &request).unwrap();
        runtime::RuntimePaths {
            guest_image: app_data.join("guest-image"),
            executable: PathBuf::new(),
            home: app_data.join("alias"),
            storage_home: Some(old.join("microsandbox")),
            library: PathBuf::new(),
            metadata: old.join("machines.json"),
            volumes: old.join("volumes"),
        }
    }

    /// Every entry under `root` with its bytes, link target or a directory marker.
    fn tree(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        let mut entries = std::collections::BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(directory) = stack.pop() {
            for entry in fs::read_dir(&directory).unwrap() {
                let path = entry.unwrap().path();
                let metadata = fs::symlink_metadata(&path).unwrap();
                let value = if metadata.file_type().is_symlink() {
                    fs::read_link(&path)
                        .unwrap()
                        .into_os_string()
                        .into_encoded_bytes()
                } else if metadata.is_dir() {
                    stack.push(path.clone());
                    b"<directory>".to_vec()
                } else {
                    fs::read(&path).unwrap()
                };
                entries.insert(path.strip_prefix(root).unwrap().to_path_buf(), value);
            }
        }
        entries
    }

    /// A controller as the first launch of an upgrade installs it: history and
    /// journal in `app_data`, working files under `app_data/scratch`.
    fn controller_in(app_data: &Path) -> Controller {
        Controller {
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: PathBuf::new(),
                    home: app_data.join("alias"),
                    storage_home: None,
                    library: PathBuf::new(),
                },
                app_data.join("scratch"),
            ),
            ..history_controller(app_data.join("backup-history.json"))
        }
    }

    /// A journal written by the released Silo 0.9.0, byte for byte: it has neither
    /// `pending_capture` nor `group`, which no release writes.
    fn released_journal(app_data: &Path, archive: &Path, request: Value) -> (Controller, Journal) {
        let text = serde_json::json!({
            "version": 1,
            "id": JOURNAL_ID,
            "archive": {
                "name": "dev.silo-backup",
                "archivePath": archive,
                "completedLabel": "In progress",
                "size": "Unknown",
                "destination": archive.parent().unwrap(),
                "sandboxes": ["dev"],
            },
            "request": request,
            "cancelled": false,
            "terminal": null,
        })
        .to_string();
        fs::write(app_data.join("backup-operation.json"), text).unwrap();
        let controller = controller_in(app_data);
        let journal = load(&controller.history_path)
            .unwrap()
            .expect("the released journal loads");
        *controller.journal.lock().unwrap() = Some(journal.clone());
        (controller, journal)
    }

    fn released_export(machines: Value) -> Value {
        serde_json::json!({"kind": "backup", "names": ["dev"], "machines": machines, "running": machines})
    }

    fn released_import(id: Option<&str>) -> Value {
        serde_json::json!({"kind": "restore", "name": "copy", "source": "dev", "id": id})
    }

    /// Settle the journal the way the first launch of an upgrade does and record the
    /// result, as `resume` does.
    fn settle(
        paths: &runtime::RuntimePaths,
        controller: &Controller,
        journal: &Journal,
    ) -> (&'static str, String, String, Option<String>) {
        let settled =
            settle_before_migration(paths, controller, journal, &backup::Cancellation::default())
                .unwrap();
        let result = result_of(&settled);
        complete(controller, settled);
        result
    }

    #[test]
    fn every_journal_a_release_can_leave_settles_before_the_upgrade_without_touching_it() {
        let _test_state = crate::test_support::global_state();
        let cases: [(&str, Value, &str, &str, &str); 4] = [
            (
                "export before its sandboxes were saved",
                released_export(serde_json::json!([])),
                "failed",
                "Export interrupted before the upgrade",
                "No export file was saved. Export the sandbox again.",
            ),
            (
                "export that stopped a running sandbox",
                released_export(serde_json::json!([["dev", OLD_VM]])),
                "failed",
                "Export interrupted before the upgrade",
                "No export file was saved. Export the sandbox again.",
            ),
            (
                "import before it chose a sandbox identity",
                released_import(None),
                "failed",
                "Import interrupted before the upgrade",
                "No sandbox was added. Import the file again.",
            ),
            (
                "import that wrote its disk but never saved its sandbox",
                released_import(Some(IMPORT_ID)),
                "failed",
                "Import interrupted before the upgrade",
                "No sandbox was added. Silo did not clean up the data it had started. Import the file again, under another name if Silo says the name is taken.",
            ),
        ];
        for (state, request, outcome, title, detail) in cases {
            let directory = tempfile::tempdir().unwrap();
            let app_data = directory.path();
            let paths = previous_generation(app_data, &[("dev", OLD_VM)]);
            let exports = app_data.join("exports");
            fs::create_dir_all(&exports).unwrap();
            let (controller, journal) =
                released_journal(app_data, &exports.join("dev.silo-backup"), request);
            // Working files this operation left outside the previous generation.
            let partial = exports.join(format!(".silo-backup-{JOURNAL_ID}-partial"));
            let other = exports.join(".silo-backup-another-operation-partial");
            let staging = app_data.join("scratch/backup-interrupted");
            fs::write(&partial, b"incomplete").unwrap();
            fs::write(&other, b"preserve").unwrap();
            fs::create_dir_all(&staging).unwrap();
            fs::write(staging.join("payload"), b"incomplete").unwrap();
            let before = tree(&app_data.join("runtime"));

            let (got_outcome, got_title, message, got_detail) =
                settle(&paths, &controller, &journal);

            assert_eq!(
                (got_outcome, got_title.as_str(), got_detail.as_deref()),
                (outcome, title, Some(detail)),
                "{state}"
            );
            assert!(
                message.starts_with("Silo closed before this"),
                "{state}: {message}"
            );
            // The previous generation is byte-identical: nothing was created, not even
            // the runtime alias or a worker lock, and nothing was removed from it.
            assert_eq!(tree(&app_data.join("runtime")), before, "{state}");
            assert!(!app_data.join("alias").exists(), "{state}");
            // What it left elsewhere is its own, and only it is removed: an export's
            // partial file, and any operation's working folder.
            assert_eq!(partial.exists(), journal.kind() == "restore", "{state}");
            assert!(!staging.exists(), "{state}");
            assert_eq!(fs::read(other).unwrap(), b"preserve", "{state}");
            // The journal recorded the result: nothing is pending and the next launch
            // shows it on the export and import page until it is dismissed.
            assert!(!pending(&controller).unwrap(), "{state}");
            let saved = load(&controller.history_path).unwrap().unwrap();
            assert!(
                matches!(saved.operation(), Operation::Result { title: ref shown, outcome: "failed", .. } if shown == title),
                "{state}"
            );
        }
    }

    #[test]
    fn a_saved_import_is_complete_even_when_a_marker_of_its_disk_remains() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path();
        // The settings are the commit point, written before the disk marker is removed.
        let paths = previous_generation(app_data, &[("dev", OLD_VM), ("copy", IMPORT_ID)]);
        let (controller, journal) = released_journal(
            app_data,
            &app_data.join("dev.silo-backup"),
            released_import(Some(IMPORT_ID)),
        );
        let before = tree(&app_data.join("runtime"));
        let (outcome, title, message, detail) = settle(&paths, &controller, &journal);
        assert_eq!((outcome, title.as_str()), ("success", "Import complete"));
        assert_eq!(message, "Silo verified this import after relaunching.");
        assert_eq!(detail, None);
        assert_eq!(tree(&app_data.join("runtime")), before);
        assert!(!pending(&controller).unwrap());
    }

    #[test]
    fn journals_from_development_builds_are_abandoned_instead_of_waiting_for_the_runtime() {
        let _test_state = crate::test_support::global_state();
        type Prepare = fn(&Controller);
        let cases: [(&str, bool, Prepare, &str, &str); 4] = [
            (
                "export with a native capture in progress",
                false,
                |controller| {
                    begin(
                        controller,
                        Journal::backup(completed_archive(), vec!["dev".into()], None),
                    )
                    .unwrap();
                    export_capture_intent(
                        controller,
                        &export_source(OLD_VM),
                        Some("silo-backup-0-1-2"),
                    )
                    .unwrap();
                },
                "Export interrupted before the upgrade",
                "No export file was saved. Silo did not clean up the data it had started. Export the sandbox again.",
            ),
            (
                "import that loaded a native snapshot group",
                false,
                |controller| {
                    begin(
                        controller,
                        Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
                    )
                    .unwrap();
                    save_restore_group(controller, IMPORT_GROUP).unwrap();
                },
                "Import interrupted before the upgrade",
                "No sandbox was added. Silo did not clean up the data it had started. Import the file again, under another name if Silo says the name is taken.",
            ),
            (
                "import that journaled its sandbox identity and group",
                false,
                |controller| {
                    begin(
                        controller,
                        Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
                    )
                    .unwrap();
                    save_restore_identity(controller, IMPORT_ID, IMPORT_GROUP).unwrap();
                },
                "Import interrupted before the upgrade",
                "No sandbox was added. Silo did not clean up the data it had started. Import the file again, under another name if Silo says the name is taken.",
            ),
            (
                "cancelled import that journaled its sandbox identity and group",
                true,
                |controller| {
                    begin(
                        controller,
                        Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
                    )
                    .unwrap();
                    save_restore_identity(controller, IMPORT_ID, IMPORT_GROUP).unwrap();
                },
                "Import cancelled",
                "No sandbox was added. Silo did not clean up the data it had started.",
            ),
        ];
        for (state, cancelled, prepare, title, detail) in cases {
            let directory = tempfile::tempdir().unwrap();
            let app_data = directory.path();
            let paths = previous_generation(app_data, &[("dev", OLD_VM)]);
            let controller = controller_in(app_data);
            prepare(&controller);
            if cancelled {
                cancel(&controller).unwrap();
            }
            // The next launch reloads only the durable journal.
            let journal = load(&controller.history_path).unwrap().unwrap();
            assert!(
                matches!(
                    &journal.request,
                    Request::Backup {
                        pending_capture: Some(_),
                        ..
                    } | Request::Restore { group: Some(_), .. }
                ),
                "{state}: the journal owns cleanup that needs the runtime"
            );
            let before = tree(&app_data.join("runtime"));
            let (outcome, got_title, _, got_detail) = settle(&paths, &controller, &journal);
            assert_eq!(
                (outcome, got_title.as_str(), got_detail.as_deref()),
                (
                    if cancelled { "cancelled" } else { "failed" },
                    title,
                    Some(detail)
                ),
                "{state}"
            );
            assert_eq!(tree(&app_data.join("runtime")), before, "{state}");
            assert!(!app_data.join("alias").exists(), "{state}");
            assert!(!pending(&controller).unwrap(), "{state}");
            let saved = load(&controller.history_path).unwrap().unwrap();
            assert!(saved.terminal.is_some(), "{state}");
            // The journal no longer claims data it did not clean up.
            assert!(
                matches!(
                    saved.request,
                    Request::Backup {
                        pending_capture: None,
                        ..
                    } | Request::Restore {
                        id: None,
                        group: None,
                        ..
                    }
                ),
                "{state}"
            );
        }
    }

    #[test]
    fn a_finished_export_file_is_kept_and_reported_when_the_upgrade_interrupts_nothing_else() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path();
        let paths = previous_generation(app_data, &[("dev", OLD_VM)]);
        let exports = app_data.join("exports");
        fs::create_dir_all(&exports).unwrap();
        let archive = exports.join("dev.silo-backup");
        backup::write_finished_export(&archive);
        let finished = fs::read(&archive).unwrap();
        let (controller, journal) = released_journal(
            app_data,
            &archive,
            released_export(serde_json::json!([["dev", OLD_VM]])),
        );
        let before = tree(&app_data.join("runtime"));
        let (outcome, title, message, detail) = settle(&paths, &controller, &journal);
        assert_eq!((outcome, title.as_str()), ("success", "Export complete"));
        assert_eq!(message, "Silo verified this export after relaunching.");
        assert_eq!(detail, None);
        assert_eq!(fs::read(&archive).unwrap(), finished);
        assert_eq!(tree(&app_data.join("runtime")), before);
        assert!(!pending(&controller).unwrap());
    }

    #[test]
    fn an_export_file_that_cannot_be_verified_is_kept_before_the_upgrade() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path();
        let paths = previous_generation(app_data, &[("dev", OLD_VM)]);
        let archive = app_data.join("dev.silo-backup");
        fs::write(&archive, b"half of an export").unwrap();
        let (controller, journal) =
            released_journal(app_data, &archive, released_export(serde_json::json!([])));
        let (outcome, title, message, detail) = settle(&paths, &controller, &journal);
        assert_eq!(
            (outcome, title.as_str()),
            ("failed", "Export interrupted before the upgrade")
        );
        assert!(
            message.contains("could not be verified and was kept"),
            "{message}"
        );
        assert_eq!(detail.as_deref(), Some("Export the sandbox again."));
        assert_eq!(fs::read(&archive).unwrap(), b"half of an export");
    }

    #[cfg(unix)]
    #[test]
    fn files_outside_the_previous_generation_that_cannot_be_removed_never_keep_the_migration_waiting(
    ) {
        use std::os::unix::fs::PermissionsExt;
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path();
        let paths = previous_generation(app_data, &[("dev", OLD_VM)]);
        let exports = app_data.join("exports");
        fs::create_dir_all(&exports).unwrap();
        let (controller, journal) = released_journal(
            app_data,
            &exports.join("dev.silo-backup"),
            released_export(serde_json::json!([])),
        );
        // An export folder that can no longer be read, such as a revoked permission.
        fs::set_permissions(&exports, fs::Permissions::from_mode(0o000)).unwrap();
        let settled = settle_before_migration(
            &paths,
            &controller,
            &journal,
            &backup::Cancellation::default(),
        );
        fs::set_permissions(&exports, fs::Permissions::from_mode(0o700)).unwrap();
        let (outcome, _, _, detail) = result_of(&settled.expect("the journal settles anyway"));
        assert_eq!(outcome, "failed");
        assert_eq!(
            detail.as_deref(),
            Some("No export file was saved. Some files it left in the export folder could not be removed. Export the sandbox again.")
        );
    }
}
