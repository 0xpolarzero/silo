mod recovery;

use crate::{backup, runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const GIB: u64 = 1024 * 1024 * 1024;
const RESTORE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Archive {
    name: String,
    archive_path: String,
    completed_label: String,
    size: String,
    destination: String,
    sandboxes: Vec<String>,
    /// The checkpoint an export packages, so titles do not depend on UI memory (E-52).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpoint_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Phase {
    title: String,
    detail: String,
    tone: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum Operation {
    #[serde(rename = "running")]
    Running {
        operation: &'static str,
        archive: Archive,
        running_names: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_name: Option<String>,
        progress: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        indeterminate: Option<bool>,
        /// `Some(false)` once Cancel would no longer be honoured (E-28).
        #[serde(skip_serializing_if = "Option::is_none")]
        can_cancel: Option<bool>,
        phases: Vec<Phase>,
    },
    #[serde(rename = "result")]
    Result {
        operation: &'static str,
        archive: Archive,
        running_names: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_name: Option<String>,
        outcome: &'static str,
        title: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupState {
    snapshot_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_id: Option<String>,
    availability: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    availability_message: Option<String>,
    /// Always empty: exports are no longer listed (E-45). Kept because the
    /// frontend contract still requires the field.
    archives: Vec<Archive>,
    operation: Option<Operation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveInspectionResult {
    archive: Archive,
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// `backup-history.json`. Older builds also listed completed exports here; no
/// UI showed them, so only the chosen export folder is kept (E-45). The file is
/// advisory: a missing, unreadable or newer file only forgets the folder.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupHistory {
    schema_version: u32,
    destination: Option<PathBuf>,
    /// Always written empty; read only so older files still parse.
    #[serde(default)]
    archives: Vec<Value>,
}

fn load_destination(path: &Path) -> Option<PathBuf> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!("Silo ignored its unreadable export folder setting: {error}");
            return None;
        }
    };
    match serde_json::from_slice::<BackupHistory>(&bytes) {
        Ok(history) if history.schema_version == 1 => {
            history.destination.filter(|path| path.is_absolute())
        }
        Ok(_) => None,
        Err(error) => {
            eprintln!("Silo ignored its unreadable export folder setting: {error}");
            None
        }
    }
}

fn write_history(path: &Path, history: &BackupHistory) -> Result<(), String> {
    let write = || -> Result<(), Box<dyn std::error::Error>> {
        let parent = path.parent().ok_or("Missing export history directory")?;
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, history)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    };
    write().map_err(|error| format!("Silo could not save export history: {error}"))
}

/// Use `destination` as the export folder. Saving it for the next launch is
/// best effort: a failure never blocks this export.
fn remember_destination(controller: &Controller, destination: PathBuf) {
    let saved = write_history(
        &controller.history_path,
        &BackupHistory {
            schema_version: 1,
            destination: Some(destination.clone()),
            archives: Vec::new(),
        },
    );
    if let Err(error) = saved {
        eprintln!("{error} The export folder is used for this session only.");
    }
    controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .destination = Some(destination);
}

/// What `install` restores from the app data folder.
struct Saved {
    destination: Option<PathBuf>,
    journal: Option<recovery::Journal>,
    /// A saved operation that could not be read. It may describe unfinished
    /// work, so exports and imports stay unavailable and the file is kept.
    journal_error: Option<String>,
}

fn load_saved(history_path: &Path) -> Saved {
    let (journal, journal_error) = match recovery::load(history_path) {
        Ok(journal) => (journal, None),
        Err(error) => (None, Some(error)),
    };
    Saved {
        destination: load_destination(history_path),
        journal,
        journal_error,
    }
}

struct ViewState {
    journal_error: Option<String>,
    destination: Option<PathBuf>,
    operation: Option<Operation>,
    cancellation: Option<backup::Cancellation>,
    /// The export file check behind the import review, by request id (E-27).
    inspection: Option<(String, backup::Cancellation)>,
}

pub(crate) struct Controller {
    history_path: PathBuf,
    journal: Mutex<Option<recovery::Journal>>,
    service: backup::BackupService,
    view: Mutex<ViewState>,
    busy: AtomicBool,
    revision: AtomicU64,
}

pub(crate) fn install(app: &AppHandle) -> Result<(), String> {
    let paths = runtime::runtime_paths(app)?;
    let scratch = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Silo could not locate private export working storage: {error}"))?
        .join("backup-work");
    let history_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("backup-history.json");
    let Saved {
        destination,
        journal,
        journal_error,
    } = load_saved(&history_path);
    let controller = Arc::new(Controller {
        journal: Mutex::new(journal.clone()),
        history_path,
        service: backup::BackupService::new(
            backup::MsbCommand {
                executable: paths.executable,
                home: paths.home,
                storage_home: paths.storage_home,
                library: paths.library,
            },
            scratch,
        ),
        view: Mutex::new(ViewState {
            journal_error,
            destination,
            operation: None,
            cancellation: None,
            inspection: None,
        }),
        busy: AtomicBool::new(false),
        revision: AtomicU64::new(1),
    });
    app.manage(controller.clone());
    // Settle an interrupted operation before automatic runtime migration starts.
    // Recovery removes only the output journaled for this export or import.
    if let Some(journal) = journal {
        recovery::resume(app.clone(), controller, journal)?;
    }
    Ok(())
}

/// Startup runs this in its background worker before other recovery or optional
/// starts. An interrupted import may still own a checkpoint record for a sandbox
/// whose settings were never saved; its recovery is short and never repeats the
/// import. An interrupted export's recovery only checks its own files, so
/// startup does not wait for it (E-31).
pub(crate) fn wait_for_recovery(app: &AppHandle) -> Result<(), String> {
    wait_for_recovery_with(app, false)
}

/// Migration must wait for exports too: selecting a new generation quarantines
/// the previous generation's journal, including an interrupted export's result.
pub(crate) fn wait_for_migration_recovery(app: &AppHandle) -> Result<(), String> {
    wait_for_recovery_with(app, true)
}

fn wait_for_recovery_with(app: &AppHandle, migration: bool) -> Result<(), String> {
    let controller = app.state::<Arc<Controller>>();
    wait_for_controller_recovery(&controller, migration, &|| {
        crate::startup::is_cancelled(app)
    })
}

fn wait_for_controller_recovery(
    controller: &Controller,
    migration: bool,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    let pending = controller
        .journal
        .lock()
        .map_err(|_| {
            "Export and import recovery status could not be read. Relaunch Silo and retry."
        })?
        .as_ref()
        .filter(|journal| journal.is_pending() && (migration || journal.blocks_startup()))
        .map(|journal| journal.identity().to_string());
    let Some(identity) = pending else {
        return Ok(());
    };
    let started = std::time::Instant::now();
    loop {
        if cancelled() {
            return Ok(());
        }
        let pending = controller
            .journal
            .lock()
            .map_err(|_| {
                "Export and import recovery status could not be read. Relaunch Silo and retry."
            })?
            .as_ref()
            .is_some_and(|journal| journal.identity() == identity && journal.is_pending());
        if !pending {
            return Ok(());
        }
        if !controller.busy.load(Ordering::Acquire) {
            if migration {
                return Err("An interrupted export or import could not be recovered. Dismiss its result before retrying migration. No sandbox data was changed.".into());
            }
            // Recovery failed and published its error in the export/import
            // view, where the user can retry by relaunching or abandon it.
            // Exports no longer stop sandboxes and imports stay pending until
            // an explicit Start, so the rest of startup may proceed (E-43).
            return Ok(());
        }
        if started.elapsed() >= RESTORE_TIMEOUT {
            return Err(
                "Export or import recovery is still running. Automatic sandbox startup was deferred.".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the main Silo window can export or import sandboxes.".into())
}

fn publish(app: &AppHandle, controller: &Controller) {
    controller.revision.fetch_add(1, Ordering::Relaxed);
    let _ = app.emit("silo://application-state-changed", ());
}

/// Binary sizes, labelled GiB/MiB like the storage panel (E-41).
fn display_size(bytes: u64) -> String {
    if bytes >= GIB {
        format!("{:.1} GiB", bytes as f64 / GIB as f64)
    } else {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn archive_from(path: &Path, inspected: &backup::ArchiveInspection) -> Archive {
    Archive {
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Silo export")
            .to_string(),
        archive_path: path.to_string_lossy().into_owned(),
        completed_label: "Verified export file".into(),
        size: display_size(inspected.size_bytes),
        destination: path
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .into_owned(),
        sandboxes: inspected.sandboxes.clone(),
        checkpoint_name: None,
    }
}

/// Read on every refresh, so it runs off the main thread and reads only
/// in-memory state: no file system access that a stalled or sleeping export
/// volume could block (E-39).
#[tauri::command]
pub(crate) async fn read_backup_state(
    controller: State<'_, Arc<Controller>>,
) -> Result<BackupState, String> {
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup_state(&controller))
        .await
        .map_err(|error| error.to_string())?
}

fn backup_state(controller: &Controller) -> Result<BackupState, String> {
    let (journal_error, operation) = {
        let view = controller.view.lock().map_err(|_| {
            "Export and import status could not be read. Relaunch Silo and retry.".to_string()
        })?;
        (view.journal_error.clone(), view.operation.clone())
    };
    let availability_message = journal_error.or_else(|| {
        recovery::unresolved(controller).unwrap_or(true).then(|| "The interrupted export or import could not finish. Relaunch Silo to retry. Saved progress was preserved.".into())
    });
    Ok(BackupState {
        snapshot_id: controller.revision.load(Ordering::Relaxed).to_string(),
        operation_id: recovery::token(controller)?,
        availability: if availability_message.is_some() {
            "unavailable"
        } else {
            "available"
        },
        availability_message,
        archives: Vec::new(),
        operation,
    })
}

#[tauri::command]
pub(crate) async fn choose_backup_destination(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
) -> Result<Option<String>, String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    let starting_directory = controller
        .view
        .lock()
        .map_err(|_| {
            "Export and import status could not be read. Relaunch Silo and retry.".to_string()
        })?
        .destination
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Choose where to export")
            .set_parent(&window);
        if let Some(directory) = starting_directory {
            dialog = dialog.set_directory(directory);
        }
        let Some(selected) = dialog.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        let path = fs::canonicalize(&path)
            .map_err(|error| format!("Silo could not use the selected destination: {error}"))?;
        remember_destination(&controller, path.clone());
        publish(&app, &controller);
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn choose_backup_archive(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    require_main(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Choose a Silo export to import")
            .set_parent(&window)
            .add_filter("Silo export", &["silo-backup"])
            .blocking_pick_file();
        selected
            .map(|path| path.into_path().map_err(|error| error.to_string()))
            .transpose()
            .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Checks an export file before the import review. The check can take minutes
/// for a large file, so it is registered under the caller's request id and
/// `cancel_backup_inspection` stops it when the review closes. It changes no
/// state and publishes nothing (E-27).
#[tauri::command]
pub(crate) async fn inspect_backup_archive(
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    archive_path: String,
    request_id: Option<String>,
) -> Result<ArchiveInspectionResult, String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(archive_path);
        let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let cancellation = register_inspection(&controller, request_id.clone());
        let inspected = controller.service.inspect_archive(&path, &cancellation);
        finish_inspection(&controller, &request_id);
        match inspected {
            Ok(inspection) => Ok(ArchiveInspectionResult {
                archive: archive_from(&path, &inspection),
                valid: true,
                reason: None,
            }),
            Err(error) => Ok(ArchiveInspectionResult {
                archive: Archive {
                    name: path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("Export")
                        .into(),
                    archive_path: path.to_string_lossy().into_owned(),
                    completed_label: "Not validated".into(),
                    size: "Unknown".into(),
                    destination: path
                        .parent()
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned(),
                    sandboxes: Vec::new(),
                    checkpoint_name: None,
                },
                valid: false,
                reason: Some(error.to_string()),
            }),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Stops the export file check started under `request_id`, if it is still running.
#[tauri::command]
pub(crate) fn cancel_backup_inspection(
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    request_id: String,
) -> Result<bool, String> {
    require_main(&window)?;
    Ok(cancel_inspection(&controller, &request_id))
}

/// Registers a check; only one runs at a time, so a newer one cancels the older.
fn register_inspection(controller: &Controller, request_id: String) -> backup::Cancellation {
    let cancellation = backup::Cancellation::default();
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((_, previous)) = view.inspection.replace((request_id, cancellation.clone())) {
        previous.cancel();
    }
    cancellation
}

fn finish_inspection(controller: &Controller, request_id: &str) {
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if view
        .inspection
        .as_ref()
        .is_some_and(|(id, _)| id == request_id)
    {
        view.inspection = None;
    }
}

fn cancel_inspection(controller: &Controller, request_id: &str) -> bool {
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match view.inspection.take() {
        Some((id, cancellation)) if id == request_id => {
            cancellation.cancel();
            true
        }
        other => {
            view.inspection = other;
            false
        }
    }
}

/// Authorizes a reveal request. A path may be revealed only when it matches,
/// byte for byte, the `archive_path` of the current completed export (a
/// `Result` operation whose outcome finished successfully), and the file still
/// exists. Exact-string matching rejects traversal (`..`) or otherwise
/// non-identical paths, and the existence check rejects an archive the user
/// has since moved or deleted.
fn authorize_reveal(operation: Option<&Operation>, requested: &str) -> Result<PathBuf, String> {
    const UNAVAILABLE: &str = "That export file is no longer available.";
    let known = matches!(
        operation,
        Some(Operation::Result { outcome: "success", archive, .. })
            if archive.archive_path == requested
    );
    if !known {
        return Err(UNAVAILABLE.into());
    }
    let path = PathBuf::from(requested);
    if !path.is_file() {
        return Err(UNAVAILABLE.into());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) async fn reveal_backup_archive(
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    archive_path: String,
) -> Result<(), String> {
    require_main(&window)?;
    let operation = controller
        .view
        .lock()
        .map_err(|_| {
            "Export and import status could not be read. Relaunch Silo and retry.".to_string()
        })?
        .operation
        .clone();
    // The file check and the platform file manager can block; neither runs
    // under the state lock or on an async worker.
    tauri::async_runtime::spawn_blocking(move || {
        let path = authorize_reveal(operation.as_ref(), &archive_path)?;
        tauri_plugin_opener::reveal_item_in_dir(&path)
            .map_err(|error| format!("Silo could not show the export file: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn unique_archive(destination: &Path, sandboxes: &[String], checkpoint: bool) -> PathBuf {
    // A single-sandbox export reads as "<sandbox>-<date>"; a checkpoint export of
    // that sandbox reads as "<sandbox>-checkpoint-<date>"; a multi-sandbox export
    // keeps a generic base. The UTC date avoids a local-offset dependency.
    let today = time::OffsetDateTime::now_utc();
    let date = format!(
        "{:04}-{:02}-{:02}",
        today.year(),
        today.month() as u8,
        today.day()
    );
    let base_name = match (sandboxes, checkpoint) {
        ([only], true) => format!("{only}-checkpoint-{date}"),
        ([only], false) => format!("{only}-{date}"),
        _ => format!("Silo-Export-{date}"),
    };
    let base = destination.join(format!("{base_name}.silo-backup"));
    if !base.exists() {
        return base;
    }
    (2_u32..)
        .map(|suffix| destination.join(format!("{base_name}-{suffix}.silo-backup")))
        .find(|path| !path.exists())
        .unwrap_or(base)
}

fn set_operation(controller: &Controller, operation: Operation) -> Result<(), String> {
    controller
        .view
        .lock()
        .map_err(|_| {
            "Export and import status could not be read. Relaunch Silo and retry.".to_string()
        })?
        .operation = Some(operation);
    Ok(())
}

fn finish(controller: &Controller) {
    if let Ok(mut view) = controller.view.lock() {
        view.cancellation = None;
    }
    controller.busy.store(false, Ordering::Release);
}

/// Starts an export and returns its operation id: the `operationId` that
/// `read_backup_state` reports with this export's running state and result, so
/// a caller can wait for this specific export to finish (E-59).
#[tauri::command]
pub(crate) async fn start_backup(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    destination: String,
    sandboxes: Vec<String>,
    checkpoint_id: Option<String>,
) -> Result<String, String> {
    require_main(&window)?;
    // A rejection before the export starts is returned to the caller, which shows it
    // in place; only the background outcome (see `notify_transfer`) reaches the system.
    start_backup_inner(
        app,
        window,
        controller,
        destination,
        sandboxes,
        checkpoint_id,
    )
    .await
}

async fn start_backup_inner(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    destination: String,
    sandboxes: Vec<String>,
    checkpoint_id: Option<String>,
) -> Result<String, String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    // Resolving the destination, reading settings and saving the journal all
    // block on the file system; keep them off the async workers (E-39).
    tauri::async_runtime::spawn_blocking(move || {
        begin_export(app, controller, destination, sandboxes, checkpoint_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn begin_export(
    app: AppHandle,
    controller: Arc<Controller>,
    destination: String,
    sandboxes: Vec<String>,
    checkpoint_id: Option<String>,
) -> Result<String, String> {
    let selected_destination = controller
        .view
        .lock()
        .map_err(|_| {
            "Export and import status could not be read. Relaunch Silo and retry.".to_string()
        })?
        .destination
        .clone();
    let canonical = PathBuf::from(&destination)
        .canonicalize()
        .map_err(|error| format!("Silo could not use the export destination: {error}"))?;
    if selected_destination.as_deref() != Some(canonical.as_path()) {
        return Err("Choose the export destination again before starting.".into());
    }
    // Sandbox names become part of the archive file name, so validate them before
    // building the path to keep the archive inside the chosen destination.
    for name in &sandboxes {
        runtime::validate_name(name).map_err(|error| error.to_string())?;
    }
    // A checkpoint export packages one sandbox's stored checkpoint. Resolve its
    // name up front so the operation phase can name it and unknown ids fail early.
    let checkpoint_name = if let Some(checkpoint_id) = &checkpoint_id {
        let [sandbox] = sandboxes.as_slice() else {
            return Err("Choose exactly one sandbox to export from a checkpoint.".into());
        };
        let paths = runtime::runtime_paths(&app)?;
        let metadata =
            runtime::read_metadata(&paths.metadata).map_err(|error| error.to_string())?;
        let machine = metadata
            .machines
            .iter()
            .find(|machine| machine.is_vm() && machine.name() == sandbox)
            .ok_or_else(|| {
                format!(
                    "Sandbox '{sandbox}' is not managed by Silo. Choose a Silo sandbox to export."
                )
            })?;
        let (_group, _member, _scope, name) =
            runtime::checkpoints::export_source(&paths, machine.id(), checkpoint_id)
                .map_err(|error| error.to_string())?;
        Some(name)
    } else {
        None
    };
    let ClaimedExport {
        operation_id,
        archive_path,
        archive: pending_archive,
        cancellation,
    } = claim_export(
        &controller,
        &canonical,
        destination,
        &sandboxes,
        checkpoint_id.clone(),
        checkpoint_name.as_deref(),
    )?;
    publish(&app, &controller);
    let failure_archive = pending_archive.clone();
    let (work_app, work_controller) = (app.clone(), controller.clone());
    let work = move || {
        run_backup(
            work_app,
            work_controller,
            archive_path,
            sandboxes,
            checkpoint_id,
            cancellation,
            pending_archive,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        if contain_worker_panic(&controller, "backup", &failure_archive, None, work) {
            publish(&app, &controller);
        }
    });
    Ok(operation_id)
}

/// An export that owns the transfer slot and a saved journal.
struct ClaimedExport {
    /// The journal id, reported as `operationId` until the result is dismissed.
    operation_id: String,
    archive_path: PathBuf,
    archive: Archive,
    cancellation: backup::Cancellation,
}

/// Claims the transfer slot, saves the export's journal and publishes it as
/// running. Everything after this point reports its outcome as this
/// operation's result, under the returned operation id.
fn claim_export(
    controller: &Controller,
    destination_directory: &Path,
    destination: String,
    sandboxes: &[String],
    checkpoint_id: Option<String>,
    checkpoint_name: Option<&str>,
) -> Result<ClaimedExport, String> {
    controller
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another export or import is running.".to_string())?;
    let archive_path = unique_archive(destination_directory, sandboxes, checkpoint_id.is_some());
    let archive = Archive {
        name: archive_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        archive_path: archive_path.to_string_lossy().into_owned(),
        completed_label: "In progress".into(),
        size: "Unknown".into(),
        destination,
        sandboxes: sandboxes.to_vec(),
        checkpoint_name: checkpoint_name.map(Into::into),
    };
    let journal = recovery::Journal::backup(archive.clone(), sandboxes.to_vec(), checkpoint_id);
    let operation_id = journal.identity().to_string();
    if let Err(error) = recovery::begin(controller, journal) {
        finish(controller);
        return Err(error);
    }
    let cancellation = backup::Cancellation::default();
    let mut view = controller
        .view
        .lock()
        // `busy` and the journal are already claimed; returning here would
        // strand them, so recover a poisoned view instead (E-44).
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    view.cancellation = Some(cancellation.clone());
    let phase = match checkpoint_name {
        Some(name) => Phase {
            title: format!("Using checkpoint \u{201c}{name}\u{201d}"),
            detail: "Silo is packaging and verifying the selected checkpoint.".into(),
            tone: "running",
        },
        None => Phase {
            title: "Capture and verify".into(),
            detail: "Silo is capturing and verifying the sandbox disks for this export file."
                .into(),
            tone: "running",
        },
    };
    view.operation = Some(Operation::Running {
        operation: "backup",
        archive: archive.clone(),
        running_names: Vec::new(),
        target_name: None,
        progress: 0,
        indeterminate: Some(true),
        can_cancel: None,
        phases: vec![phase],
    });
    Ok(ClaimedExport {
        operation_id,
        archive_path,
        archive,
        cancellation,
    })
}

/// Runs a detached export or import worker. A panic would otherwise leave the
/// operation Running with `busy` set until relaunch, refusing new transfers,
/// dismissal and updates; record a terminal failure and release the slot.
/// Returns whether the worker panicked.
fn contain_worker_panic(
    controller: &Controller,
    operation: &'static str,
    archive: &Archive,
    target_name: Option<String>,
    work: impl FnOnce(),
) -> bool {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).is_ok() {
        return false;
    }
    let failure = recovery::complete(
        controller,
        Operation::Result {
            operation,
            archive: archive.clone(),
            target_name,
            running_names: vec![],
            outcome: "failed",
            title: if operation == "backup" {
                "Export failed"
            } else {
                "Import failed"
            }
            .into(),
            message: "Silo hit an internal error and stopped this operation.".into(),
            detail: Some("Files it had already written were kept.".into()),
        },
    );
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    view.operation = Some(failure);
    view.cancellation = None;
    drop(view);
    controller.busy.store(false, Ordering::Release);
    true
}

fn run_backup(
    app: AppHandle,
    controller: Arc<Controller>,
    archive_path: PathBuf,
    sandboxes: Vec<String>,
    checkpoint_id: Option<String>,
    cancellation: backup::Cancellation,
    pending_archive: Archive,
) {
    let started = std::time::Instant::now();
    let result = backup_work(
        &app,
        &controller,
        &archive_path,
        &sandboxes,
        checkpoint_id.as_deref(),
        &cancellation,
    );
    let operation = match result {
        Ok(archive) => Operation::Result {
            operation: "backup",
            archive: Archive {
                checkpoint_name: pending_archive.checkpoint_name,
                ..archive
            },
            running_names: Vec::new(),
            target_name: None,
            outcome: "success",
            title: "Export complete".into(),
            message: "Sandbox exported.".into(),
            detail: None,
        },
        Err(error) => failed_transfer("backup", pending_archive, None, error),
    };
    let operation = recovery::complete(&controller, operation);
    notify_transfer(&app, &operation, started.elapsed());
    let _ = set_operation(&controller, operation);
    finish(&controller);
    publish(&app, &controller);
}

/// Why an export or import worker ended without a result. The outcome comes
/// from `cancelled`, never from the message text (E-42).
#[derive(Debug)]
struct TransferError {
    cancelled: bool,
    message: String,
    /// What was left behind, when it differs from the default for the kind.
    detail: Option<&'static str>,
}

impl TransferError {
    fn cancelled() -> Self {
        Self {
            cancelled: true,
            message: String::new(),
            detail: None,
        }
    }

    /// An import that failed after its snapshot started unpacking may leave
    /// that data in the runtime's snapshot store (see E-23).
    fn after_unpacking(mut self) -> Self {
        self.detail = Some("No sandbox was added. Data unpacked for it may still use disk space.");
        self
    }
}

impl From<String> for TransferError {
    fn from(message: String) -> Self {
        Self {
            cancelled: false,
            message,
            detail: None,
        }
    }
}

impl From<&str> for TransferError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl From<backup::BackupError> for TransferError {
    fn from(error: backup::BackupError) -> Self {
        match error {
            backup::BackupError::Cancelled => Self::cancelled(),
            error => error.to_string().into(),
        }
    }
}

impl From<runtime::operation_gate::GateError> for TransferError {
    fn from(error: runtime::operation_gate::GateError) -> Self {
        match error {
            runtime::operation_gate::GateError::Cancelled => Self::cancelled(),
            error => error.to_string().into(),
        }
    }
}

/// The result for an export (`backup`) or import (`restore`) that did not
/// finish. Details state only what is always true for that kind and stage.
fn failed_transfer(
    operation: &'static str,
    archive: Archive,
    target_name: Option<String>,
    error: TransferError,
) -> Operation {
    let export = operation == "backup";
    let detail = error.detail.unwrap_or(if export {
        "No export file was saved."
    } else {
        "No sandbox was added. The export file was not changed."
    });
    let (outcome, title, message) = match (error.cancelled, export) {
        (true, true) => (
            "cancelled",
            "Export cancelled",
            "The export was cancelled.".to_string(),
        ),
        (true, false) => (
            "cancelled",
            "Import cancelled",
            "The import was cancelled.".to_string(),
        ),
        (false, true) => ("failed", "Export failed", error.message),
        (false, false) => ("failed", "Import failed", error.message),
    };
    Operation::Result {
        operation,
        archive,
        running_names: Vec::new(),
        target_name,
        outcome,
        title: title.into(),
        message,
        detail: Some(detail.into()),
    }
}

/// Shown while an export or import waits behind other sandbox work (E-52).
const QUEUED_PHASE: &str = "Waiting for other sandbox work";

/// Marks a running export as queued: a waiting phase leads, its work waits.
fn show_queued(controller: &Controller) {
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(Operation::Running { phases, .. }) = view.operation.as_mut() {
        if phases
            .first()
            .is_some_and(|phase| phase.title == QUEUED_PHASE)
        {
            return;
        }
        for phase in phases.iter_mut() {
            phase.tone = "waiting";
        }
        phases.insert(
            0,
            Phase {
                title: QUEUED_PHASE.into(),
                detail: "Starts when earlier sandbox changes finish.".into(),
                tone: "running",
            },
        );
    }
}

/// Ends a queued phase once the export's turn came. Returns whether it changed.
fn show_admitted(controller: &Controller) -> bool {
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(Operation::Running { phases, .. }) = view.operation.as_mut() else {
        return false;
    };
    if !phases
        .first()
        .is_some_and(|phase| phase.title == QUEUED_PHASE && phase.tone == "running")
    {
        return false;
    }
    phases[0].tone = "succeeded";
    if let Some(work) = phases.get_mut(1) {
        work.tone = "running";
    }
    true
}

/// Waits for the computer-wide operation turn. `on_queued` runs once if the
/// turn is not immediate; it runs under the gate's lock, so keep it short.
fn mutation_guard(
    cancellation: &backup::Cancellation,
    kind: runtime::operation_gate::OperationKind,
    label: &str,
    cancellable: bool,
    on_queued: &dyn Fn(),
) -> Result<runtime::operation_gate::OperationGuard<'static>, TransferError> {
    // Export and import change shared state and wait their turn (computer scope).
    // A queued export stays cancellable and gives up if the work ahead never ends.
    if cancellation.cancelled() {
        return Err(TransferError::cancelled());
    }
    let started = std::time::Instant::now();
    let queued = std::cell::Cell::new(false);
    let mut guard = runtime::OPERATIONS
        .kind(kind)
        .acquire_while(
            runtime::operation_gate::Scope::Computer,
            None,
            label,
            &|| {
                if !queued.replace(true) {
                    on_queued();
                }
                !cancellation.cancelled() && started.elapsed() < RESTORE_TIMEOUT
            },
        )
        .map_err(|error| match error {
            runtime::operation_gate::GateError::Abandoned if cancellation.cancelled() => {
                TransferError::cancelled()
            }
            runtime::operation_gate::GateError::Abandoned => TransferError::from(
                "The previous sandbox operation did not finish. Relaunch Silo to retry.",
            ),
            error => error.into(),
        })?;
    // Export capture can be cancelled while running; import cannot. Share the one
    // cancel flag with the gate so the queue's Cancel and the export UI's Cancel agree.
    if cancellable {
        guard.adopt_cancel_token(cancellation.flag());
        guard.allow_cancel();
    }
    guard.expect_within(std::time::Duration::from_secs(60 * 60));
    runtime::shutdown::ensure_accepting_operations()?;
    Ok(guard)
}

fn backup_work(
    app: &AppHandle,
    controller: &Controller,
    archive_path: &Path,
    names: &[String],
    checkpoint_id: Option<&str>,
    cancellation: &backup::Cancellation,
) -> Result<Archive, TransferError> {
    let _guard = mutation_guard(
        cancellation,
        runtime::operation_gate::OperationKind::Export,
        "Exporting sandbox",
        true,
        &|| {
            show_queued(controller);
            publish(app, controller);
        },
    )?;
    if show_admitted(controller) {
        publish(app, controller);
    }
    let paths = runtime::runtime_paths(app)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|error| error.to_string())?;
    if names.is_empty() {
        return Err("Choose at least one sandbox to export.".into());
    }
    if checkpoint_id.is_some() && names.len() != 1 {
        return Err("Exporting from a checkpoint supports one sandbox at a time.".into());
    }
    let mut sources = Vec::new();
    for name in names {
        runtime::validate_name(name).map_err(|error| error.to_string())?;
        let machine = metadata
            .machines
            .iter()
            .find(|machine| machine.is_vm() && machine.name() == name)
            .ok_or_else(|| {
                format!("Sandbox '{name}' is not managed by Silo. Choose a Silo sandbox to export.")
            })?;
        let mut inspected = inspect(&paths, name)?;
        runtime::ensure_managed(&inspected).map_err(|error| error.to_string())?;
        canonicalize_backup_runtime(&mut inspected.config)?;
        backup_volumes(machine, &mut inspected)?;
        // A checkpoint export reuses the checkpoint's immutable member from its
        // lineage group; a state export captures the sandbox's current disk.
        let (snapshot_group, existing_member) = match checkpoint_id {
            Some(checkpoint_id) => {
                let (group, member, _scope, _name) =
                    runtime::checkpoints::export_source(&paths, machine.id(), checkpoint_id)
                        .map_err(|error| error.to_string())?;
                (group, Some(member))
            }
            None => (
                runtime::checkpoints::ensure_snapshot_group(&paths, machine.id(), machine.name())
                    .map_err(|error| error.to_string())?,
                None,
            ),
        };
        sources.push(backup::BackupSource {
            name: name.clone(),
            snapshot_group,
            was_running: existing_member.is_none() && inspected.status == "Running",
            runtime_config: inspected.config,
            machine_config: serde_json::to_value(machine).map_err(|error| error.to_string())?,
            existing_member,
        });
    }
    let result = controller.service.create_backup_with_token(
        backup::BackupRequest {
            destination: archive_path.to_path_buf(),
            sources,
        },
        cancellation,
        recovery::token(controller)?.as_deref(),
        &|source, member| recovery::export_capture_intent(controller, source, member),
    );
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            if let Err(cleanup) =
                recovery::settle_export_capture(&runtime::ProcessRunner, &paths, controller)
            {
                return Err(format!("{error} {cleanup}").into());
            }
            return Err(error.into());
        }
    };
    // Exports capture running sandboxes in place; they never stop or restart one.
    let inspection = backup::ArchiveInspection {
        created_at_ms: result.created_at_ms,
        size_bytes: result.size_bytes,
        sandboxes: result.sandboxes,
    };
    Ok(archive_from(&result.destination, &inspection))
}

fn backup_volumes(
    machine: &runtime::MachineConfiguration,
    inspected: &mut runtime::InspectedSandbox,
) -> Result<(), String> {
    let runtime::MachineConfiguration::Vm {
        name,
        workspace_storage_gib,
        runtime_storage_gib,
        ..
    } = machine
    else {
        return Err("Only local sandboxes have exportable disk storage.".into());
    };
    if !normalize_backup_root_capacity(
        &mut inspected.config,
        u64::from(*runtime_storage_gib) * 1024,
    ) {
        return Err(format!(
            "{name} root disk capacity does not match its saved runtime storage."
        ));
    }
    let mounts = inspected
        .config
        .get("mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{name} does not report its mounted storage."))?;
    if mounts.iter().any(|mount| {
        !matches!(
            mount.get("type").and_then(Value::as_str),
            Some("Tmpfs" | "Owned")
        )
    }) {
        return Err(format!(
            "{name} uses host-linked storage that cannot be included in a portable checkpoint."
        ));
    }
    let workspace = mounts
        .iter()
        .filter(|mount| {
            mount.get("guest").and_then(Value::as_str) == Some(runtime::WORKSPACE_MOUNT)
        })
        .collect::<Vec<_>>();
    let capacity_mib = u64::from(*workspace_storage_gib).checked_mul(1024);
    if workspace.len() != 1
        || workspace[0].get("type").and_then(Value::as_str) != Some("Owned")
        || workspace[0]
            .pointer("/storage/kind")
            .and_then(Value::as_str)
            != Some("disk")
        || workspace[0]
            .pointer("/storage/capacity_mib")
            .and_then(Value::as_u64)
            != capacity_mib
    {
        return Err(format!(
            "{name} does not use the expected owned workspace disk."
        ));
    }
    // MicroSandbox's snapshot already captures this owned disk with the root;
    // a second Silo payload would duplicate it and could diverge from the VM.
    Ok(())
}

fn normalize_backup_root_capacity(config: &mut Value, expected_mib: u64) -> bool {
    let Some(root) = config
        .pointer_mut("/image/Oci/root_disk")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    if let Some(size) = root.get("size_mib") {
        return size.as_u64() == Some(expected_mib);
    }
    // MicroSandbox 0.7.2 (60d4dc8, sdk/rust/lib/sandbox/config.rs) uses
    // 4096 MiB for an omitted managed OCI upper size. Materialize that
    // effective value in the archive; strict import validation stays intact.
    if root.get("kind").and_then(Value::as_str) != Some("managed") || expected_mib != 4096 {
        return false;
    }
    root.insert("size_mib".into(), Value::from(4096));
    true
}

fn canonicalize_backup_runtime(config: &mut Value) -> Result<(), String> {
    let object = config
        .as_object_mut()
        .ok_or("The runtime returned invalid sandbox settings.")?;
    if let Some(policy) = object.remove("external_mount_policy") {
        if policy != "strict" {
            return Err("The sandbox uses an unsupported external mount policy.".into());
        }
    }
    if let Some(parent) = object.remove("snapshot_parent") {
        let valid = parent.as_str().is_some_and(|id| {
            id.strip_prefix("snap_").is_some_and(|suffix| {
                suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        });
        if !valid {
            return Err("The sandbox has invalid checkpoint ancestry.".into());
        }
    }
    if let Some(interface) = object
        .get_mut("network")
        .and_then(|network| network.get_mut("interface"))
        .and_then(Value::as_object_mut)
    {
        if !interface.is_empty() {
            let ipv6 = interface.get("ipv6_address");
            let valid = interface.len() == if ipv6.is_some() { 4 } else { 3 }
                && interface
                    .get("ipv4_address")
                    .and_then(Value::as_str)
                    .is_some_and(|address| address.parse::<std::net::Ipv4Addr>().is_ok())
                && ipv6.is_none_or(|address| {
                    address
                        .as_str()
                        .is_some_and(|address| address.parse::<std::net::Ipv6Addr>().is_ok())
                })
                && interface
                    .get("mac")
                    .and_then(Value::as_array)
                    .is_some_and(|mac| {
                        mac.len() == 6
                            && mac
                                .iter()
                                .all(|part| part.as_u64().is_some_and(|value| value <= 255))
                    })
                && interface.get("mtu").and_then(Value::as_u64) == Some(1500);
            if !valid {
                return Err("The sandbox has an unsupported network interface.".into());
            }
            interface.clear();
        }
    }
    Ok(())
}

fn inspect(paths: &runtime::RuntimePaths, name: &str) -> Result<runtime::InspectedSandbox, String> {
    let output = runtime::run_msb(
        paths,
        &[
            "inspect".into(),
            name.into(),
            "--format".into(),
            "json".into(),
        ],
        Duration::from_secs(10),
    )
    .map_err(|error| error.to_string())?;
    serde_json::from_str(&output.stdout)
        .map_err(|_| format!("The bundled runtime returned invalid state for sandbox '{name}'."))
}

#[tauri::command]
pub(crate) async fn start_restore(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    archive_path: String,
    new_name: String,
    source_name: Option<String>,
) -> Result<(), String> {
    require_main(&window)?;
    // A rejection before the import starts is returned to the caller, which shows it
    // in place; only the background outcome (see `notify_transfer`) reaches the system.
    start_restore_inner(app, window, controller, archive_path, new_name, source_name).await
}

/// Tell the system about a finished export or import. The Backup screen shows the result
/// itself, so this only adds a system notice (failures, and successes long enough that
/// the user likely looked away).
fn notify_transfer(app: &AppHandle, operation: &Operation, elapsed: std::time::Duration) {
    let Operation::Result {
        operation: kind,
        archive,
        target_name,
        outcome,
        message,
        ..
    } = operation
    else {
        return;
    };
    let names: Vec<&str> = match target_name {
        Some(name) => vec![name.as_str()],
        None => archive.sandboxes.iter().map(String::as_str).collect(),
    };
    let sandbox = match names.as_slice() {
        [only] => sandbox_identity(app, only),
        _ => None,
    };
    let label = match names.as_slice() {
        [only] => (*only).to_string(),
        [] => "sandboxes".to_string(),
        many => format!("{} sandboxes", many.len()),
    };
    if let Some(notice) =
        crate::notifications::transfer_notice(kind, &label, sandbox, elapsed, outcome, message)
    {
        crate::notifications::notify_native(app, notice);
    }
}

/// Best-effort stable id for a sandbox name, so the notice can route and be cleared.
fn sandbox_identity(app: &AppHandle, name: &str) -> Option<crate::notifications::NoticeSandbox> {
    let paths = runtime::runtime_paths(app).ok()?;
    let metadata = runtime::read_metadata(&paths.metadata).ok()?;
    metadata
        .machines
        .iter()
        .find(|machine| machine.is_vm() && machine.name() == name)
        .map(|machine| crate::notifications::NoticeSandbox {
            id: machine.id().to_string(),
            name: name.to_string(),
        })
}

async fn start_restore_inner(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    archive_path: String,
    new_name: String,
    source_name: Option<String>,
) -> Result<(), String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    // Saving the journal is an fsynced write; keep it off the async workers (E-39).
    tauri::async_runtime::spawn_blocking(move || {
        begin_import(app, controller, archive_path, new_name, source_name)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn begin_import(
    app: AppHandle,
    controller: Arc<Controller>,
    archive_path: String,
    new_name: String,
    source_name: Option<String>,
) -> Result<(), String> {
    runtime::validate_name(&new_name).map_err(|error| error.to_string())?;
    if let Some(source_name) = &source_name {
        runtime::validate_name(source_name).map_err(|error| error.to_string())?;
    }
    if !Path::new(&archive_path).is_absolute() {
        return Err("Choose the export file again.".into());
    }
    controller
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another export or import is running.".to_string())?;
    let path = PathBuf::from(&archive_path);
    let cancellation = backup::Cancellation::default();
    let archive = Archive {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        archive_path,
        completed_label: "Checking export file".into(),
        size: "Unknown".into(),
        destination: path
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .into_owned(),
        sandboxes: source_name.iter().cloned().collect(),
        checkpoint_name: None,
    };
    if let Err(error) = recovery::begin(
        &controller,
        recovery::Journal::restore(archive.clone(), new_name.clone(), source_name.clone()),
    ) {
        finish(&controller);
        return Err(error);
    }
    {
        let mut view = controller
            .view
            .lock()
            // `busy` and the journal are already claimed; returning here would
            // strand them, so recover a poisoned view instead (E-44).
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        view.cancellation = Some(cancellation.clone());
        view.operation = Some(Operation::Running {
            operation: "restore",
            archive: archive.clone(),
            running_names: Vec::new(),
            target_name: Some(new_name.clone()),
            progress: 0,
            indeterminate: Some(true),
            can_cancel: None,
            phases: vec![Phase {
                title: "Checking export file".into(),
                detail: "Verifying the export before importing.".into(),
                tone: "running",
            }],
        });
    }
    publish(&app, &controller);
    let (failure_archive, target) = (archive.clone(), Some(new_name.clone()));
    let (work_app, work_controller) = (app.clone(), controller.clone());
    let work = move || {
        run_restore(
            work_app,
            work_controller,
            path,
            new_name,
            source_name,
            cancellation,
            archive,
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        if contain_worker_panic(&controller, "restore", &failure_archive, target, work) {
            publish(&app, &controller);
        }
    });
    Ok(())
}

fn run_restore(
    app: AppHandle,
    controller: Arc<Controller>,
    path: PathBuf,
    new_name: String,
    source_name: Option<String>,
    cancellation: backup::Cancellation,
    archive: Archive,
) {
    let started = std::time::Instant::now();
    let mut archive = archive;
    let result = (|| {
        // The review already hashed the whole file and the import verifies
        // the selected payload as it unpacks, so read only the manifest (E-26).
        let inspection = controller.service.describe_archive(&path, &cancellation)?;
        let selected = select_archive_source(&inspection.sandboxes, source_name.as_deref())?;
        archive = archive_from(&path, &inspection);
        if let Ok(mut view) = controller.view.lock() {
            if let Some(Operation::Running {
                archive: current, ..
            }) = view.operation.as_mut()
            {
                *current = archive.clone();
            }
        }
        restore_work(
            &app,
            &controller,
            &path,
            &selected,
            &new_name,
            &cancellation,
        )?;
        Ok::<_, TransferError>(selected)
    })();
    let operation = match result {
        Ok(_) => Operation::Result {
            operation: "restore",
            archive,
            running_names: Vec::new(),
            target_name: Some(new_name.clone()),
            outcome: "success",
            title: "Import complete".into(),
            message: "Sandbox imported.".into(),
            detail: None,
        },
        Err(error) => failed_transfer("restore", archive, Some(new_name), error),
    };
    let operation = recovery::complete(&controller, operation);
    notify_transfer(&app, &operation, started.elapsed());
    let _ = set_operation(&controller, operation);
    finish(&controller);
    publish(&app, &controller);
}

fn select_archive_source(names: &[String], selected: Option<&str>) -> Result<String, String> {
    match selected {
        Some(name) if names.iter().any(|candidate| candidate == name) => Ok(name.into()),
        Some(_) => Err("The selected sandbox is not in this export.".into()),
        None if names.len() == 1 => Ok(names[0].clone()),
        None => Err("Choose which sandbox to import from this export.".into()),
    }
}

fn restore_work(
    app: &AppHandle,
    controller: &Controller,
    archive: &Path,
    source_name: &str,
    new_name: &str,
    cancellation: &backup::Cancellation,
) -> Result<(), TransferError> {
    let paths = runtime::runtime_paths(app)?;
    restore_at_paths(
        &paths,
        controller,
        archive,
        source_name,
        new_name,
        cancellation,
        &|title| {
            advance_restore_phase(controller, title);
            publish(app, controller);
        },
    )
}

fn advance_restore_phase(controller: &Controller, title: &str) {
    if let Ok(mut view) = controller.view.lock() {
        if let Some(Operation::Running { phases, .. }) = view.operation.as_mut() {
            for phase in phases.iter_mut() {
                phase.tone = "succeeded";
            }
            phases.push(Phase {
                title: title.into(),
                detail: String::new(),
                tone: "running",
            });
        }
    }
}

fn restore_at_paths(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    archive: &Path,
    source_name: &str,
    new_name: &str,
    cancellation: &backup::Cancellation,
    progress: &dyn Fn(&str),
) -> Result<(), TransferError> {
    progress("Preparing import");
    let _guard = mutation_guard(
        cancellation,
        runtime::operation_gate::OperationKind::Import,
        "Importing sandbox",
        false,
        &|| progress(QUEUED_PHASE),
    )?;
    let original = runtime::read_metadata(&paths.metadata).map_err(|error| error.to_string())?;
    if original
        .machines
        .iter()
        .any(|machine| machine.name().eq_ignore_ascii_case(new_name))
    {
        return Err(format!("A sandbox named {new_name} already exists.").into());
    }
    let listed = runtime::run_msb(
        &paths,
        &["list".into(), "--format".into(), "json".into()],
        Duration::from_secs(10),
    )
    .map_err(|error| error.to_string())?;
    let listed: Vec<Value> = serde_json::from_str(&listed.stdout)
        .map_err(|_| "The bundled runtime returned an invalid sandbox list.".to_string())?;
    if listed.iter().any(|sandbox| {
        sandbox
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.eq_ignore_ascii_case(new_name))
    }) {
        return Err(format!("A runtime sandbox named {new_name} already exists.").into());
    }
    progress("Unpacking export");
    let result = unpack_and_save(
        paths,
        controller,
        archive,
        source_name,
        new_name,
        cancellation,
        progress,
        original,
    );
    result.map_err(|error| {
        let mut error = error.after_unpacking();
        if let Err(cleanup) = recovery::discard_pending_import(paths, controller) {
            error.message = format!("{} {cleanup}", error.message);
        }
        error
    })
}

fn unpack_and_save(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    archive: &Path,
    source_name: &str,
    new_name: &str,
    cancellation: &backup::Cancellation,
    progress: &dyn Fn(&str),
    original: runtime::MachineConfigurationRequest,
) -> Result<(), TransferError> {
    let group = backup::new_import_group();
    let prepared = controller.service.prepare_restore_in_group(
        backup::RestoreRequest {
            archive: archive.to_path_buf(),
            source_name: Some(source_name.into()),
            new_name: new_name.into(),
        },
        &group,
        cancellation,
        &|| {
            recovery::save_restore_group(controller, &group)
                .map_err(backup::BackupError::InvalidRequest)
        },
    )?;
    // Until the new sandbox is saved, a failure removes the loaded import
    // group instead of stranding it in the native store (E-23).
    let import_group = controller
        .service
        .discard_import_on_failure(&prepared.snapshot_group);
    if prepared.source_name != source_name || prepared.new_name != new_name {
        return Err("The imported sandbox identity does not match the verified export file. Choose the export file again and retry the import.".into());
    }
    if prepared.runtime_config.get("name").and_then(Value::as_str) != Some(source_name) {
        return Err("The sandbox name in the export file does not match its settings. Choose another export file.".into());
    }
    let mut machine_value = prepared.machine_config.clone();
    let object = machine_value
        .as_object_mut()
        .ok_or("The export file has invalid sandbox settings. Choose another export file or export the original sandbox again.")?;
    let id = uuid::Uuid::new_v4().to_string();
    object.insert("id".into(), Value::String(id.clone()));
    object.insert("name".into(), Value::String(new_name.into()));
    let machine: runtime::MachineConfiguration = serde_json::from_value(machine_value)
        .map_err(|_| "The export file has invalid sandbox settings. Choose another export file or export the original sandbox again.".to_string())?;
    if !matches!(machine, runtime::MachineConfiguration::Vm { .. }) {
        return Err("The export file does not contain settings for a local sandbox. Choose another export file.".into());
    }
    enter_commit(controller, cancellation)?;
    progress("Saving stopped sandbox");
    commit_import(
        paths,
        controller,
        original,
        machine,
        &id,
        &prepared.snapshot_group,
        &prepared.snapshot_member,
    )?;
    import_group.keep();
    Ok(())
}

/// Saves an imported sandbox. Its id and snapshot group are journaled first,
/// so a relaunch can tell a finished import (settings saved: the commit point)
/// from one to clean up (E-24). A failure before the commit removes the
/// checkpoint record; if that cleanup fails, the journal keeps the identity
/// and the next launch retries it.
fn commit_import(
    paths: &runtime::RuntimePaths,
    controller: &Controller,
    original: runtime::MachineConfigurationRequest,
    machine: runtime::MachineConfiguration,
    id: &str,
    group: &str,
    member: &str,
) -> Result<(), String> {
    recovery::save_restore_identity(controller, id, group)?;
    let discard = |error: String| {
        let _ = recovery::discard_uncommitted_import(paths, controller, id, Some(group));
        Err(error)
    };
    if let Err(error) = runtime::checkpoints::import_pending_restore(paths, id, group, member) {
        return discard(error.to_string());
    }
    let mut updated = original;
    updated.machines.push(machine);
    if let Err(error) = runtime::write_metadata(&paths.metadata, &updated) {
        // A late failure (after the file was replaced) still saved the sandbox.
        let saved = runtime::read_metadata(&paths.metadata)
            .is_ok_and(|metadata| metadata.machines.iter().any(|machine| machine.id() == id));
        return if saved {
            Ok(())
        } else {
            discard(error.to_string())
        };
    }
    Ok(())
}

/// Journal writes are fsynced, so cancel and dismiss run off the main thread (E-39).
#[tauri::command]
pub(crate) async fn cancel_backup_operation(
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
) -> Result<(), String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cancel_operation(&controller))
        .await
        .map_err(|error| error.to_string())?
}

fn cancel_operation(controller: &Controller) -> Result<(), String> {
    {
        let view = controller.view.lock().map_err(|_| {
            "Export and import status could not be read. Relaunch Silo and retry.".to_string()
        })?;
        if matches!(
            view.operation,
            Some(Operation::Running {
                can_cancel: Some(false),
                ..
            })
        ) {
            return Err("This operation is finishing and can no longer be cancelled.".into());
        }
        // Cancel in process first, under the state lock so it is ordered
        // against `enter_commit`: a journal write failure (full disk,
        // permissions) must not leave the running operation uncancellable.
        // The persisted flag only matters for a later relaunch.
        view.cancellation
            .as_ref()
            .ok_or("No export or import is running.")?
            .cancel();
    }
    let _ = recovery::cancel(controller);
    Ok(())
}

/// Past this point an import saves its new sandbox and is no longer
/// cancelled. Marking it under the state lock orders it against
/// `cancel_operation`: a cancel either lands first and wins, or is refused
/// and the UI stops offering it (E-28).
fn enter_commit(
    controller: &Controller,
    cancellation: &backup::Cancellation,
) -> Result<(), TransferError> {
    let mut view = controller
        .view
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cancellation.cancelled() {
        return Err(TransferError::cancelled());
    }
    if let Some(Operation::Running { can_cancel, .. }) = view.operation.as_mut() {
        *can_cancel = Some(false);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn dismiss_backup_operation(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    expected_operation: Value,
    expected_operation_id: Option<String>,
) -> Result<bool, String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Report whether the result was actually dismissed so the caller does not
        // hide a result the backend still holds (E-49).
        let dismissed = dismiss_finished_operation(
            &controller,
            Some(&expected_operation),
            expected_operation_id.as_deref(),
        )?;
        if dismissed {
            publish(&app, &controller);
        }
        Ok(dismissed)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn dismiss_finished_operation(
    controller: &Controller,
    expected: Option<&Value>,
    expected_id: Option<&str>,
) -> Result<bool, String> {
    let mut view = controller.view.lock().map_err(|_| {
        "Export and import status could not be read. Relaunch Silo and retry.".to_string()
    })?;
    if matches!(view.operation, Some(Operation::Running { .. })) {
        return Ok(false);
    }
    // A pending journal with no worker means relaunch recovery failed and is
    // showing its failure. Dismissing that failure abandons the retry (E-43);
    // otherwise the operation would block startup and updates on every launch.
    let abandon = recovery::unresolved(controller)?;
    if abandon
        && !matches!(
            view.operation,
            Some(Operation::Result {
                outcome: "failed",
                ..
            })
        )
    {
        return Ok(false);
    }
    if recovery::token(controller)?.as_deref() != expected_id {
        return Ok(false);
    }
    if let Some(expected) = expected {
        if serde_json::to_value(&view.operation).map_err(|e| e.to_string())? != *expected {
            return Ok(false);
        }
    }
    if abandon {
        recovery::abandon(controller)?;
    }
    recovery::dismiss(controller)?;
    Ok(view.operation.take().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn history_controller(path: PathBuf) -> Controller {
        Controller {
            history_path: path,
            journal: Mutex::new(None),
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: PathBuf::from("/unused/msb"),
                    home: PathBuf::from("/unused/home"),
                    storage_home: None,
                    library: PathBuf::from("/unused/library"),
                },
                PathBuf::from("/unused/scratch"),
            ),
            view: Mutex::new(ViewState {
                journal_error: None,
                destination: Some(PathBuf::from("/backups")),
                operation: None,
                cancellation: None,
                inspection: None,
            }),
            busy: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        }
    }

    /// A controller whose backup runner uses a scripted `msb` in the runtime
    /// home of `paths` with a two-member import `group`: `snapshot list` prints `snapshots.json` from the temp
    /// dir, every call is appended to `calls`, and `snapshot remove` fails
    /// while a `refuse-remove` file exists.
    pub(super) fn controller_with_scripted_msb(
        directory: &Path,
        paths: &runtime::RuntimePaths,
        group: &str,
    ) -> Controller {
        use std::os::unix::fs::PermissionsExt;
        let script = directory.join("scripted-msb");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{calls}'\ncase \"$1 $2\" in\n  'snapshot list') cat '{list}' ;;\n  'snapshot remove') [ -e '{refuse}' ] && exit 1 ;;\nesac\nexit 0\n",
                calls = directory.join("calls").display(),
                list = directory.join("snapshots.json").display(),
                refuse = directory.join("refuse-remove").display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let parent = format!("sha256:{}", "a".repeat(64));
        fs::write(
            directory.join("snapshots.json"),
            serde_json::json!([
                {"group": group, "name": "imported-parent", "snapshot_id": format!("snap_{}", "0".repeat(32)), "digest": parent, "parent_digest": null, "availability": "ready"},
                {"group": group, "name": "imported-member", "snapshot_id": format!("snap_{}", "1".repeat(32)), "digest": format!("sha256:{}", "b".repeat(64)), "parent_digest": format!("snap_{}", "0".repeat(32)), "availability": "ready"},
                {"group": "dev", "name": "kept", "snapshot_id": format!("snap_{}", "2".repeat(32)), "availability": "ready"}
            ])
            .to_string(),
        )
        .unwrap();
        Controller {
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: script,
                    home: paths.home.clone(),
                    storage_home: None,
                    library: paths.library.clone(),
                },
                directory.join("scratch"),
            ),
            ..history_controller(directory.join("backup-history.json"))
        }
    }

    pub(super) fn scripted_calls(directory: &Path) -> Vec<String> {
        fs::read_to_string(directory.join("calls"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    pub(super) fn completed_archive() -> Archive {
        Archive {
            name: "saved.silo-backup".into(),
            archive_path: "/backups/saved.silo-backup".into(),
            completed_label: "Verified archive".into(),
            size: "1 GiB".into(),
            destination: "/backups".into(),
            sandboxes: vec!["dev".into()],
            checkpoint_name: None,
        }
    }

    #[test]
    fn export_sizes_label_binary_units() {
        let _test_state = crate::test_support::global_state();
        assert_eq!(display_size(3 * GIB), "3.0 GiB");
        assert_eq!(display_size(5 * 1024 * 1024), "5.0 MiB");
    }

    #[test]
    fn update_guard_refuses_while_an_interrupted_operation_is_pending() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = Arc::new(history_controller(
            directory.path().join("backup-history.json"),
        ));
        recovery::begin(
            &controller,
            recovery::Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        let error = update_guard_for(controller.clone())
            .err()
            .expect("a pending journal must block updates");
        assert!(error.contains("interrupted export or import"), "{error}");
        assert!(!controller.busy.load(Ordering::Acquire));
    }

    #[test]
    fn cancel_sets_the_in_process_flag_even_when_the_journal_cannot_be_saved() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let storage = directory.path().join("storage");
        let controller = history_controller(storage.join("backup-history.json"));
        recovery::begin(
            &controller,
            recovery::Journal::restore(completed_archive(), "restored".into(), Some("dev".into())),
        )
        .unwrap();
        let cancellation = backup::Cancellation::default();
        controller.view.lock().unwrap().cancellation = Some(cancellation.clone());
        // Make every later journal write fail.
        fs::remove_dir_all(&storage).unwrap();
        fs::write(&storage, b"not a directory").unwrap();
        cancel_operation(&controller).unwrap();
        assert!(cancellation.cancelled());
    }

    #[test]
    fn dismissing_a_failed_recovery_abandons_it_and_keeps_files() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        recovery::begin(
            &controller,
            recovery::Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        let failure = Operation::Result {
            operation: "backup",
            archive: completed_archive(),
            target_name: None,
            running_names: vec![],
            outcome: "failed",
            title: "Could not resume the interrupted operation".into(),
            message: "Destination unavailable".into(),
            detail: None,
        };
        set_operation(&controller, failure.clone()).unwrap();
        let leftover = directory.path().join("leftover");
        fs::write(&leftover, b"kept").unwrap();
        assert!(recovery::unresolved(&controller).unwrap());
        let id = recovery::token(&controller).unwrap();
        assert!(dismiss_finished_operation(
            &controller,
            Some(&serde_json::to_value(Some(failure)).unwrap()),
            id.as_deref(),
        )
        .unwrap());
        assert!(!recovery::pending(&controller).unwrap());
        assert!(recovery::load(&path).unwrap().is_none());
        assert!(leftover.exists());
        assert!(update_guard_for(Arc::new(history_controller(path))).is_ok());
    }

    #[test]
    fn a_pending_journal_without_a_failed_result_is_not_abandoned() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        recovery::begin(
            &controller,
            recovery::Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        let id = recovery::token(&controller).unwrap();
        assert!(!dismiss_finished_operation(
            &controller,
            Some(&serde_json::Value::Null),
            id.as_deref()
        )
        .unwrap());
        assert!(recovery::pending(&controller).unwrap());
    }

    #[test]
    fn a_panicking_worker_records_a_failure_and_releases_the_slot() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        recovery::begin(
            &controller,
            recovery::Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        controller.busy.store(true, Ordering::Release);
        controller.view.lock().unwrap().cancellation = Some(backup::Cancellation::default());
        assert!(contain_worker_panic(
            &controller,
            "backup",
            &completed_archive(),
            None,
            || panic!("worker bug")
        ));
        assert!(!controller.busy.load(Ordering::Acquire));
        assert!(!recovery::pending(&controller).unwrap());
        let view = controller.view.lock().unwrap();
        assert!(view.cancellation.is_none());
        assert!(matches!(
            view.operation,
            Some(Operation::Result {
                outcome: "failed",
                ..
            })
        ));
        drop(view);
        assert!(!contain_worker_panic(
            &controller,
            "backup",
            &completed_archive(),
            None,
            || {}
        ));
    }

    fn completed_operation(archive: Archive, outcome: &'static str) -> Operation {
        Operation::Result {
            operation: "backup",
            archive,
            running_names: Vec::new(),
            target_name: None,
            outcome,
            title: "Export complete".into(),
            message: "Done".into(),
            detail: None,
        }
    }

    #[test]
    fn reveal_allows_the_current_completed_export_when_the_file_exists() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("saved.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();

        let operation = completed_operation(archive.clone(), "success");
        let resolved = authorize_reveal(Some(&operation), &path).unwrap();
        assert_eq!(resolved, file);
        for outcome in ["restart-required", "cancelled"] {
            let operation = completed_operation(archive.clone(), outcome);
            assert!(authorize_reveal(Some(&operation), &path).is_err());
        }
    }

    #[test]
    fn reveal_rejects_an_earlier_export_that_is_no_longer_the_current_result() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("earlier.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let path = file.to_string_lossy().into_owned();

        assert!(authorize_reveal(None, &path).is_err());
    }

    #[test]
    fn reveal_rejects_a_path_other_than_the_current_export() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let stranger = directory.path().join("stranger.silo-backup");
        std::fs::write(&stranger, b"archive").unwrap();

        let mut archive = completed_archive();
        archive.archive_path = directory
            .path()
            .join("known.silo-backup")
            .to_string_lossy()
            .into_owned();
        std::fs::write(directory.path().join("known.silo-backup"), b"archive").unwrap();

        let operation = completed_operation(archive, "success");
        let error = authorize_reveal(Some(&operation), &stranger.to_string_lossy()).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn reveal_rejects_a_traversal_or_non_identical_path() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("saved.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let mut archive = completed_archive();
        archive.archive_path = file.to_string_lossy().into_owned();

        // A path that resolves to the same file but is not byte-identical.
        let traversal = directory
            .path()
            .join("sub")
            .join("..")
            .join("saved.silo-backup")
            .to_string_lossy()
            .into_owned();
        assert_ne!(traversal, archive.archive_path);

        let operation = completed_operation(archive, "success");
        let error = authorize_reveal(Some(&operation), &traversal).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn reveal_rejects_a_known_archive_whose_file_is_missing() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("gone.silo-backup");
        let path = missing.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();
        let operation = completed_operation(archive.clone(), "success");

        let error = authorize_reveal(Some(&operation), &path).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn reveal_rejects_a_failed_operation_even_when_the_file_exists() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("saved.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();
        let operation = completed_operation(archive, "failed");

        let error = authorize_reveal(Some(&operation), &path).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn legacy_managed_root_default_is_materialized_only_when_saved_capacity_matches() {
        let _test_state = crate::test_support::global_state();
        let legacy = serde_json::json!({"image":{"Oci":{"root_disk":{"kind":"managed"}}}});
        let mut matching = legacy.clone();
        assert!(normalize_backup_root_capacity(&mut matching, 4096));
        assert_eq!(
            matching.pointer("/image/Oci/root_disk/size_mib"),
            Some(&Value::from(4096))
        );

        let mut wrong_saved_capacity = legacy;
        assert!(!normalize_backup_root_capacity(
            &mut wrong_saved_capacity,
            8192
        ));
        assert!(wrong_saved_capacity
            .pointer("/image/Oci/root_disk/size_mib")
            .is_none());

        let mut explicit_mismatch =
            serde_json::json!({"image":{"Oci":{"root_disk":{"kind":"managed","size_mib":8192}}}});
        assert!(!normalize_backup_root_capacity(
            &mut explicit_mismatch,
            4096
        ));
        assert_eq!(
            explicit_mismatch.pointer("/image/Oci/root_disk/size_mib"),
            Some(&Value::from(8192))
        );
    }

    #[test]
    fn migrated_native_config_exports_only_the_current_empty_github_policy() {
        let _test_state = crate::test_support::global_state();
        let network: Value =
            serde_json::from_str(include_str!("../guest/github-network-default.json")).unwrap();
        let mut inspected = serde_json::json!({
            "name":"legacy",
            "image":{"Oci":{"reference":"ubuntu","root_disk":{"kind":"managed"}}},
            "resources":{"cpus":1,"max_cpus":1,"memory_mib":1024,"max_memory_mib":1024},
            "runtime":{"workdir":null,"shell":"/bin/sh","scripts":{},"entrypoint":null,"cmd":["/bin/bash"],"hostname":null,"user":null,"log_level":null,"metrics_sample_interval_ms":1000,"disable_metrics_sample":false},
            "env":[],"labels":{"silo.managed":"true","silo.working-account":"1"},"rlimits":[],
            "mounts":[{"type":"Owned","guest":"/workspace","storage":{"kind":"disk","capacity_mib":1024}}],
            "patches":[],"network":network,"init":null,"pull_policy":"IfMissing",
            "security_profile":"default","deployment_profile":"single_tenant",
            "lifecycle":{"ephemeral":false,"max_duration_secs":null,"idle_timeout_secs":null},
            "external_mount_policy":"strict",
            "snapshot_parent":"snap_174f34b70bd7ec64dc487d6aa763cf3b"
        });
        inspected["network"]["interface"] = serde_json::json!({
            "ipv4_address":"172.16.0.6","ipv6_address":"fd42:6d73:62:1::2",
            "mac":[2,109,115,0,1,2],"mtu":1500
        });
        canonicalize_backup_runtime(&mut inspected).unwrap();
        assert!(normalize_backup_root_capacity(&mut inspected, 4096));
        backup::validate_snapshottable_config("legacy", &inspected).unwrap();
        assert_eq!(inspected["network"]["interface"], serde_json::json!({}));
        assert!(inspected.get("snapshot_parent").is_none());

        let mut credential = inspected.clone();
        credential["network"]["secrets"]["secrets"][0]["value"] = Value::from("real-token");
        assert!(backup::validate_snapshottable_config("legacy", &credential).is_err());
        let mut custom_policy = inspected.clone();
        custom_policy["network"]["policy"]["default_egress"] = Value::from("allow");
        assert!(backup::validate_snapshottable_config("legacy", &custom_policy).is_err());
        let mut unknown_interface = inspected;
        unknown_interface["network"]["interface"] = serde_json::json!({"custom":"host"});
        assert!(canonicalize_backup_runtime(&mut unknown_interface).is_err());
        let mut invalid_ipv6 = unknown_interface;
        invalid_ipv6["network"]["interface"] = serde_json::json!({
            "ipv4_address":"172.16.0.6","ipv6_address":"not an IPv6 address",
            "mac":[2,109,115,0,1,2],"mtu":1500
        });
        assert!(canonicalize_backup_runtime(&mut invalid_ipv6).is_err());
    }

    #[test]
    fn the_chosen_destination_survives_reload_and_exports_are_not_recorded() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        remember_destination(&controller, directory.path().to_path_buf());
        let saved = load_saved(&path);
        assert_eq!(saved.destination.as_deref(), Some(directory.path()));
        assert!(saved.journal_error.is_none());
        let bytes = fs::read_to_string(path).unwrap();
        assert!(!bytes.contains("silo-backup"), "{bytes}");
    }

    #[test]
    fn a_destination_that_cannot_be_saved_is_still_used_this_session() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("not-a-directory");
        fs::write(&blocked, b"preserve").unwrap();
        let controller = history_controller(blocked.join("backup-history.json"));
        remember_destination(&controller, PathBuf::from("/Volumes/Exports"));
        assert_eq!(
            controller.view.lock().unwrap().destination.as_deref(),
            Some(Path::new("/Volumes/Exports"))
        );
        assert_eq!(fs::read(&blocked).unwrap(), b"preserve");
    }

    #[test]
    fn unreadable_or_newer_export_history_never_blocks_exports_or_imports() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        for saved in [
            &b"broken history"[..],
            br#"{"schemaVersion":2,"destination":"/backups","archives":[]}"#,
        ] {
            fs::write(&path, saved).unwrap();
            let loaded = load_saved(&path);
            assert!(loaded.destination.is_none());
            assert!(loaded.journal_error.is_none());
        }
        // An older build's history with recorded exports still yields its destination.
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "destination": "/backups",
                "archives": [serde_json::to_value(completed_archive()).unwrap()],
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_saved(&path).destination,
            Some(PathBuf::from("/backups"))
        );
    }

    #[test]
    fn an_unreadable_saved_operation_still_blocks_new_transfers() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        fs::write(directory.path().join("backup-operation.json"), b"broken").unwrap();
        let loaded = load_saved(&path);
        assert!(loaded.journal.is_none());
        assert!(loaded.journal_error.is_some());
    }

    #[test]
    fn backup_operation_serialization_matches_frontend_contract() {
        let _test_state = crate::test_support::global_state();
        let archive = completed_archive();
        let operations = [
            Operation::Running {
                operation: "restore",
                archive: archive.clone(),
                running_names: Vec::new(),
                target_name: Some("restored".into()),
                progress: 5,
                indeterminate: None,
                can_cancel: Some(false),
                phases: vec![Phase {
                    title: "Import".into(),
                    detail: "Creating sandbox".into(),
                    tone: "running",
                }],
            },
            Operation::Result {
                operation: "restore",
                archive,
                running_names: Vec::new(),
                target_name: Some("restored".into()),
                outcome: "failed",
                title: "Import failed".into(),
                message: "Runtime refused creation".into(),
                detail: Some("No new sandbox was retained".into()),
            },
        ];
        crate::runtime::contract_tests::assert_fixture("backup-operations.json", operations);
    }

    #[test]
    fn stale_result_dismissal_preserves_the_next_running_operation() {
        let _test_state = crate::test_support::global_state();
        let controller = history_controller(PathBuf::from("/unused/history"));
        set_operation(
            &controller,
            Operation::Running {
                operation: "restore",
                archive: completed_archive(),
                running_names: Vec::new(),
                target_name: Some("restored".into()),
                progress: 0,
                indeterminate: Some(true),
                can_cancel: None,
                phases: vec![Phase {
                    title: "Checking export file".into(),
                    detail: String::new(),
                    tone: "running",
                }],
            },
        )
        .unwrap();
        assert!(!dismiss_finished_operation(&controller, None, None).unwrap());
        assert!(matches!(
            controller.view.lock().unwrap().operation,
            Some(Operation::Running { .. })
        ));
        advance_restore_phase(&controller, "Unpacking export");
        let serialized = serde_json::to_value(&controller.view.lock().unwrap().operation).unwrap();
        assert_eq!(serialized["indeterminate"], true);
        assert_eq!(
            serialized["phases"],
            serde_json::json!([
                { "title": "Checking export file", "detail": "", "tone": "succeeded" },
                { "title": "Unpacking export", "detail": "", "tone": "running" },
            ])
        );
        set_operation(
            &controller,
            Operation::Result {
                operation: "restore",
                archive: completed_archive(),
                running_names: Vec::new(),
                target_name: Some("restored".into()),
                outcome: "success",
                title: "Restored".into(),
                message: "Sandbox restored successfully.".into(),
                detail: None,
            },
        )
        .unwrap();
        assert!(dismiss_finished_operation(&controller, None, None).unwrap());
        assert!(!dismiss_finished_operation(&controller, None, None).unwrap());
    }

    #[test]
    fn resumed_work_waits_for_other_sandbox_changes_and_can_cancel_while_waiting() {
        let _test_state = crate::test_support::global_state();
        let guard = runtime::OPERATIONS.computer("Contended work").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let (queued, waiting) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = mutation_guard(
                &backup::Cancellation::default(),
                runtime::operation_gate::OperationKind::Export,
                "Exporting sandbox",
                true,
                &|| queued.send(()).unwrap(),
            )
            .map(drop);
            sender.send(result).unwrap();
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(runtime::OPERATIONS
            .snapshot()
            .waiting
            .iter()
            .any(|entry| entry.label == "Exporting sandbox"));
        assert!(matches!(
            receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));

        let cancellation = backup::Cancellation::default();
        let worker_cancellation = cancellation.clone();
        let (queued, waiting) = std::sync::mpsc::channel();
        let (cancelled, result) = std::sync::mpsc::channel();
        let cancelled_worker = std::thread::spawn(move || {
            let result = mutation_guard(
                &worker_cancellation,
                runtime::operation_gate::OperationKind::Export,
                "Cancelled export",
                true,
                &|| queued.send(()).unwrap(),
            )
            .map(drop);
            cancelled.send(result).unwrap();
        });
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        cancellation.cancel();
        assert!(
            result
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err()
                .cancelled
        );
        cancelled_worker.join().unwrap();
        assert!(!runtime::OPERATIONS
            .snapshot()
            .waiting
            .iter()
            .any(|entry| entry.label == "Cancelled export"));
        // The cancelled waiter must finish while the contending operation still holds its turn.
        assert!(matches!(
            receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        drop(guard);
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn delayed_dismissal_cannot_clear_a_new_completed_operation() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let result = |name: &str| Operation::Result {
            operation: "restore",
            archive: completed_archive(),
            running_names: vec![],
            target_name: Some(name.into()),
            outcome: "success",
            title: "Restore complete".into(),
            message: "Sandbox restored successfully.".into(),
            detail: None,
        };
        let old = serde_json::to_value(result("first")).unwrap();
        set_operation(&controller, result("second")).unwrap();
        assert!(!dismiss_finished_operation(&controller, Some(&old), None).unwrap());
        assert!(
            matches!(&controller.view.lock().unwrap().operation, Some(Operation::Result { target_name: Some(name), .. }) if name == "second")
        );
    }

    #[test]
    fn backup_state_serialization_matches_frontend_contract() {
        let _test_state = crate::test_support::global_state();
        let state = BackupState {
            snapshot_id: "contract".into(),
            operation_id: None,
            availability: "available",
            availability_message: None,
            archives: Vec::new(),
            operation: None,
        };
        let expected: Value =
            serde_json::from_str(include_str!("../../src/test/contracts/backup-state.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(state).unwrap(), expected);
    }

    #[test]
    fn backup_state_reads_only_memory_and_reports_a_saved_operation_error() {
        let _test_state = crate::test_support::global_state();
        // The export folder is on a volume that no longer exists; reading state
        // must not touch it (a stalled mount would freeze every refresh).
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        controller.view.lock().unwrap().destination =
            Some(PathBuf::from("/Volumes/Unplugged/Exports"));
        let state = serde_json::to_value(backup_state(&controller).unwrap()).unwrap();
        assert_eq!(state["availability"], "available");
        for unused in ["destination", "availableSpaceGB", "requiredSpaceGB"] {
            assert!(state.get(unused).is_none(), "{unused}: {state}");
        }
        controller.view.lock().unwrap().journal_error = Some("Saved operation unreadable.".into());
        let state = serde_json::to_value(backup_state(&controller).unwrap()).unwrap();
        assert_eq!(state["availability"], "unavailable");
        assert_eq!(state["availabilityMessage"], "Saved operation unreadable.");
    }

    #[test]
    fn archive_names_never_replace_an_existing_backup() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let names = vec!["dev".into()];
        let first = unique_archive(directory.path(), &names, false);
        fs::write(&first, b"existing").unwrap();
        let second = unique_archive(directory.path(), &names, false);
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"existing");
    }

    #[test]
    fn archive_name_uses_the_sandbox_for_single_exports_and_a_generic_base_otherwise() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let date = {
            let today = time::OffsetDateTime::now_utc();
            format!(
                "{:04}-{:02}-{:02}",
                today.year(),
                today.month() as u8,
                today.day()
            )
        };
        let single = unique_archive(directory.path(), &["dev".into()], false);
        assert_eq!(
            single.file_name().unwrap().to_str().unwrap(),
            format!("dev-{date}.silo-backup")
        );
        let multiple = unique_archive(directory.path(), &["dev".into(), "personal".into()], false);
        assert_eq!(
            multiple.file_name().unwrap().to_str().unwrap(),
            format!("Silo-Export-{date}.silo-backup")
        );
        // A same-day second export of the same sandbox falls back to a "-2" suffix.
        fs::write(&single, b"first").unwrap();
        let next = unique_archive(directory.path(), &["dev".into()], false);
        assert_eq!(
            next.file_name().unwrap().to_str().unwrap(),
            format!("dev-{date}-2.silo-backup")
        );
        // A checkpoint export of a single sandbox carries the "-checkpoint-" marker
        // and keeps the same "-2" suffix fallback.
        let checkpoint = unique_archive(directory.path(), &["dev".into()], true);
        assert_eq!(
            checkpoint.file_name().unwrap().to_str().unwrap(),
            format!("dev-checkpoint-{date}.silo-backup")
        );
        fs::write(&checkpoint, b"first").unwrap();
        let checkpoint_next = unique_archive(directory.path(), &["dev".into()], true);
        assert_eq!(
            checkpoint_next.file_name().unwrap().to_str().unwrap(),
            format!("dev-checkpoint-{date}-2.silo-backup")
        );
    }
    #[test]
    fn a_claimed_export_reports_the_operation_id_its_result_will_carry() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let claimed = claim_export(
            &controller,
            directory.path(),
            directory.path().to_string_lossy().into_owned(),
            &["dev".into()],
            None,
            None,
        )
        .unwrap();
        uuid::Uuid::parse_str(&claimed.operation_id).unwrap();
        assert_eq!(
            recovery::token(&controller).unwrap().as_deref(),
            Some(claimed.operation_id.as_str())
        );
        assert!(claimed.archive_path.starts_with(directory.path()));
        assert!(matches!(
            &controller.view.lock().unwrap().operation,
            Some(Operation::Running { operation: "backup", archive, .. }) if archive.archive_path == claimed.archive_path.to_string_lossy()
        ));
        let second = claim_export(
            &controller,
            directory.path(),
            directory.path().to_string_lossy().into_owned(),
            &["dev".into()],
            None,
            None,
        );
        assert_eq!(
            second.err().as_deref(),
            Some("Another export or import is running.")
        );
        assert_eq!(
            recovery::token(&controller).unwrap().as_deref(),
            Some(claimed.operation_id.as_str())
        );
    }

    fn import_paths(directory: &Path) -> runtime::RuntimePaths {
        runtime::RuntimePaths {
            guest_image: directory.join("guest-image"),
            executable: directory.join("missing-msb"),
            home: directory.join("home"),
            storage_home: None,
            library: directory.join("library"),
            metadata: directory.join("runtime/machines.json"),
            volumes: directory.join("volumes"),
        }
    }

    fn imported_machine(id: &str) -> runtime::MachineConfiguration {
        serde_json::from_value(serde_json::json!({"kind":"vm","id":id,"name":"copy","cpus":1,"maxCPUs":1,"memoryGiB":1,"maxMemoryGiB":1,"workspaceStorageGiB":1,"runtimeStorageGiB":1})).unwrap()
    }

    const GROUP: &str = "silo-import-0123456789abcdef0123456789abcdef";
    const MEMBER: &str = "silo-backup-0-1-2";

    #[test]
    fn an_import_journals_its_identity_before_saving_and_commits_with_its_settings() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = import_paths(directory.path());
        fs::create_dir_all(paths.metadata.parent().unwrap()).unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        recovery::begin(
            &controller,
            recovery::Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let original = runtime::read_metadata(&paths.metadata).unwrap();
        commit_import(
            &paths,
            &controller,
            original,
            imported_machine(&id),
            &id,
            GROUP,
            MEMBER,
        )
        .unwrap();
        assert!(runtime::read_metadata(&paths.metadata)
            .unwrap()
            .machines
            .iter()
            .any(|machine| machine.id() == id));
        let saved = fs::read_to_string(directory.path().join("backup-operation.json")).unwrap();
        assert!(saved.contains(&id) && saved.contains(GROUP), "{saved}");
    }

    #[test]
    fn an_import_that_cannot_save_its_settings_removes_its_record_and_identity() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let paths = import_paths(directory.path());
        fs::create_dir_all(paths.metadata.parent().unwrap()).unwrap();
        let controller = controller_with_scripted_msb(directory.path(), &paths, GROUP);
        recovery::begin(
            &controller,
            recovery::Journal::restore(completed_archive(), "copy".into(), Some("dev".into())),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let original = runtime::read_metadata(&paths.metadata).unwrap();
        // Settings cannot be written where a directory occupies the file.
        fs::create_dir(&paths.metadata).unwrap();
        assert!(commit_import(
            &paths,
            &controller,
            original,
            imported_machine(&id),
            &id,
            GROUP,
            MEMBER
        )
        .is_err());
        assert!(!paths
            .metadata
            .with_file_name("checkpoints")
            .join(format!("{id}.json"))
            .exists());
        let saved = fs::read_to_string(directory.path().join("backup-operation.json")).unwrap();
        assert!(!saved.contains(&id), "{saved}");
        // The loaded snapshot group went with it (E-23).
        let removed = scripted_calls(directory.path())
            .into_iter()
            .filter(|call| call.starts_with("snapshot remove"))
            .count();
        assert_eq!(removed, 2);
    }

    fn outcome_and_detail(operation: &Operation) -> (&'static str, String) {
        match operation {
            Operation::Result {
                outcome, detail, ..
            } => (*outcome, detail.clone().unwrap_or_default()),
            Operation::Running { .. } => panic!("expected a result"),
        }
    }

    #[test]
    fn transfer_outcomes_come_from_the_error_kind_not_its_text() {
        let _test_state = crate::test_support::global_state();
        let cancelled = failed_transfer(
            "backup",
            completed_archive(),
            None,
            backup::BackupError::Cancelled.into(),
        );
        assert_eq!(
            outcome_and_detail(&cancelled),
            ("cancelled", "No export file was saved.".into())
        );
        // A failure whose text happens to read like a cancellation is still a failure.
        let failed = failed_transfer(
            "backup",
            completed_archive(),
            None,
            TransferError::from("The operation was cancelled.".to_string()),
        );
        assert_eq!(outcome_and_detail(&failed).0, "failed");
        let gate = TransferError::from(runtime::operation_gate::GateError::Cancelled);
        assert!(gate.cancelled);

        let import = failed_transfer(
            "restore",
            completed_archive(),
            Some("copy".into()),
            "Disk full".to_string().into(),
        );
        let (outcome, detail) = outcome_and_detail(&import);
        assert_eq!(outcome, "failed");
        assert_eq!(
            detail,
            "No sandbox was added. The export file was not changed."
        );
        let unpacked = failed_transfer(
            "restore",
            completed_archive(),
            Some("copy".into()),
            TransferError::from("Disk full".to_string()).after_unpacking(),
        );
        assert!(outcome_and_detail(&unpacked)
            .1
            .contains("may still use disk space"));
        for operation in [cancelled, failed, import, unpacked] {
            let detail = outcome_and_detail(&operation).1;
            assert!(
                !detail.contains("removed") && !detail.contains("replaced"),
                "{detail}"
            );
        }
    }

    fn running_import(controller: &Controller) -> backup::Cancellation {
        let cancellation = backup::Cancellation::default();
        let mut view = controller.view.lock().unwrap();
        view.cancellation = Some(cancellation.clone());
        view.operation = Some(Operation::Running {
            operation: "restore",
            archive: completed_archive(),
            running_names: Vec::new(),
            target_name: Some("copy".into()),
            progress: 0,
            indeterminate: Some(true),
            can_cancel: None,
            phases: Vec::new(),
        });
        cancellation
    }

    #[test]
    fn an_import_past_its_commit_point_reports_and_enforces_that_it_cannot_be_cancelled() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let cancellation = running_import(&controller);
        enter_commit(&controller, &cancellation).unwrap();
        let serialized = serde_json::to_value(&controller.view.lock().unwrap().operation).unwrap();
        assert_eq!(serialized["canCancel"], false);
        assert!(cancel_operation(&controller).is_err());
        assert!(!cancellation.cancelled());

        // A cancel that arrived before the commit point wins.
        let cancellation = running_import(&controller);
        cancel_operation(&controller).unwrap();
        assert!(
            enter_commit(&controller, &cancellation)
                .unwrap_err()
                .cancelled
        );
    }

    #[test]
    fn an_export_check_is_cancelled_only_by_its_own_request_or_a_newer_one() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let first = register_inspection(&controller, "first".into());
        assert!(!cancel_inspection(&controller, "other"));
        assert!(!first.cancelled());
        assert!(cancel_inspection(&controller, "first"));
        assert!(first.cancelled());

        let second = register_inspection(&controller, "second".into());
        let third = register_inspection(&controller, "third".into());
        assert!(second.cancelled(), "a newer check replaces the older one");
        finish_inspection(&controller, "second");
        assert!(!third.cancelled());
        finish_inspection(&controller, "third");
        assert!(!cancel_inspection(&controller, "third"));
        assert!(!third.cancelled());
    }

    #[test]
    fn a_queued_export_shows_that_it_waits_and_then_its_own_work() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = Arc::new(history_controller(
            directory.path().join("backup-history.json"),
        ));
        let claimed = claim_export(
            &controller,
            directory.path(),
            directory.path().to_string_lossy().into_owned(),
            &["dev".into()],
            Some("checkpoint-1".into()),
            Some("Before upgrade"),
        )
        .unwrap();
        let titles = |controller: &Controller| match &controller.view.lock().unwrap().operation {
            Some(Operation::Running { phases, .. }) => phases
                .iter()
                .map(|phase| (phase.title.clone(), phase.tone))
                .collect::<Vec<_>>(),
            _ => panic!("expected a running export"),
        };
        let work = vec![(
            "Using checkpoint \u{201c}Before upgrade\u{201d}".to_string(),
            "running",
        )];
        assert_eq!(titles(&controller), work);

        let other = runtime::OPERATIONS.computer("Other sandbox work").unwrap();
        let (queued, admitted) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
        let (worker_controller, cancellation) = (controller.clone(), claimed.cancellation.clone());
        let (queued_sender, admitted_sender) = (queued.0, admitted.0);
        let worker = std::thread::spawn(move || {
            let guard = mutation_guard(
                &cancellation,
                runtime::operation_gate::OperationKind::Export,
                "Exporting sandbox",
                true,
                &|| {
                    show_queued(&worker_controller);
                    queued_sender.send(()).unwrap();
                },
            )
            .unwrap();
            show_admitted(&worker_controller);
            admitted_sender.send(()).unwrap();
            drop(guard);
        });
        queued.1.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            titles(&controller),
            vec![
                ("Waiting for other sandbox work".to_string(), "running"),
                (work[0].0.clone(), "waiting"),
            ]
        );
        drop(other);
        admitted.1.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        assert_eq!(
            titles(&controller),
            vec![
                ("Waiting for other sandbox work".to_string(), "succeeded"),
                (work[0].0.clone(), "running"),
            ]
        );
        // The checkpoint's name travels with the export, so titles survive a reload.
        let archive = serde_json::to_value(&claimed.archive).unwrap();
        assert_eq!(archive["checkpointName"], "Before upgrade");
        let journal = fs::read_to_string(directory.path().join("backup-operation.json")).unwrap();
        assert!(journal.contains("Before upgrade"), "{journal}");
    }

    #[test]
    fn an_export_admitted_at_once_keeps_only_its_work_phase() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let claimed = claim_export(
            &controller,
            directory.path(),
            directory.path().to_string_lossy().into_owned(),
            &["dev".into()],
            None,
            None,
        )
        .unwrap();
        let guard = mutation_guard(
            &claimed.cancellation,
            runtime::operation_gate::OperationKind::Export,
            "Exporting sandbox",
            true,
            &|| panic!("not queued"),
        )
        .unwrap();
        show_admitted(&controller);
        drop(guard);
        assert!(matches!(
            &controller.view.lock().unwrap().operation,
            Some(Operation::Running { phases, .. }) if phases.len() == 1 && phases[0].tone == "running"
        ));
        assert!(serde_json::to_value(&claimed.archive)
            .unwrap()
            .get("checkpointName")
            .is_none());
    }

    #[test]
    fn migration_waits_for_a_pending_export_to_settle_before_conversion() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = Arc::new(history_controller(
            directory.path().join("backup-history.json"),
        ));
        recovery::begin(
            &controller,
            recovery::Journal::backup(completed_archive(), vec!["dev".into()], None),
        )
        .unwrap();
        controller.busy.store(true, Ordering::Release);
        let (entered, observed) = std::sync::mpsc::channel();
        let release = Arc::new(std::sync::Barrier::new(2));
        let waiter_controller = controller.clone();
        let waiter_release = release.clone();
        let waiter = std::thread::spawn(move || {
            let announced = AtomicBool::new(false);
            wait_for_controller_recovery(&waiter_controller, true, &|| {
                if !announced.swap(true, Ordering::Relaxed) {
                    entered.send(()).unwrap();
                    waiter_release.wait();
                }
                false
            })
        });
        observed
            .recv_timeout(Duration::from_secs(5))
            .expect("migration reached the pending recovery");
        assert!(recovery::pending(&controller).unwrap());
        recovery::complete(
            &controller,
            Operation::Result {
                operation: "backup",
                archive: completed_archive(),
                running_names: vec![],
                target_name: None,
                outcome: "failed",
                title: "Export interrupted".into(),
                message: "No export file was saved.".into(),
                detail: None,
            },
        );
        controller.busy.store(false, Ordering::Release);
        release.wait();
        waiter.join().unwrap().unwrap();
        assert!(!recovery::pending(&controller).unwrap());
    }

    #[test]
    fn migration_refuses_failed_recovery_but_startup_can_continue() {
        let _test_state = crate::test_support::global_state();
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        recovery::begin(
            &controller,
            recovery::Journal::restore(completed_archive(), "copy".into(), None),
        )
        .unwrap();
        assert!(wait_for_controller_recovery(&controller, true, &|| false)
            .unwrap_err()
            .contains("Dismiss its result"));
        wait_for_controller_recovery(&controller, false, &|| false).unwrap();
        assert!(recovery::pending(&controller).unwrap());
    }

    #[test]
    fn multi_vm_restore_requires_an_explicit_source() {
        let _test_state = crate::test_support::global_state();
        let names = vec!["first".into(), "second".into()];
        assert!(select_archive_source(&names, None).is_err());
        assert_eq!(
            select_archive_source(&names, Some("second")).unwrap(),
            "second"
        );
        assert!(select_archive_source(&names, Some("outside")).is_err());
        assert_eq!(select_archive_source(&names[..1], None).unwrap(), "first");
    }

    /// Runs real production operations only in a disposable home; excluded from app builds.
    #[test]
    #[ignore = "requires the packaged runtime and hardware virtualization"]
    fn real_backup_restore_preserves_root_and_workspace_without_original_cache() {
        crate::test_support::live::require_confirmation();
        let _test_state = crate::test_support::global_state();
        // The live runtime control socket requires a short root (104 bytes on macOS).
        let directory = tempfile::Builder::new()
            .prefix("silo-proof-")
            .tempdir_in("/tmp")
            .unwrap();
        let paths = runtime::RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: PathBuf::from(std::env::var("SILO_TEST_MSB").expect("packaged msb path")),
            library: PathBuf::from(
                std::env::var("SILO_TEST_LIBKRUNFW").expect("packaged library path"),
            ),
            home: directory.path().join("runtime"),
            storage_home: None,
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        };
        struct GuestCleanup<'a>(&'a runtime::RuntimePaths);
        impl Drop for GuestCleanup<'_> {
            fn drop(&mut self) {
                for name in [
                    "silo-proof-backup",
                    "silo-proof-second",
                    "silo-proof-existing",
                    "silo-proof-restored",
                ] {
                    let _ = runtime::run_msb(
                        self.0,
                        &["stop".into(), name.into()],
                        Duration::from_secs(30),
                    );
                }
            }
        }
        let _cleanup = GuestCleanup(&paths);
        let name = "silo-proof-backup";
        let restored_name = "silo-proof-restored";
        let second_name = "silo-proof-second";
        let run = |arguments: &[&str]| {
            runtime::run_msb(
                &paths,
                &arguments.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                Duration::from_secs(180),
            )
            .unwrap()
        };
        let machine = runtime::create_disposable_test_machine(&paths, name).unwrap();
        assert_eq!(inspect(&paths, name).unwrap().status, "Stopped");
        run(&["start", name]);
        run(&[
            "exec",
            name,
            "--",
            "sh",
            "-c",
            "printf root-proof > /root/silo-backup-proof; printf workspace-proof > /workspace/silo-backup-proof; sync",
        ]);
        eprintln!(
            "Guest capacity: {}",
            run(&["exec", name, "--", "df", "-B1", "/", "/workspace"]).stdout
        );
        run(&["stop", name]);
        runtime::apply_disposable_test_identity(&paths, name).unwrap();
        let inspected = inspect(&paths, name).unwrap();
        let second_machine = runtime::create_disposable_test_machine(&paths, second_name).unwrap();
        assert_eq!(inspect(&paths, second_name).unwrap().status, "Stopped");
        run(&["start", second_name]);
        run(&[
            "exec",
            second_name,
            "--",
            "sh",
            "-c",
            "printf second-root > /root/silo-backup-proof; printf second-workspace > /workspace/silo-backup-proof; sync",
        ]);
        run(&["stop", second_name]);
        let second_inspected = inspect(&paths, second_name).unwrap();
        let make_controller = |paths: &runtime::RuntimePaths| Controller {
            history_path: paths.metadata.with_file_name("backup-history.json"),
            journal: Mutex::new(None),
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: paths.executable.clone(),
                    home: paths.home.clone(),
                    storage_home: paths.storage_home.clone(),
                    library: paths.library.clone(),
                },
                directory.path().join("scratch"),
            ),
            view: Mutex::new(ViewState {
                journal_error: None,
                destination: None,
                operation: None,
                cancellation: None,
                inspection: None,
            }),
            busy: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        };
        let controller = make_controller(&paths);
        let archive = directory.path().join("proof.silo-backup");
        run(&["start", name]);
        controller
            .service
            .create_backup(
                backup::BackupRequest {
                    destination: archive.clone(),
                    sources: vec![
                        backup::BackupSource {
                            name: name.into(),
                            snapshot_group: name.into(),
                            was_running: true,
                            runtime_config: inspected.config.clone(),
                            machine_config: serde_json::to_value(&machine).unwrap(),
                            existing_member: None,
                        },
                        backup::BackupSource {
                            name: second_name.into(),
                            snapshot_group: second_name.into(),
                            was_running: false,
                            runtime_config: second_inspected.config.clone(),
                            machine_config: serde_json::to_value(&second_machine).unwrap(),
                            existing_member: None,
                        },
                    ],
                },
                &backup::Cancellation::default(),
            )
            .unwrap();
        assert_eq!(inspect(&paths, name).unwrap().status, "Running");
        let checked = controller
            .service
            .inspect_archive(&archive, &backup::Cancellation::default())
            .unwrap();
        recovery::begin(
            &controller,
            recovery::Journal::backup(
                archive_from(&archive, &checked),
                vec![name.into(), second_name.into()],
                None,
            ),
        )
        .unwrap();
        // Archive publication succeeded, but app death preceded the result.
        // Relaunch verifies the published file and never restarts sandboxes.
        run(&["stop", name]);
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        let recovered = recovery::recover_at_paths(
            &paths,
            &controller,
            &checkpoint,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert!(matches!(
            recovered,
            Operation::Result {
                outcome: "success",
                ..
            }
        ));
        assert_eq!(inspect(&paths, name).unwrap().status, "Stopped");
        assert_eq!(inspect(&paths, second_name).unwrap().status, "Stopped");
        let _ = (inspected, second_inspected, machine, second_machine);
        run(&["remove", "--force", "--quiet", name]);
        run(&["remove", "--force", "--quiet", second_name]);
        fs::remove_dir_all(&paths.home).unwrap();
        fs::remove_dir_all(&paths.volumes).unwrap();
        fs::remove_file(&paths.metadata).unwrap();
        let paths = runtime::RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: paths.executable.clone(),
            library: paths.library.clone(),
            home: directory.path().join("cold-target"),
            storage_home: None,
            volumes: directory.path().join("cold-volumes"),
            metadata: directory.path().join("cold-machines.json"),
        };
        let _cold_cleanup = GuestCleanup(&paths);
        let controller = make_controller(&paths);
        let run = |arguments: &[&str]| {
            runtime::run_msb(
                &paths,
                &arguments
                    .iter()
                    .map(|value| (*value).into())
                    .collect::<Vec<_>>(),
                Duration::from_secs(90),
            )
            .unwrap()
        };
        fs::create_dir_all(&paths.home).unwrap();
        fs::create_dir_all(&paths.volumes).unwrap();
        // A deleted sandbox from an older build can leave this empty folder.
        fs::create_dir(paths.volumes.join(restored_name)).unwrap();
        let checked = controller
            .service
            .inspect_archive(&archive, &backup::Cancellation::default())
            .unwrap();
        recovery::begin(
            &controller,
            recovery::Journal::restore(
                archive_from(&archive, &checked),
                restored_name.into(),
                Some(name.into()),
            ),
        )
        .unwrap();
        // Emulate process death after the import journaled its new sandbox but
        // before its settings were saved: relaunch forgets it and adds nothing.
        let interrupted_id = uuid::Uuid::new_v4().to_string();
        recovery::save_restore_identity(
            &controller,
            &interrupted_id,
            "silo-import-0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        let recovered = recovery::recover_at_paths(
            &paths,
            &controller,
            &checkpoint,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert!(matches!(
            recovered,
            Operation::Result {
                outcome: "failed",
                ..
            }
        ));
        recovery::complete(
            &controller,
            Operation::Result {
                operation: "restore",
                archive: archive_from(&archive, &checked),
                running_names: vec![],
                target_name: Some(restored_name.into()),
                outcome: "cancelled",
                title: "Cancelled".into(),
                message: "Cancelled".into(),
                detail: None,
            },
        );
        recovery::begin(
            &controller,
            recovery::Journal::restore(
                archive_from(&archive, &checked),
                restored_name.into(),
                Some(name.into()),
            ),
        )
        .unwrap();
        let restore_phases = Mutex::new(Vec::new());
        restore_at_paths(
            &paths,
            &controller,
            &archive,
            name,
            restored_name,
            &backup::Cancellation::default(),
            &|phase| restore_phases.lock().unwrap().push(phase.to_string()),
        )
        .unwrap();
        assert_eq!(
            *restore_phases.lock().unwrap(),
            [
                "Preparing import",
                "Unpacking export",
                "Saving stopped sandbox",
            ]
        );
        assert!(runtime::is_pending_restore(&paths, restored_name));
        let native: Vec<Value> =
            serde_json::from_str(&run(&["list", "--format", "json"]).stdout).unwrap();
        assert!(native
            .iter()
            .all(|sandbox| sandbox["name"] != restored_name));
        // Settings were saved, but process death preceded the success result.
        // Relaunch adopts the import under its journaled identity without booting it.
        let restored_id = runtime::read_metadata(&paths.metadata)
            .unwrap()
            .machines
            .into_iter()
            .find(|machine| machine.name() == restored_name)
            .unwrap()
            .id()
            .to_owned();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        let recovered = recovery::recover_at_paths(
            &paths,
            &controller,
            &checkpoint,
            &backup::Cancellation::default(),
        )
        .unwrap();
        assert!(matches!(
            recovered,
            Operation::Result {
                outcome: "success",
                ..
            }
        ));
        assert!(runtime::read_metadata(&paths.metadata)
            .unwrap()
            .machines
            .iter()
            .any(|machine| machine.id() == restored_id));

        runtime::start_disposable_test_import(&paths, restored_name).unwrap();
        assert!(!runtime::is_pending_restore(&paths, restored_name));
        let restored = inspect(&paths, restored_name).unwrap();
        assert_eq!(restored.status, "Running");
        assert_eq!(
            restored.config.get("pull_policy").and_then(Value::as_str),
            Some("Never")
        );
        assert_eq!(
            restored.config["network"]["policy"],
            serde_json::json!({
                "default_egress":"deny", "default_ingress":"deny", "rules":[]
            })
        );
        assert_eq!(restored.config["labels"]["silo.github-protocol"], "1");
        assert_eq!(restored.config["labels"]["silo.working-account"], "1");
        let restored_user = crate::working_account::working_user(&restored.config).unwrap();
        assert_eq!(
            run(&[
                "exec",
                restored_name,
                "--user",
                restored_user,
                "--",
                "git",
                "config",
                "--global",
                "--get",
                "user.email"
            ])
            .stdout
            .trim(),
            "silo-test@example.invalid"
        );
        assert_eq!(
            run(&[
                "exec",
                restored_name,
                "--user",
                restored_user,
                "--",
                "stat",
                "-c",
                "%u:%g",
                "/home/silo/.gitconfig"
            ])
            .stdout
            .trim(),
            "1001:1001"
        );
        let proof = run(&[
            "exec",
            restored_name,
            "--",
            "sh",
            "-c",
            "cat /root/silo-backup-proof; printf ':'; cat /workspace/silo-backup-proof",
        ]);
        let stopped = runtime::run_msb(
            &paths,
            &["stop".into(), restored_name.into()],
            Duration::from_secs(60),
        );
        assert!(stopped.is_ok(), "restored VM cleanup failed: {stopped:?}");
        assert!(
            proof.stdout.contains("root-proof:workspace-proof"),
            "{}",
            proof.stdout
        );
        run(&["remove", "--force", "--quiet", restored_name]);
        // A separately provisioned copy of the same image must not block restore or
        // be overwritten: generated VMDK bytes are not the image's identity.
        fs::remove_dir_all(&paths.home).unwrap();
        fs::remove_dir_all(&paths.volumes).unwrap();
        fs::remove_file(&paths.metadata).unwrap();
        let paths = runtime::RuntimePaths {
            guest_image: std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("runtime/guest-image"),
            executable: paths.executable.clone(),
            library: paths.library.clone(),
            home: directory.path().join("warm-target"),
            storage_home: None,
            volumes: directory.path().join("warm-volumes"),
            metadata: directory.path().join("warm-machines.json"),
        };
        let _warm_cleanup = GuestCleanup(&paths);
        let controller = make_controller(&paths);
        let run = |arguments: &[&str]| {
            runtime::run_msb(
                &paths,
                &arguments
                    .iter()
                    .map(|value| (*value).into())
                    .collect::<Vec<_>>(),
                Duration::from_secs(90),
            )
            .unwrap()
        };
        let existing_name = "silo-proof-existing";
        runtime::create_disposable_test_machine(&paths, existing_name).unwrap();
        let cache_hashes = || {
            use sha2::{Digest, Sha256};
            fs::read_dir(paths.home.join("cache/vmdk"))
                .unwrap()
                .map(|entry| {
                    let path = entry.unwrap().path();
                    let mut file = fs::File::open(&path).unwrap();
                    let mut hash = Sha256::new();
                    std::io::copy(&mut file, &mut hash).unwrap();
                    (path, format!("{:x}", hash.finalize()))
                })
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        let original_cache = cache_hashes();
        assert!(!original_cache.is_empty());
        restore_at_paths(
            &paths,
            &controller,
            &archive,
            second_name,
            restored_name,
            &backup::Cancellation::default(),
            &|_| {},
        )
        .unwrap();
        assert_eq!(original_cache, cache_hashes());
        assert!(runtime::is_pending_restore(&paths, restored_name));
        runtime::start_disposable_test_import(&paths, restored_name).unwrap();
        assert_eq!(inspect(&paths, restored_name).unwrap().status, "Running");
        let second_proof = run(&[
            "exec",
            restored_name,
            "--",
            "sh",
            "-c",
            "cat /root/silo-backup-proof; printf ':'; cat /workspace/silo-backup-proof",
        ]);
        assert!(second_proof.stdout.contains("second-root:second-workspace"));
        run(&["stop", restored_name]);
        run(&["remove", "--force", "--quiet", restored_name]);
        run(&["start", existing_name]);
        run(&[
            "exec",
            existing_name,
            "--",
            "sh",
            "-c",
            "test -d /workspace && test -d /root",
        ]);
        run(&["stop", existing_name]);
        run(&["remove", "--force", "--quiet", existing_name]);
        let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/ui-evidence");
        fs::create_dir_all(&evidence).unwrap();
        fs::copy(
            &archive,
            evidence.join("verified-root-workspace.silo-backup"),
        )
        .unwrap();
        eprintln!(
            "Verified stopped restore without original VM/cache; both root and workspace files survived."
        );
    }

    /// Exports a real full checkpoint, imports it as a new sandbox, cold-boots the
    /// imported disk, and asserts the checkpoint-time marker survived. Uses only a
    /// disposable /tmp home; never touches the user's Silo data or running VMs.
    #[test]
    #[ignore = "requires the packaged runtime and hardware virtualization"]
    fn real_checkpoint_export_imports_and_cold_boots_checkpoint_time_disk() {
        crate::test_support::live::require_confirmation();
        let _test_state = crate::test_support::global_state();
        // The live runtime control socket requires a short root (104 bytes on macOS).
        let directory = tempfile::Builder::new()
            .prefix("silo-ckpt-proof-")
            .tempdir_in("/tmp")
            .unwrap();
        let guest_image =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/guest-image");
        let executable = PathBuf::from(std::env::var("SILO_TEST_MSB").expect("packaged msb path"));
        let library =
            PathBuf::from(std::env::var("SILO_TEST_LIBKRUNFW").expect("packaged library path"));
        let paths = runtime::RuntimePaths {
            guest_image: guest_image.clone(),
            executable: executable.clone(),
            library: library.clone(),
            home: directory.path().join("runtime"),
            storage_home: None,
            metadata: directory.path().join("machines.json"),
            volumes: directory.path().join("volumes"),
        };
        let cold = runtime::RuntimePaths {
            guest_image,
            executable,
            library,
            home: directory.path().join("cold"),
            storage_home: None,
            metadata: directory.path().join("cold-machines.json"),
            volumes: directory.path().join("cold-volumes"),
        };
        let source_name = "silo-ckpt-source";
        let restored_name = "silo-ckpt-restored";
        struct GuestCleanup<'a>(&'a runtime::RuntimePaths, &'static [&'static str]);
        impl Drop for GuestCleanup<'_> {
            fn drop(&mut self) {
                for name in self.1 {
                    let _ = runtime::run_msb(
                        self.0,
                        &["stop".into(), (*name).into()],
                        Duration::from_secs(30),
                    );
                }
            }
        }
        let _cleanup = GuestCleanup(&paths, &["silo-ckpt-source"]);
        let _cold_cleanup = GuestCleanup(&cold, &["silo-ckpt-restored"]);
        let run = |paths: &runtime::RuntimePaths, arguments: &[&str]| {
            runtime::run_msb(
                paths,
                &arguments.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                Duration::from_secs(180),
            )
            .unwrap()
        };

        let machine = runtime::create_disposable_test_machine(&paths, source_name).unwrap();
        run(&paths, &["start", source_name]);
        run(
            &paths,
            &[
                "exec",
                source_name,
                "--",
                "sh",
                "-c",
                "printf checkpoint-workspace > /workspace/silo-ckpt-proof; printf checkpoint-root > /root/silo-ckpt-proof; sync",
            ],
        );
        // Capture a FULL checkpoint of the running guest via the production path.
        let checkpoint_id =
            runtime::checkpoints::capture_for_test(&paths, machine.id(), "Milestone").unwrap();
        // Overwrite the marker after the checkpoint. This later content must NOT
        // appear in the exported checkpoint.
        run(
            &paths,
            &[
                "exec",
                source_name,
                "--",
                "sh",
                "-c",
                "printf post-workspace > /workspace/silo-ckpt-proof; printf post-root > /root/silo-ckpt-proof; sync",
            ],
        );
        run(&paths, &["stop", source_name]);
        // Prepare the runtime configuration exactly as `backup_work` does.
        let mut inspected = inspect(&paths, source_name).unwrap();
        canonicalize_backup_runtime(&mut inspected.config).unwrap();
        backup_volumes(&machine, &mut inspected).unwrap();

        let (group, member, scope, _display) =
            runtime::checkpoints::export_source(&paths, machine.id(), &checkpoint_id).unwrap();
        assert_eq!(scope, "full");

        let make_controller = |paths: &runtime::RuntimePaths| Controller {
            history_path: paths.metadata.with_file_name("backup-history.json"),
            journal: Mutex::new(None),
            service: backup::BackupService::new(
                backup::MsbCommand {
                    executable: paths.executable.clone(),
                    home: paths.home.clone(),
                    storage_home: paths.storage_home.clone(),
                    library: paths.library.clone(),
                },
                directory.path().join("scratch"),
            ),
            view: Mutex::new(ViewState {
                journal_error: None,
                destination: None,
                operation: None,
                cancellation: None,
                inspection: None,
            }),
            busy: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        };
        let controller = make_controller(&paths);
        let archive = directory.path().join("checkpoint.silo-backup");
        controller
            .service
            .create_backup(
                backup::BackupRequest {
                    destination: archive.clone(),
                    sources: vec![backup::BackupSource {
                        name: source_name.into(),
                        snapshot_group: group,
                        was_running: false,
                        runtime_config: inspected.config.clone(),
                        machine_config: serde_json::to_value(&machine).unwrap(),
                        existing_member: Some(member),
                    }],
                },
                &backup::Cancellation::default(),
            )
            .unwrap();

        // Import into a fresh cold home. This installs a stopped, pending-restore
        // workspace and never touches the source home.
        fs::create_dir_all(&cold.home).unwrap();
        fs::create_dir_all(&cold.volumes).unwrap();
        let cold_controller = make_controller(&cold);
        restore_at_paths(
            &cold,
            &cold_controller,
            &archive,
            source_name,
            restored_name,
            &backup::Cancellation::default(),
            &|_| {},
        )
        .unwrap();

        assert!(runtime::is_pending_restore(&cold, restored_name));
        // Use the app's explicit Start path; it consumes the pending import only
        // after the runtime verifies the new sandbox's identity and policy.
        runtime::start_disposable_test_import(&cold, restored_name).unwrap();
        assert!(!runtime::is_pending_restore(&cold, restored_name));
        let proof = run(
            &cold,
            &[
                "exec",
                restored_name,
                "--",
                "sh",
                "-c",
                "cat /root/silo-ckpt-proof; printf ':'; cat /workspace/silo-ckpt-proof",
            ],
        );
        let _ = runtime::run_msb(
            &cold,
            &["stop".into(), restored_name.into()],
            Duration::from_secs(60),
        );
        assert!(
            proof
                .stdout
                .contains("checkpoint-root:checkpoint-workspace"),
            "expected checkpoint-time content, got: {}",
            proof.stdout
        );
        eprintln!("Verified checkpoint export/import preserves checkpoint-time disk content.");
    }
}

pub(crate) fn update_ready(app: &AppHandle) -> Result<(), String> {
    let controller = app.state::<Arc<Controller>>();
    if controller.busy.load(Ordering::Acquire) || recovery::unresolved(&controller)? {
        Err("Wait for the export or import to finish before updating.".into())
    } else {
        Ok(())
    }
}

pub(crate) struct UpdateGuard(Arc<Controller>);
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}
pub(crate) fn update_guard(app: &AppHandle) -> Result<UpdateGuard, String> {
    update_guard_for(app.state::<Arc<Controller>>().inner().clone())
}
fn update_guard_for(controller: Arc<Controller>) -> Result<UpdateGuard, String> {
    controller
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Wait for the export or import to finish before updating.")?;
    let guard = UpdateGuard(controller);
    // The guard now owns `busy`, so check the saved journal directly;
    // `recovery::unresolved` treats a busy controller as resolved.
    if recovery::pending(&guard.0)? {
        return Err("An interrupted export or import must finish before updating.".into());
    }
    Ok(guard)
}
