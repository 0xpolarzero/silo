mod recovery;

use crate::{backup, runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
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
    #[serde(rename = "requiredSpaceGB", skip_serializing_if = "Option::is_none")]
    required_space_gb: Option<f64>,
    #[serde(rename = "availableSpaceGB", skip_serializing_if = "Option::is_none")]
    available_space_gb: Option<f64>,
    archives: Vec<Archive>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<String>,
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupHistory {
    schema_version: u32,
    destination: Option<PathBuf>,
    archives: Vec<Archive>,
}

fn load_history(path: &Path) -> Result<BackupHistory, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BackupHistory {
                schema_version: 1,
                destination: None,
                archives: Vec::new(),
            });
        }
        Err(error) => return Err(format!("Silo could not read backup history: {error}")),
    };
    let history: BackupHistory = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Silo could not read backup history: {error}"))?;
    if history.schema_version != 1
        || history
            .destination
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        || history.archives.iter().any(|archive| {
            !Path::new(&archive.archive_path).is_absolute()
                || !Path::new(&archive.destination).is_absolute()
                || archive.name.is_empty()
                || archive.sandboxes.is_empty()
        })
    {
        return Err(
            "Silo backup history has invalid or unsupported data. The saved file was preserved."
                .into(),
        );
    }
    Ok(history)
}

fn write_history(path: &Path, history: &BackupHistory) -> Result<(), String> {
    let write = || -> Result<(), Box<dyn std::error::Error>> {
        let parent = path.parent().ok_or("Missing backup history directory")?;
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, history)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    };
    write().map_err(|error| format!("Silo could not save backup history: {error}"))
}

fn record_archive(controller: &Controller, archive: &Archive) -> Result<(), String> {
    let mut view = controller
        .view
        .lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?;
    if let Some(error) = &view.history_error {
        return Err(error.clone());
    }
    let mut archives = view.archives.clone();
    archives.retain(|existing| existing.archive_path != archive.archive_path);
    archives.insert(0, archive.clone());
    write_history(
        &controller.history_path,
        &BackupHistory {
            schema_version: 1,
            destination: view.destination.clone(),
            archives: archives.clone(),
        },
    )?;
    view.archives = archives;
    Ok(())
}

struct ViewState {
    history_error: Option<String>,
    destination: Option<PathBuf>,
    archives: Vec<Archive>,
    operation: Option<Operation>,
    cancellation: Option<backup::Cancellation>,
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
        .map_err(|error| format!("Silo could not locate private backup working storage: {error}"))?
        .join("backup-work");
    let history_path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("backup-history.json");
    let (history, mut history_error) = match load_history(&history_path) {
        Ok(history) => (history, None),
        Err(error) => (
            BackupHistory {
                schema_version: 1,
                destination: None,
                archives: Vec::new(),
            },
            Some(error),
        ),
    };
    let journal = match recovery::load(&history_path) {
        Ok(journal) => journal,
        Err(error) => {
            history_error = Some(error);
            None
        }
    };
    let controller = Arc::new(Controller {
        journal: Mutex::new(journal.clone()),
        history_path,
        service: backup::BackupService::new(
            backup::MsbCommand {
                metadata: paths.metadata,
                executable: paths.executable,
                home: paths.home,
                storage_home: paths.storage_home,
                library: paths.library,
            },
            scratch,
        ),
        view: Mutex::new(ViewState {
            history_error,
            destination: history.destination,
            archives: history.archives,
            operation: None,
            cancellation: None,
        }),
        busy: AtomicBool::new(false),
        revision: AtomicU64::new(1),
    });
    app.manage(controller.clone());
    if let Some(journal) = journal {
        if !crate::runtime_migration::blocks_operations(app) {
            recovery::resume(app.clone(), controller, journal)?;
        }
    }
    Ok(())
}

/// Startup runs this in its background worker before other recovery or optional
/// starts. An interrupted backup may own a stopped guest or a half-created VM.
pub(crate) fn wait_for_recovery(app: &AppHandle) -> Result<(), String> {
    let controller = app.state::<Arc<Controller>>();
    let pending = controller
        .journal
        .lock()
        .map_err(|_| "Saved backup progress is unavailable.")?
        .as_ref()
        .filter(|journal| journal.is_pending())
        .map(|journal| journal.identity().to_string());
    let Some(identity) = pending else {
        return Ok(());
    };
    let started = std::time::Instant::now();
    loop {
        if crate::startup::is_cancelled(app) {
            return Ok(());
        }
        let pending = controller
            .journal
            .lock()
            .map_err(|_| "Saved backup progress is unavailable.")?
            .as_ref()
            .is_some_and(|journal| journal.identity() == identity && journal.is_pending());
        if !pending {
            return Ok(());
        }
        if !controller.busy.load(Ordering::Acquire) {
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

fn display_size(bytes: u64) -> String {
    if bytes >= GIB {
        format!("{:.1} GB", bytes as f64 / GIB as f64)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
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
        completed_label: "Intact archive".into(),
        size: display_size(inspected.size_bytes),
        destination: path
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .into_owned(),
        sandboxes: inspected.sandboxes.clone(),
    }
}

fn free_bytes(path: &Path) -> Result<u64, String> {
    let path = fs::canonicalize(path)
        .map_err(|error| format!("Silo could not inspect the selected destination: {error}"))?;
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let encoded = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "The selected export destination is invalid.".to_string())?;
    let mut statistics: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: encoded is NUL terminated and statistics is a valid exclusive output pointer.
    if unsafe { libc::statvfs(encoded.as_ptr(), &mut statistics) } != 0 {
        return Err(format!(
            "Silo could not measure the selected destination: {}",
            std::io::Error::last_os_error()
        ));
    }
    (statistics.f_bavail as u64)
        .checked_mul(statistics.f_frsize as u64)
        .ok_or_else(|| "The selected destination reported an invalid capacity.".into())
}

#[tauri::command]
pub(crate) fn read_backup_state(
    app: AppHandle,
    controller: State<'_, Arc<Controller>>,
) -> Result<BackupState, String> {
    let paths = runtime::runtime_paths(&app)?;
    let view = controller
        .view
        .lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?;
    let available =
        free_bytes(&paths.home)
            .ok()
            .and_then(|managed| match view.destination.as_deref() {
                Some(destination) => free_bytes(destination)
                    .ok()
                    .map(|available| available.min(managed)),
                None => Some(managed),
            });
    let availability_message = view.history_error.clone().or_else(|| {
        recovery::unresolved(&controller).unwrap_or(true).then(|| "The interrupted export or import could not finish. Relaunch Silo to retry. Saved progress was preserved.".into())
    });
    Ok(BackupState {
        snapshot_id: controller.revision.load(Ordering::Relaxed).to_string(),
        operation_id: recovery::token(&controller)?,
        availability: if availability_message.is_some() {
            "unavailable"
        } else {
            "available"
        },
        availability_message,
        required_space_gb: None,
        available_space_gb: available.map(|bytes| bytes as f64 / GIB as f64),
        archives: view.archives.clone(),
        destination: view
            .destination
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        operation: view.operation.clone(),
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
        .map_err(|_| "Backup state is unavailable.".to_string())?
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
        let mut view = controller
            .view
            .lock()
            .map_err(|_| "Backup state is unavailable.".to_string())?;
        if let Some(error) = &view.history_error {
            return Err(error.clone());
        }
        write_history(
            &controller.history_path,
            &BackupHistory {
                schema_version: 1,
                destination: Some(path.clone()),
                archives: view.archives.clone(),
            },
        )?;
        view.destination = Some(path.clone());
        drop(view);
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

#[tauri::command]
pub(crate) async fn inspect_backup_archive(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    archive_path: String,
) -> Result<ArchiveInspectionResult, String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(archive_path);
        let cancellation = backup::Cancellation::default();
        match controller.service.inspect_archive(&path, &cancellation) {
            Ok(inspection) => {
                publish(&app, &controller);
                Ok(ArchiveInspectionResult {
                    archive: archive_from(&path, &inspection),
                    valid: true,
                    reason: None,
                })
            }
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
                },
                valid: false,
                reason: Some(error.to_string()),
            }),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Authorizes a reveal request against the controller's known archives. A path
/// may be revealed only when it matches, byte for byte, the `archive_path` of a
/// saved history entry or of the current completed export (a `Result` operation
/// whose outcome finished successfully), and the file still exists. Exact-string
/// matching rejects traversal (`..`) or otherwise non-identical paths, and the
/// existence check rejects an archive the user has since moved or deleted.
fn authorize_reveal(
    operation: Option<&Operation>,
    archives: &[Archive],
    requested: &str,
) -> Result<PathBuf, String> {
    const UNAVAILABLE: &str = "That export file is no longer available.";
    let known = archives
        .iter()
        .any(|archive| archive.archive_path == requested)
        || matches!(
            operation,
            Some(Operation::Result { outcome, archive, .. })
                if matches!(*outcome, "success" | "restart-required")
                    && archive.archive_path == requested
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
    let controller = controller.inner().clone();
    let path = {
        let view = controller
            .view
            .lock()
            .map_err(|_| "Backup state is unavailable.".to_string())?;
        authorize_reveal(view.operation.as_ref(), &view.archives, &archive_path)?
    };
    // Revealing shells out to the platform file manager, which can block.
    tauri::async_runtime::spawn_blocking(move || {
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
        .map_err(|_| "Backup state is unavailable.".to_string())?
        .operation = Some(operation);
    Ok(())
}

fn finish(controller: &Controller) {
    if let Ok(mut view) = controller.view.lock() {
        view.cancellation = None;
    }
    controller.busy.store(false, Ordering::Release);
}

#[tauri::command]
pub(crate) async fn start_backup(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    destination: String,
    sandboxes: Vec<String>,
    checkpoint_id: Option<String>,
) -> Result<(), String> {
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
) -> Result<(), String> {
    require_main(&window)?;
    let controller = controller.inner().clone();
    let selected_destination = controller
        .view
        .lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?
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
            .ok_or_else(|| format!("Sandbox '{sandbox}' is not a Silo-managed VM."))?;
        let (_group, _member, _scope, name) =
            runtime::checkpoints::export_source(&paths, machine.id(), checkpoint_id)
                .map_err(|error| error.to_string())?;
        Some(name)
    } else {
        None
    };
    controller
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another export or import is running.".to_string())?;
    let archive_path = unique_archive(&canonical, &sandboxes, checkpoint_id.is_some());
    let pending_archive = Archive {
        name: archive_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        archive_path: archive_path.to_string_lossy().into_owned(),
        completed_label: "In progress".into(),
        size: "Unknown".into(),
        destination,
        sandboxes: sandboxes.clone(),
    };
    if let Err(error) = recovery::begin(
        &controller,
        recovery::Journal::backup(
            pending_archive.clone(),
            sandboxes.clone(),
            checkpoint_id.clone(),
        ),
    ) {
        finish(&controller);
        return Err(error);
    }
    let cancellation = backup::Cancellation::default();
    {
        let mut view = controller
            .view
            .lock()
            // `busy` and the journal are already claimed; returning here would
            // strand them, so recover a poisoned view instead (E-44).
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        view.cancellation = Some(cancellation.clone());
        let phase = match &checkpoint_name {
            Some(name) => Phase {
                title: format!("Using checkpoint \u{201c}{name}\u{201d}"),
                detail: "Silo is packaging and verifying the selected checkpoint.".into(),
                tone: "running",
            },
            None => Phase {
                title: "Capture and verify".into(),
                detail: "Silo is creating verified self-contained snapshots.".into(),
                tone: "running",
            },
        };
        view.operation = Some(Operation::Running {
            operation: "backup",
            archive: pending_archive.clone(),
            running_names: Vec::new(),
            target_name: None,
            progress: 0,
            indeterminate: Some(true),
            phases: vec![phase],
        });
    }
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
    Ok(())
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
    let mut operation = match result {
        Ok((archive, restart_failures)) if restart_failures.is_empty() => Operation::Result {
            operation: "backup",
            archive,
            running_names: Vec::new(),
            target_name: None,
            outcome: "success",
            title: "Export complete".into(),
            message: "Sandbox exported.".into(),
            detail: None,
        },
        Ok((archive, restart_failures)) => {
            let names = restart_failures
                .iter()
                .map(|failure| failure.sandbox.clone())
                .collect::<Vec<_>>();
            Operation::Result { operation: "backup", archive, running_names: names, target_name: None, outcome: "restart-required", title: "Export complete; restart failed".into(), message: "The export is complete and verified, but a previously running sandbox did not restart.".into(), detail: Some(restart_failures.into_iter().map(|failure| format!("{}: {}", failure.sandbox, failure.detail)).collect::<Vec<_>>().join("\n")) }
        }
        Err(error) => Operation::Result {
            operation: "backup",
            archive: pending_archive,
            running_names: Vec::new(),
            target_name: None,
            outcome: if error == "The operation was cancelled." {
                "cancelled"
            } else {
                "failed"
            },
            title: if error == "The operation was cancelled." {
                "Export cancelled".into()
            } else {
                "Export failed".into()
            },
            message: error,
            detail: Some(
                "No completed export was recorded; incomplete files were removed.".into(),
            ),
        },
    };
    if let Operation::Result {
        archive,
        outcome,
        title,
        message,
        detail,
        ..
    } = &mut operation
    {
        if matches!(*outcome, "success" | "restart-required") {
            if let Err(error) = record_archive(&controller, archive) {
                *outcome = "failed";
                *title = "Export saved; history update failed".into();
                *message = format!(
                    "The verified export remains at {}. {error}",
                    archive.archive_path
                );
                *detail = Some(
                    format!(
                        "{} Silo could not save its export records.",
                        detail.take().unwrap_or_default()
                    )
                    .trim()
                    .into(),
                );
            }
        }
    }
    let operation = recovery::complete(&controller, operation);
    notify_transfer(&app, &operation, started.elapsed());
    let _ = set_operation(&controller, operation);
    finish(&controller);
    publish(&app, &controller);
}

fn mutation_guard(
    cancellation: &backup::Cancellation,
    kind: runtime::operation_gate::OperationKind,
    label: &str,
    cancellable: bool,
) -> Result<runtime::operation_gate::OperationGuard<'static>, String> {
    // Export and import change shared state and wait their turn (computer scope).
    // A queued export stays cancellable and gives up if the work ahead never ends.
    if cancellation.cancelled() {
        return Err("The operation was cancelled.".into());
    }
    let started = std::time::Instant::now();
    let mut guard = runtime::OPERATIONS
        .kind(kind)
        .acquire_while(runtime::operation_gate::Scope::Computer, None, label, &|| {
            !cancellation.cancelled() && started.elapsed() < RESTORE_TIMEOUT
        })
        .map_err(|error| match error {
            runtime::operation_gate::GateError::Abandoned if cancellation.cancelled() => {
                "The operation was cancelled.".to_string()
            }
            runtime::operation_gate::GateError::Abandoned => {
                "The previous sandbox operation did not finish. Relaunch Silo to retry.".to_string()
            }
            error => error.to_string(),
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
) -> Result<(Archive, Vec<backup::RestartFailure>), String> {
    let _guard = mutation_guard(cancellation, runtime::operation_gate::OperationKind::Export, "Exporting sandbox", true)?;
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
            .ok_or_else(|| format!("Sandbox '{name}' is not a Silo-managed VM."))?;
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
    recovery::save_sources(controller, &sources)?;
    let result = controller.service.create_backup_with_token(
        backup::BackupRequest {
            destination: archive_path.to_path_buf(),
            sources,
        },
        cancellation,
        recovery::token(controller)?.as_deref(),
    );
    // Reconcile failed stop or restart attempts once cleanup has settled too.
    crate::ssh_access::reconcile(&paths);
    let result = result.map_err(|error| error.to_string())?;
    let inspection = backup::ArchiveInspection {
        created_at_ms: result.created_at_ms,
        size_bytes: result.size_bytes,
        sandboxes: result.sandboxes,
    };
    Ok((
        archive_from(&result.destination, &inspection),
        result.restart_failures,
    ))
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
        return Err("Only local VMs have exportable disk storage.".into());
    };
    if !normalize_backup_root_capacity(&mut inspected.config, u64::from(*runtime_storage_gib) * 1024) {
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
    let Some(root) = config.pointer_mut("/image/Oci/root_disk").and_then(Value::as_object_mut) else {
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
    let object = config.as_object_mut().ok_or("The runtime returned invalid sandbox settings.")?;
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
            return Err("The sandbox has invalid snapshot ancestry.".into());
        }
    }
    if let Some(interface) = object.get_mut("network").and_then(|network| network.get_mut("interface")).and_then(Value::as_object_mut) {
        if !interface.is_empty() {
            let ipv6 = interface.get("ipv6_address");
            let valid = interface.len() == if ipv6.is_some() { 4 } else { 3 }
                && interface.get("ipv4_address").and_then(Value::as_str)
                    .is_some_and(|address| address.parse::<std::net::Ipv4Addr>().is_ok())
                && ipv6.is_none_or(|address| address.as_str()
                    .is_some_and(|address| address.parse::<std::net::Ipv6Addr>().is_ok()))
                && interface.get("mac").and_then(Value::as_array)
                    .is_some_and(|mac| mac.len() == 6 && mac.iter().all(|part| part.as_u64().is_some_and(|value| value <= 255)))
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

// Recovery uses this only after verifying the per-restore owner marker. Keep
// the runtime ownership check here so crash cleanup cannot remove a VM that
// has since been replaced under the same name.
fn cleanup_restored(paths: &runtime::RuntimePaths, name: &str, expected_id: &str) -> Result<(), String> {
    let runtime_exists = match inspect(paths, name) {
        Ok(sandbox)
            if sandbox
                .config
                .pointer("/labels/silo.machine-id")
                .and_then(Value::as_str)
                != Some(expected_id) =>
        {
            return Err(format!(
                "A different VM now owns {name}; Silo preserved it and its storage."
            ));
        }
        Ok(_) => true,
        Err(error)
            if error.to_ascii_lowercase().contains("not found")
                || error.to_ascii_lowercase().contains("does not exist") =>
        {
            false
        }
        Err(error) => {
            return Err(format!(
                "Silo could not verify restored VM ownership for cleanup: {error}"
            ));
        }
    };
    if runtime_exists {
        match runtime::run_msb(
            paths,
            &[
                "remove".into(),
                "--force".into(),
                "--quiet".into(),
                name.into(),
            ],
            Duration::from_secs(45),
        ) {
            Ok(_) => {}
            Err(error)
                if error.to_string().to_ascii_lowercase().contains("not found")
                    || error
                        .to_string()
                        .to_ascii_lowercase()
                        .contains("does not exist") => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let disk_path = paths.volumes.join(name);
    match fs::remove_dir_all(&disk_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Silo could not remove incomplete restored disks: {error}"
        )),
    }
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
    start_restore_inner(
        app,
        window,
        controller,
        archive_path,
        new_name,
        source_name,
    )
    .await
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
    runtime::validate_name(&new_name).map_err(|error| error.to_string())?;
    controller
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another export or import is running.".to_string())?;
    let controller = controller.inner().clone();
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
        let inspection = controller
            .service
            .inspect_archive(&path, &cancellation)
            .map_err(|error| error.to_string())?;
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
        Ok::<_, String>(selected)
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
        Err(error) => Operation::Result {
            operation: "restore",
            archive,
            running_names: Vec::new(),
            target_name: Some(new_name),
            outcome: if error == "The operation was cancelled." {
                "cancelled"
            } else {
                "failed"
            },
            title: if error == "The operation was cancelled." {
                "Import cancelled".into()
            } else {
                "Import failed".into()
            },
            message: error,
            detail: Some("No existing sandbox was replaced.".into()),
        },
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
        Some(_) => Err("The selected VM is not in this export.".into()),
        None if names.len() == 1 => Ok(names[0].clone()),
        None => Err("Choose which VM to import from this export.".into()),
    }
}

fn restore_work(
    app: &AppHandle,
    controller: &Controller,
    archive: &Path,
    source_name: &str,
    new_name: &str,
    cancellation: &backup::Cancellation,
) -> Result<(), String> {
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
) -> Result<(), String> {
    progress("Preparing import");
    let _guard = mutation_guard(cancellation, runtime::operation_gate::OperationKind::Import, "Importing sandbox", false)?;
    let original = runtime::read_metadata(&paths.metadata).map_err(|error| error.to_string())?;
    if original
        .machines
        .iter()
        .any(|machine| machine.name().eq_ignore_ascii_case(new_name))
    {
        return Err(format!("A sandbox named {new_name} already exists."));
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
        return Err(format!(
            "A runtime sandbox named {new_name} already exists."
        ));
    }
    progress("Unpacking export");
    let prepared = controller
        .service
        .prepare_restore(
            backup::RestoreRequest {
                archive: archive.to_path_buf(),
                source_name: Some(source_name.into()),
                new_name: new_name.into(),
            },
            cancellation,
        )
        .map_err(|error| error.to_string())?;
    // Until the new sandbox is saved, a failure removes the loaded import
    // group instead of stranding it in the native store (E-23).
    let import_group = controller
        .service
        .discard_import_on_failure(&prepared.snapshot_group);
    if prepared.source_name != source_name || prepared.new_name != new_name {
        return Err("The verified backup restore identity changed unexpectedly.".into());
    }
    if prepared.runtime_config.get("name").and_then(Value::as_str) != Some(source_name) {
        return Err("The verified backup runtime configuration has the wrong source name.".into());
    }
    let mut machine_value = prepared.machine_config.clone();
    let object = machine_value
        .as_object_mut()
        .ok_or("The backup has invalid Silo VM settings.")?;
    let id = uuid::Uuid::new_v4().to_string();
    object.insert("id".into(), Value::String(id.clone()));
    object.insert("name".into(), Value::String(new_name.into()));
    let machine: runtime::MachineConfiguration = serde_json::from_value(machine_value)
        .map_err(|_| "The backup has invalid Silo VM settings.".to_string())?;
    if !matches!(machine, runtime::MachineConfiguration::Vm { .. }) {
        return Err("The archive does not contain a local VM configuration.".into());
    }
    progress("Saving stopped workspace");
    runtime::checkpoints::import_pending_restore(
        paths,
        &id,
        &prepared.snapshot_group,
        &prepared.snapshot_member,
    )
    .map_err(|error| error.to_string())?;
    let mut updated = original;
    updated.machines.push(machine);
    if let Err(error) = runtime::write_metadata(&paths.metadata, &updated) {
        let _ = runtime::checkpoints::forget_removed(paths, &id);
        return Err(error.to_string());
    }
    import_group.keep();
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_backup_operation(
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
) -> Result<(), String> {
    require_main(&window)?;
    cancel_operation(&controller)
}

fn cancel_operation(controller: &Controller) -> Result<(), String> {
    let cancellation = controller
        .view
        .lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?
        .cancellation
        .clone()
        .ok_or("No export or import is running.")?;
    // Cancel in process first: a journal write failure (full disk, permissions)
    // must not leave the running operation uncancellable. The persisted flag
    // only matters for a later relaunch.
    cancellation.cancel();
    let _ = recovery::cancel(controller);
    Ok(())
}

#[tauri::command]
pub(crate) fn dismiss_backup_operation(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    expected_operation: Value,
    expected_operation_id: Option<String>,
) -> Result<bool, String> {
    require_main(&window)?;
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
}

fn dismiss_finished_operation(
    controller: &Controller,
    expected: Option<&Value>,
    expected_id: Option<&str>,
) -> Result<bool, String> {
    let mut view = controller
        .view
        .lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?;
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

#[tauri::command]
pub(crate) async fn retry_workspace_start(
    app: AppHandle,
    controller: State<'_, Arc<Controller>>,
    name: String,
) -> Result<runtime::ApplicationSource, String> {
    let source = runtime::workspace_action(app.clone(), "start".into(), name.clone(), None).await?;
    let paths = runtime::runtime_paths(&app)?;
    if inspect(&paths, &name)?.status != "Running" {
        return Err(format!(
            "{name} has not reached Running. The restart failure remains unresolved."
        ));
    }
    {
        let mut view = controller
            .view
            .lock()
            .map_err(|_| "Backup state is unavailable.".to_string())?;
        if let Some(Operation::Result {
            operation,
            running_names,
            outcome,
            title,
            message,
            detail,
            ..
        }) = view.operation.as_mut()
        {
            if *operation == "backup" && *outcome == "restart-required" {
                running_names.retain(|candidate| candidate != &name);
                if running_names.is_empty() {
                    *outcome = "success";
                    *title = "Export complete".into();
                    *message = "The export is complete and all previously running sandboxes are running again.".into();
                    *detail = None;
                } else {
                    *message = format!(
                        "The export is complete. {} still require a manual restart.",
                        running_names.join(", ")
                    );
                }
            }
        }
    }
    publish(&app, &controller);
    Ok(source)
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
                    metadata: PathBuf::from("/unused/machines.json"),
                    executable: PathBuf::from("/unused/msb"),
                    home: PathBuf::from("/unused/home"),
                    storage_home: None,
                    library: PathBuf::from("/unused/library"),
                },
                PathBuf::from("/unused/scratch"),
            ),
            view: Mutex::new(ViewState {
                history_error: None,
                destination: Some(PathBuf::from("/backups")),
                archives: Vec::new(),
                operation: None,
                cancellation: None,
            }),
            busy: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        }
    }

    pub(super) fn completed_archive() -> Archive {
        Archive {
            name: "saved.silo-backup".into(),
            archive_path: "/backups/saved.silo-backup".into(),
            completed_label: "Verified archive".into(),
            size: "1 GB".into(),
            destination: "/backups".into(),
            sandboxes: vec!["dev".into()],
        }
    }

    #[test]
    fn update_guard_refuses_while_an_interrupted_operation_is_pending() {
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
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("saved.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();

        for outcome in ["success", "restart-required"] {
            let operation = completed_operation(archive.clone(), outcome);
            let resolved = authorize_reveal(Some(&operation), &[], &path).unwrap();
            assert_eq!(resolved, file);
        }
    }

    #[test]
    fn reveal_allows_a_saved_history_entry_when_the_file_exists() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("history.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();

        let resolved = authorize_reveal(None, std::slice::from_ref(&archive), &path).unwrap();
        assert_eq!(resolved, file);
    }

    #[test]
    fn reveal_rejects_a_path_not_present_in_history_or_the_current_operation() {
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

        let error = authorize_reveal(
            None,
            std::slice::from_ref(&archive),
            &stranger.to_string_lossy(),
        )
        .unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn reveal_rejects_a_traversal_or_non_identical_path() {
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

        let error = authorize_reveal(None, std::slice::from_ref(&archive), &traversal).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn reveal_rejects_a_known_archive_whose_file_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("gone.silo-backup");
        let path = missing.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();
        let operation = completed_operation(archive.clone(), "success");

        let error =
            authorize_reveal(Some(&operation), std::slice::from_ref(&archive), &path).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn reveal_rejects_a_failed_operation_even_when_the_file_exists() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("saved.silo-backup");
        std::fs::write(&file, b"archive").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut archive = completed_archive();
        archive.archive_path = path.clone();
        let operation = completed_operation(archive, "failed");

        let error = authorize_reveal(Some(&operation), &[], &path).unwrap_err();
        assert_eq!(error, "That export file is no longer available.");
    }

    #[test]
    fn legacy_managed_root_default_is_materialized_only_when_saved_capacity_matches() {
        let legacy = serde_json::json!({"image":{"Oci":{"root_disk":{"kind":"managed"}}}});
        let mut matching = legacy.clone();
        assert!(normalize_backup_root_capacity(&mut matching, 4096));
        assert_eq!(matching.pointer("/image/Oci/root_disk/size_mib"), Some(&Value::from(4096)));

        let mut wrong_saved_capacity = legacy;
        assert!(!normalize_backup_root_capacity(&mut wrong_saved_capacity, 8192));
        assert!(wrong_saved_capacity.pointer("/image/Oci/root_disk/size_mib").is_none());

        let mut explicit_mismatch = serde_json::json!({"image":{"Oci":{"root_disk":{"kind":"managed","size_mib":8192}}}});
        assert!(!normalize_backup_root_capacity(&mut explicit_mismatch, 4096));
        assert_eq!(explicit_mismatch.pointer("/image/Oci/root_disk/size_mib"), Some(&Value::from(8192)));
    }

    #[test]
    fn migrated_native_config_exports_only_the_current_empty_github_policy() {
        let network: Value = serde_json::from_str(include_str!("../guest/github-network-default.json")).unwrap();
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
    fn completed_backup_history_and_destination_survive_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        let controller = history_controller(path.clone());
        let archive = completed_archive();
        record_archive(&controller, &archive).unwrap();
        let restored = load_history(&path).unwrap();
        assert_eq!(restored.archives, vec![archive]);
        assert_eq!(restored.destination, Some(PathBuf::from("/backups")));
        let bytes = fs::read_to_string(path).unwrap();
        assert!(!bytes.contains("operation"));
        assert!(!bytes.contains("running"));
    }

    #[test]
    fn failed_history_write_does_not_publish_a_saved_history_entry() {
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("not-a-directory");
        fs::write(&blocked, b"preserve").unwrap();
        let controller = history_controller(blocked.join("backup-history.json"));
        assert!(record_archive(&controller, &completed_archive()).is_err());
        assert!(controller.view.lock().unwrap().archives.is_empty());
        assert_eq!(fs::read(&blocked).unwrap(), b"preserve");
    }

    #[test]
    fn malformed_backup_history_is_preserved_and_reported() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup-history.json");
        fs::write(&path, b"broken history").unwrap();
        assert!(load_history(&path).is_err());
        assert_eq!(fs::read(path).unwrap(), b"broken history");
    }

    #[test]
    fn backup_operation_serialization_matches_frontend_contract() {
        let archive = completed_archive();
        let operations = [
            Operation::Running {
                operation: "restore",
                archive: archive.clone(),
                running_names: Vec::new(),
                target_name: Some("restored".into()),
                progress: 5,
                indeterminate: None,
                phases: vec![Phase {
                    title: "Restore".into(),
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
                title: "Restore failed".into(),
                message: "Runtime refused creation".into(),
                detail: Some("No new sandbox was retained".into()),
            },
        ];
        let expected: Value = serde_json::from_str(include_str!(
            "../../src/test/contracts/backup-operations.json"
        ))
        .unwrap();
        assert_eq!(serde_json::to_value(operations).unwrap(), expected);
    }

    #[test]
    fn stale_result_dismissal_preserves_the_next_running_operation() {
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
        let guard = runtime::OPERATIONS.computer("Contended work").unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = mutation_guard(&backup::Cancellation::default(), runtime::operation_gate::OperationKind::Export, "Exporting sandbox", true).map(|_| ());
            sender.send(result).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(20)).is_err());
        let cancellation = backup::Cancellation::default();
        cancellation.cancel();
        assert_eq!(
            mutation_guard(&cancellation, runtime::operation_gate::OperationKind::Export, "Exporting sandbox", true).unwrap_err(),
            "The operation was cancelled."
        );
        drop(guard);
        assert!(
            receiver
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .is_ok()
        );
        worker.join().unwrap();
    }

    #[test]
    fn delayed_dismissal_cannot_clear_a_new_completed_operation() {
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
        let state = BackupState {
            snapshot_id: "contract".into(),
            operation_id: None,
            availability: "available",
            availability_message: None,
            required_space_gb: Some(2.5),
            available_space_gb: Some(20.0),
            archives: Vec::new(),
            destination: Some("/backups".into()),
            operation: None,
        };
        let expected: Value =
            serde_json::from_str(include_str!("../../src/test/contracts/backup-state.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(state).unwrap(), expected);
    }

    #[test]
    fn archive_names_never_replace_an_existing_backup() {
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
    fn multi_vm_restore_requires_an_explicit_source() {
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
                    metadata: paths.metadata.clone(),
                    executable: paths.executable.clone(),
                    home: paths.home.clone(),
                    storage_home: paths.storage_home.clone(),
                    library: paths.library.clone(),
                },
                directory.path().join("scratch"),
            ),
            view: Mutex::new(ViewState {
                history_error: None,
                destination: None,
                archives: Vec::new(),
                operation: None,
                cancellation: None,
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
        recovery::save_sources(
            &controller,
            &[
                backup::BackupSource {
                    name: name.into(),
                    snapshot_group: name.into(),
                    was_running: true,
                    runtime_config: inspected.config,
                    machine_config: serde_json::to_value(&machine).unwrap(),
                            existing_member: None,
                },
                backup::BackupSource {
                    name: second_name.into(),
                    snapshot_group: second_name.into(),
                    was_running: false,
                    runtime_config: second_inspected.config,
                    machine_config: serde_json::to_value(&second_machine).unwrap(),
                            existing_member: None,
                },
            ],
        )
        .unwrap();
        // Archive publication succeeded, but app death can precede completion
        // reporting and restoration of the guest's previous running state.
        run(&["stop", name]);
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(
            recovery::recover_at_paths(
                &paths,
                &controller,
                &checkpoint,
                &backup::Cancellation::default()
            )
            .unwrap()
        );
        assert_eq!(inspect(&paths, name).unwrap().status, "Running");
        assert_eq!(inspect(&paths, second_name).unwrap().status, "Stopped");
        assert_ne!(
            load_history(&controller.history_path).unwrap().archives[0].size,
            "Unknown"
        );
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
        // Emulate process death after the owned disk directory was claimed but
        // before msb create. Only this operation's partial disk can be removed.
        let interrupted_id = uuid::Uuid::new_v4().to_string();
        recovery::save_restore_identity(&controller, &interrupted_id).unwrap();
        recovery::claim_disk(&paths.volumes.join(restored_name), &interrupted_id).unwrap();
        fs::write(
            runtime::disk_path(&paths, restored_name, "workspace"),
            b"incomplete disk",
        )
        .unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(
            !recovery::recover_at_paths(
                &paths,
                &controller,
                &checkpoint,
                &backup::Cancellation::default()
            )
            .unwrap()
        );
        assert!(!paths.volumes.join(restored_name).exists());
        // A durable cancellation cleans owned partial output and does not create
        // the requested guest when the app reopens.
        recovery::save_restore_identity(&controller, &interrupted_id).unwrap();
        recovery::claim_disk(&paths.volumes.join(restored_name), &interrupted_id).unwrap();
        fs::write(
            runtime::disk_path(&paths, restored_name, "workspace"),
            b"cancelled disk",
        )
        .unwrap();
        recovery::cancel(&controller).unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(
            recovery::recover_at_paths(
                &paths,
                &controller,
                &checkpoint,
                &backup::Cancellation::default()
            )
            .unwrap()
        );
        assert!(!paths.volumes.join(restored_name).exists());
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
                "Restoring workspace disk",
                "Creating restored sandbox",
                "Verifying restored sandbox",
            ]
        );
        let restored = inspect(&paths, restored_name).unwrap();
        assert_eq!(restored.status, "Created");
        // Metadata was committed, but process death could precede marker removal
        // and delivery of the success event. Relaunch verifies and adopts it.
        let restored_id = restored.config["labels"]["silo.machine-id"]
            .as_str()
            .unwrap();
        fs::write(
            paths
                .volumes
                .join(restored_name)
                .join(".silo-restore-owner"),
            restored_id,
        )
        .unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(
            recovery::recover_at_paths(
                &paths,
                &controller,
                &checkpoint,
                &backup::Cancellation::default()
            )
            .unwrap()
        );
        assert!(
            !paths
                .volumes
                .join(restored_name)
                .join(".silo-restore-owner")
                .exists()
        );
        recovery::save_restore_identity(&controller, &uuid::Uuid::new_v4().to_string()).unwrap();
        let foreign = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(
            recovery::recover_at_paths(
                &paths,
                &controller,
                &foreign,
                &backup::Cancellation::default()
            )
            .unwrap_err()
            .contains("different sandbox")
        );
        assert_eq!(inspect(&paths, restored_name).unwrap().status, "Created");
        assert!(runtime::disk_path(&paths, restored_name, "workspace").exists());
        recovery::save_restore_identity(&controller, restored_id).unwrap();

        assert_eq!(
            restored.config.get("pull_policy").and_then(Value::as_str),
            Some("Never")
        );
        assert!(backup::default_github_network(&restored.config["network"]));
        assert_eq!(restored.config["labels"]["silo.github-protocol"], "1");
        assert_eq!(restored.config["labels"]["silo.working-account"], "1");
        let restored_user = crate::working_account::working_user(&restored.config).unwrap();
        run(&["start", restored_name]);
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
        assert_eq!(inspect(&paths, restored_name).unwrap().status, "Created");
        run(&["start", restored_name]);
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
        let directory = tempfile::Builder::new()
            .prefix("silo-ckpt-proof-")
            .tempdir_in("/tmp")
            .unwrap();
        let guest_image =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime/guest-image");
        let executable = PathBuf::from(std::env::var("SILO_TEST_MSB").expect("packaged msb path"));
        let library = PathBuf::from(
            std::env::var("SILO_TEST_LIBKRUNFW").expect("packaged library path"),
        );
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
                    metadata: paths.metadata.clone(),
                    executable: paths.executable.clone(),
                    home: paths.home.clone(),
                    storage_home: paths.storage_home.clone(),
                    library: paths.library.clone(),
                },
                directory.path().join("scratch"),
            ),
            view: Mutex::new(ViewState {
                history_error: None,
                destination: None,
                archives: Vec::new(),
                operation: None,
                cancellation: None,
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

        // Read the imported pending-restore selectors, then cold-boot the disk only.
        let restored_id = runtime::read_metadata(&cold.metadata)
            .unwrap()
            .machines
            .into_iter()
            .find(|m| m.name() == restored_name)
            .unwrap()
            .id()
            .to_owned();
        let record: Value = serde_json::from_slice(
            &fs::read(
                cold.metadata
                    .with_file_name("checkpoints")
                    .join(format!("{restored_id}.json")),
            )
            .unwrap(),
        )
        .unwrap();
        let import_group = record["pendingCheckpointRestore"]["sourceWorkspace"]
            .as_str()
            .unwrap()
            .to_owned();
        let import_member = record["pendingCheckpointRestore"]["checkpointId"]
            .as_str()
            .unwrap()
            .to_owned();
        // A full checkpoint imported as disk-state cold-boots with --disk-only.
        run(
            &cold,
            &[
                "restore",
                &format!("{import_group}:{import_member}"),
                "--name",
                restored_name,
                "--disk-only",
                "--cpus",
                "1",
                "--memory",
                "1G",
            ],
        );
        // Consume the pending restore as a successful explicit Start does, so the
        // guarded exec below treats the imported workspace as active.
        let record_path = cold
            .metadata
            .with_file_name("checkpoints")
            .join(format!("{restored_id}.json"));
        let mut active: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
        active["pendingCheckpointRestore"] = Value::Null;
        fs::write(&record_path, serde_json::to_vec(&active).unwrap()).unwrap();
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
            proof.stdout.contains("checkpoint-root:checkpoint-workspace"),
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
