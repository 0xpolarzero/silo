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
    time::{Duration, SystemTime, UNIX_EPOCH},
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
            })
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
    let journal = match recovery::load(&history_path) { Ok(journal) => journal, Err(error) => { history_error = Some(error); None } };
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
    if let Some(journal) = journal { recovery::resume(app.clone(), controller, journal)?; }
    Ok(())
}

/// Startup runs this in its background worker before other recovery or optional
/// starts. An interrupted backup may own a stopped guest or a half-created VM.
pub(crate) fn wait_for_recovery(app: &AppHandle) -> Result<(), String> {
    let controller = app.state::<Arc<Controller>>();
    let pending = controller.journal.lock().map_err(|_| "Saved backup progress is unavailable.")?.as_ref().filter(|journal| journal.is_pending()).map(|journal| journal.identity().to_string());
    let Some(identity) = pending else { return Ok(()); };
    let started = std::time::Instant::now();
    loop {
        if crate::startup::is_cancelled(app) { return Ok(()); }
        let pending = controller.journal.lock().map_err(|_| "Saved backup progress is unavailable.")?.as_ref().is_some_and(|journal| journal.identity() == identity && journal.is_pending());
        if !pending { return Ok(()); }
        if !controller.busy.load(Ordering::Acquire) {
            return Err("The interrupted backup or restore could not finish. Open Backup to see the error. Saved progress was preserved.".into());
        }
        if started.elapsed() >= RESTORE_TIMEOUT { return Err("Backup recovery is still running. Automatic sandbox startup was deferred.".into()); }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    (window.label() == "main")
        .then_some(())
        .ok_or_else(|| "Only the main Silo window can manage backups.".into())
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
            .unwrap_or("Silo backup")
            .to_string(),
        archive_path: path.to_string_lossy().into_owned(),
        completed_label: "Verified archive".into(),
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
        .map_err(|_| "The selected backup destination is invalid.".to_string())?;
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
        recovery::unresolved(&controller).unwrap_or(true).then(|| "The interrupted backup or restore could not finish. Relaunch Silo to retry. Saved progress was preserved.".into())
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
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("Choose a backup destination")
            .set_parent(&window)
            .blocking_pick_folder()
        else {
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
            .set_title("Choose a Silo backup")
            .set_parent(&window)
            .add_filter("Silo backup", &["silo-backup"])
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
                        .unwrap_or("Backup")
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

fn unique_archive(destination: &Path) -> PathBuf {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let base = destination.join(format!("Silo-Backup-{seconds}.silo-backup"));
    if !base.exists() {
        return base;
    }
    (1_u32..)
        .map(|suffix| destination.join(format!("Silo-Backup-{seconds}-{suffix}.silo-backup")))
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
) -> Result<(), String> {
    require_main(&window)?;
    let result = start_backup_inner(app.clone(), window, controller, destination, sandboxes).await;
    if result.is_err() {
        crate::notifications::backup_result(&app, "backup", "failed");
    }
    result
}

async fn start_backup_inner(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    destination: String,
    sandboxes: Vec<String>,
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
        .map_err(|error| format!("Silo could not use the backup destination: {error}"))?;
    if selected_destination.as_deref() != Some(canonical.as_path()) {
        return Err("Choose the backup destination again before starting.".into());
    }
    controller
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Another backup or restore operation is running.".to_string())?;
    let archive_path = unique_archive(&canonical);
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
    if let Err(error) = recovery::begin(&controller, recovery::Journal::backup(pending_archive.clone(), sandboxes.clone())) {
        finish(&controller); return Err(error);
    }
    let cancellation = backup::Cancellation::default();
    {
        let mut view = controller
            .view
            .lock()
            .map_err(|_| "Backup state is unavailable.".to_string())?;
        view.cancellation = Some(cancellation.clone());
        view.operation = Some(Operation::Running {
            operation: "backup",
            archive: pending_archive.clone(),
            running_names: Vec::new(),
            target_name: None,
            progress: 0,
            indeterminate: Some(true),
            phases: vec![Phase {
                title: "Capture and verify".into(),
                detail: "Silo is creating verified self-contained snapshots.".into(),
                tone: "running",
            }],
        });
    }
    publish(&app, &controller);
    let app_for_work = app.clone();
    let controller_for_work = controller.clone();
    tauri::async_runtime::spawn_blocking(move || run_backup(app_for_work, controller_for_work, archive_path, sandboxes, cancellation, pending_archive));
    Ok(())
}

fn run_backup(app: AppHandle, controller: Arc<Controller>, archive_path: PathBuf, sandboxes: Vec<String>, cancellation: backup::Cancellation, pending_archive: Archive) {
        let result = backup_work(
            &app,
            &controller,
            &archive_path,
            &sandboxes,
            &cancellation,
        );
        let mut operation = match result {
            Ok((archive, restart_failures)) if restart_failures.is_empty() => Operation::Result {
                operation: "backup",
                archive,
                running_names: Vec::new(),
                target_name: None,
                outcome: "success",
                title: "Backup complete".into(),
                message: "Backup completed successfully."
                    .into(),
                detail: None,
            },
            Ok((archive, restart_failures)) => {
                let names = restart_failures
                    .iter()
                    .map(|failure| failure.sandbox.clone())
                    .collect::<Vec<_>>();
                Operation::Result { operation: "backup", archive, running_names: names, target_name: None, outcome: "restart-required", title: "Backup complete; restart failed".into(), message: "The archive is complete and verified, but a previously running sandbox did not restart.".into(), detail: Some(restart_failures.into_iter().map(|failure| format!("{}: {}", failure.sandbox, failure.detail)).collect::<Vec<_>>().join("\n")) }
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
                    "Backup cancelled".into()
                } else {
                    "Backup failed".into()
                },
                message: error,
                detail: Some(
                    "No completed archive was recorded; incomplete files were removed.".into(),
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
                    *title = "Backup saved; history update failed".into();
                    *message = format!(
                        "The verified archive remains at {}. {error}",
                        archive.archive_path
                    );
                    *detail = Some(
                        format!(
                            "{} The archive was not added to recent backups.",
                            detail.take().unwrap_or_default()
                        )
                        .trim()
                        .into(),
                    );
                }
            }
        }
        let operation = recovery::complete(&controller, operation);
        if let Operation::Result {
            operation: kind,
            outcome,
            ..
        } = &operation
        {
            crate::notifications::backup_result(&app, kind, outcome);
        }
        let _ = set_operation(&controller, operation);
        finish(&controller);
        publish(&app, &controller);

}

fn mutation_guard(cancellation: &backup::Cancellation) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    let started = std::time::Instant::now();
    loop {
        if cancellation.cancelled() { return Err("The operation was cancelled.".into()); }
        match runtime::MUTATION_LOCK.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err("Sandbox operations are unavailable. Relaunch Silo to retry.".into()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if started.elapsed() >= RESTORE_TIMEOUT { return Err("The previous sandbox operation did not finish. Relaunch Silo to retry.".into()); }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn backup_work(
    app: &AppHandle,
    controller: &Controller,
    archive_path: &Path,
    names: &[String],
    cancellation: &backup::Cancellation,
) -> Result<(Archive, Vec<backup::RestartFailure>), String> {
    let _guard = mutation_guard(cancellation)?;
    let paths = runtime::runtime_paths(app)?;
    let metadata = runtime::read_metadata(&paths.metadata).map_err(|error| error.to_string())?;
    if names.is_empty() {
        return Err("Choose at least one sandbox to back up.".into());
    }
    let mut sources = Vec::new();
    for name in names {
        runtime::validate_name(name).map_err(|error| error.to_string())?;
        let machine = metadata
            .machines
            .iter()
            .find(|machine| machine.is_vm() && machine.name() == name)
            .ok_or_else(|| format!("Sandbox '{name}' is not a Silo-managed VM."))?;
        let inspected = inspect(&paths, name)?;
        runtime::ensure_managed(&inspected).map_err(|error| error.to_string())?;
        let volumes = backup_volumes(&paths, machine, &inspected)?;
        sources.push(backup::BackupSource {
            name: name.clone(),
            was_running: inspected.status == "Running",
            runtime_config: inspected.config,
            machine_config: serde_json::to_value(machine).map_err(|error| error.to_string())?,
            volumes,
        });
    }
    recovery::save_sources(controller, &sources)?;
    let result = controller
        .service
        .create_backup_with_token(
            backup::BackupRequest {
                destination: archive_path.to_path_buf(),
                sources,
            },
            cancellation,
            recovery::token(controller)?.as_deref(),
        )
        .map_err(|error| error.to_string())?;
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
    paths: &runtime::RuntimePaths,
    machine: &runtime::MachineConfiguration,
    inspected: &runtime::InspectedSandbox,
) -> Result<Vec<backup::BackupVolumeSource>, String> {
    let runtime::MachineConfiguration::Vm {
        name,
        workspace_storage_gib,
        runtime_storage_gib,
        ..
    } = machine
    else {
        return Err("Only local VMs have backup disk storage.".into());
    };
    if inspected
        .config
        .pointer("/image/Oci/root_disk/size_mib")
        .and_then(Value::as_u64)
        != Some(u64::from(*runtime_storage_gib) * 1024)
    {
        return Err(format!(
            "{name} root disk capacity does not match its saved runtime storage."
        ));
    }
    let expected = [(
        "workspace",
        runtime::WORKSPACE_MOUNT,
        *workspace_storage_gib,
    )];
    let mounts = inspected
        .config
        .get("mounts")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{name} does not report its mounted storage."))?;
    if mounts.iter().any(|mount| {
        let kind = mount.get("type").and_then(Value::as_str);
        kind != Some("Tmpfs") && kind != Some("DiskImage")
    }) {
        return Err(format!(
            "{name} uses storage outside its Silo-managed disks, so a complete backup was not created."
        ));
    }
    expected
        .into_iter()
        .map(|(role, mount_path, configured_gib)| {
            let source_path = runtime::disk_path(paths, name, role);
            let mounted = mounts.iter().any(|mount| {
                mount.get("type").and_then(Value::as_str) == Some("DiskImage")
                    && mount.get("host").and_then(Value::as_str) == source_path.to_str()
                    && mount.get("guest").and_then(Value::as_str) == Some(mount_path)
                    && mount.get("format").and_then(Value::as_str) == Some("Raw")
                    && mount.get("fstype").and_then(Value::as_str) == Some("ext4")
            });
            if !mounted {
                return Err(format!(
                    "{name} does not mount its {role} disk at {mount_path}, so a complete backup was not created."
                ));
            }
            let configured_bytes = u64::from(configured_gib)
                .checked_mul(GIB)
                .ok_or_else(|| format!("{name} has an invalid {role} disk size."))?;
            let metadata = fs::symlink_metadata(&source_path)
                .map_err(|error| format!("Silo could not inspect {name} {role} disk: {error}"))?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != configured_bytes
            {
                return Err(format!(
                    "{name} {role} disk does not match its saved {configured_gib} GB capacity."
                ));
            }
            Ok(backup::BackupVolumeSource {
                role: role.into(),
                mount_path: mount_path.into(),
                source_path,
                capacity_bytes: configured_bytes,
            })
        })
        .collect()
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

fn cleanup_restored(
    paths: &runtime::RuntimePaths,
    name: &str,
    expected_id: &str,
) -> Result<(), String> {
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
                || error.to_ascii_lowercase().contains("does not exist") => false,
        Err(error) => {
            return Err(format!(
                "Silo could not verify restored VM ownership for cleanup: {error}"
            ))
        }
    };

    let runtime_cleanup = if !runtime_exists { Ok(()) } else { match runtime::run_msb(
        paths,
        &[
            "remove".into(),
            "--force".into(),
            "--quiet".into(),
            name.into(),
        ],
        Duration::from_secs(45),
    ) {
        Ok(_) => Ok(()),
        Err(error)
            if error.to_string().to_ascii_lowercase().contains("not found")
                || error
                    .to_string()
                    .to_ascii_lowercase()
                    .contains("does not exist") =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    } };
    runtime_cleanup?;
    let disks = paths.volumes.join(name);
    match fs::remove_dir_all(&disks) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Silo could not remove incomplete restored disks: {error}"
        )),
    }
}

fn cleanup_failed_restore(controller: &Controller, paths: &runtime::RuntimePaths, name: &str, id: &str) -> Result<(), String> {
    // A metadata write can commit before its final sync reports failure. Preserve
    // that VM for recovery rather than removing a now-recorded sandbox.
    if runtime::read_metadata(&paths.metadata).map_err(|e| e.to_string())?.machines.iter().any(|machine| machine.id() == id) {
        return Err("The restored sandbox is already recorded. It was preserved for verification after relaunch.".into());
    }
    cleanup_restored(paths, name, id)?;
    recovery::clear_restore_identity(controller)
}

struct RestoredResources<'a> {
    name: &'a str,
    id: &'a str,
    cpus: u64,
    max_cpus: u64,
    memory_gib: u64,
    max_memory_gib: u64,
    workspace_storage_gib: u64,
    runtime_storage_gib: u64,
}

fn restore_create_arguments(
    snapshot: &Path,
    mounts: &[(PathBuf, &str)],
    resources: RestoredResources<'_>,
) -> Vec<String> {
    vec![
        "create".into(),
        "--pull".into(),
        "never".into(),
        "--from-snapshot".into(),
        snapshot.to_string_lossy().into_owned(),
        "--name".into(),
        resources.name.into(),
        "--cpus".into(),
        resources.cpus.to_string(),
        "--max-cpus".into(),
        resources.max_cpus.to_string(),
        "--memory".into(),
        format!("{}G", resources.memory_gib),
        "--max-memory".into(),
        format!("{}G", resources.max_memory_gib),
        "--mount-disk".into(),
        format!(
            "{}:{}:format=raw,fstype=ext4",
            mounts[0].0.display(),
            mounts[0].1
        ),
        "--label".into(),
        "silo.managed=true".into(),
        "--label".into(),
        format!("silo.machine-id={}", resources.id),
        "--label".into(),
        format!(
            "silo.workspace-storage-gib={}",
            resources.workspace_storage_gib
        ),
        "--label".into(),
        format!("silo.runtime-storage-gib={}", resources.runtime_storage_gib),
        "--quiet".into(),
    ]
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
    let result = start_restore_inner(
        app.clone(),
        window,
        controller,
        archive_path,
        new_name,
        source_name,
    )
    .await;
    if result.is_err() {
        crate::notifications::backup_result(&app, "restore", "failed");
    }
    result
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
        .map_err(|_| "Another backup or restore operation is running.".to_string())?;
    let controller = controller.inner().clone();
    let path = PathBuf::from(&archive_path);
    let cancellation = backup::Cancellation::default();
    let archive = Archive {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        archive_path,
        completed_label: "Checking backup".into(),
        size: "Unknown".into(),
        destination: path.parent().unwrap_or(Path::new("")).to_string_lossy().into_owned(),
        sandboxes: source_name.iter().cloned().collect(),
    };
    if let Err(error) = recovery::begin(&controller, recovery::Journal::restore(archive.clone(), new_name.clone(), source_name.clone())) {
        finish(&controller); return Err(error);
    }
    {
        let mut view = controller
            .view
            .lock()
            .map_err(|_| "Backup state is unavailable.".to_string())?;
        view.cancellation = Some(cancellation.clone());
        view.operation = Some(Operation::Running {
            operation: "restore",
            archive: archive.clone(),
            running_names: Vec::new(),
            target_name: Some(new_name.clone()),
            progress: 0,
            indeterminate: Some(true),
            phases: vec![Phase {
                title: "Checking backup".into(),
                detail: "Verifying the archive before restoring.".into(),
                tone: "running",
            }],
        });
    }
    publish(&app, &controller);
    let app_for_work = app.clone();
    let controller_for_work = controller.clone();
    tauri::async_runtime::spawn_blocking(move || run_restore(app_for_work, controller_for_work, path, new_name, source_name, cancellation, archive));
    Ok(())
}

fn run_restore(app: AppHandle, controller: Arc<Controller>, path: PathBuf, new_name: String, source_name: Option<String>, cancellation: backup::Cancellation, archive: Archive) {
        let mut archive = archive;
        let result = (|| {
            let inspection = controller.service.inspect_archive(&path, &cancellation)
                .map_err(|error| error.to_string())?;
            let selected = select_archive_source(&inspection.sandboxes, source_name.as_deref())?;
            archive = archive_from(&path, &inspection);
            if let Ok(mut view) = controller.view.lock() {
                if let Some(Operation::Running { archive: current, .. }) = view.operation.as_mut() {
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
                title: "Restore complete".into(),
                message: "Sandbox restored successfully.".into(),
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
                    "Restore cancelled".into()
                } else {
                    "Restore failed".into()
                },
                message: error,
                detail: Some("No existing sandbox or backup was replaced.".into()),
            },
        };
        let operation = recovery::complete(&controller, operation);
        if let Operation::Result {
            operation: kind,
            outcome,
            ..
        } = &operation
        {
            crate::notifications::backup_result(&app, kind, outcome);
        }
        let _ = set_operation(&controller, operation);
        finish(&controller);
        publish(&app, &controller);

}

fn select_archive_source(names: &[String], selected: Option<&str>) -> Result<String, String> {
    match selected {
        Some(name) if names.iter().any(|candidate| candidate == name) => Ok(name.into()),
        Some(_) => Err("The selected VM is not in this backup.".into()),
        None if names.len() == 1 => Ok(names[0].clone()),
        None => Err("Choose which VM to restore from this backup.".into()),
    }
}

fn append_restored_settings(arguments: &mut Vec<String>, config: &Value) -> Result<(), String> {
    if config.get("network").is_some_and(backup::default_github_network) {
        arguments.extend([
            "--secret".into(), "SILO_GITHUB@github.com,api.github.com,uploads.github.com".into(),
            "--label".into(), "silo.github-protocol=1".into(),
        ]);
    }
    if let Some(labels) = config.get("labels") {
        let labels = labels
            .as_object()
            .ok_or("The backup has invalid VM labels.")?;
        for (key, value) in labels {
            if key.starts_with("silo.") {
                continue;
            }
            let value = value.as_str().ok_or("The backup has invalid VM labels.")?;
            if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                return Err("The backup has invalid VM labels.".into());
            }
            arguments.push("--label".into());
            arguments.push(format!("{key}={value}"));
        }
    }
    let Some(env) = config.get("env") else {
        return Ok(());
    };
    let env = env
        .as_array()
        .ok_or("The backup has invalid VM environment settings.")?;
    for entry in env {
        let key = entry
            .get("key")
            .and_then(Value::as_str)
            .ok_or("The backup has invalid VM environment settings.")?;
        let value = entry
            .get("value")
            .and_then(Value::as_str)
            .ok_or("The backup has invalid VM environment settings.")?;
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("The backup has invalid VM environment settings.".into());
        }
        arguments.push("--env".into());
        arguments.push(format!("{key}={value}"));
    }
    Ok(())
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
            phases.push(Phase { title: title.into(), detail: String::new(), tone: "running" });
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
    progress("Preparing restore");
    let _guard = mutation_guard(cancellation)?;
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
    let disk_directory = paths.volumes.join(new_name);
    // Older deletions left an empty directory behind. remove_dir only succeeds
    // for an empty directory; never recursively remove or overwrite disk data.
    if disk_directory.exists() && fs::remove_dir(&disk_directory).is_err() {
        return Err(format!(
            "Managed disk storage already exists for {new_name}. No existing disk was changed."
        ));
    }
    progress("Unpacking backup");
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
    let field = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("The backup omits {name}."))
    };
    let cpus = field("cpus")?;
    let max_cpus = field("maxCPUs")?;
    let memory = field("memoryGiB")?;
    let max_memory = field("maxMemoryGiB")?;
    let workspace = field("workspaceStorageGiB")?;
    let runtime_storage = field("runtimeStorageGiB")?;
    let machine: runtime::MachineConfiguration = serde_json::from_value(machine_value)
        .map_err(|_| "The backup has invalid Silo VM settings.".to_string())?;
    if prepared.volumes.len() != 1 {
        return Err("The backup does not contain its managed workspace disk.".into());
    }
    let mut roles = std::collections::HashSet::new();
    for volume in &prepared.volumes {
        let (expected_mount, configured_gib) = match volume.role.as_str() {
            "workspace" => (runtime::WORKSPACE_MOUNT, workspace),
            _ => return Err("The backup contains an unknown disk role.".into()),
        };
        if !roles.insert(volume.role.as_str()) {
            return Err(format!(
                "The backup contains a duplicate {} disk.",
                volume.role
            ));
        }
        if volume.mount_path != expected_mount {
            return Err(format!(
                "The backup maps its {} disk to an unsupported path.",
                volume.role
            ));
        }
        let configured_bytes = configured_gib
            .checked_mul(GIB)
            .ok_or_else(|| format!("The backup has an invalid {} disk size.", volume.role))?;
        if volume.capacity_bytes != configured_bytes
            || volume.capacity_bytes != volume.logical_size_bytes
        {
            return Err(format!(
                "The backup {} disk capacity does not match its saved Silo settings.",
                volume.role
            ));
        }
    }
    fs::create_dir_all(&paths.volumes)
        .map_err(|error| format!("Silo could not prepare restored disk storage: {error}"))?;
    recovery::save_restore_identity(controller, &id)?;
    recovery::claim_disk(&disk_directory, &id)?;
    progress("Restoring workspace disk");
    let mut mounts = Vec::new();
    for volume in &prepared.volumes {
        let expected_mount = match volume.role.as_str() {
            "workspace" => runtime::WORKSPACE_MOUNT,
            _ => unreachable!("volume roles were validated before claiming disk storage"),
        };
        let destination = runtime::disk_path(&paths, new_name, &volume.role);
        if destination.exists() {
            return Err(format!(
                "Managed disk storage already exists for {new_name}. No existing disk was changed."
            ));
        }
        if let Err(error) = backup::materialize_prepared_volume(volume, &destination, cancellation)
        {
            let cleanup = cleanup_failed_restore(controller, &paths, new_name, &id);
            return Err(match cleanup {
                Ok(()) => error.to_string(),
                Err(cleanup) => format!("{error} Cleanup also failed: {cleanup}"),
            });
        }
        mounts.push((destination, expected_mount));
    }
    let mut arguments = restore_create_arguments(
        &prepared.snapshot_path,
        &mounts,
        RestoredResources {
            name: new_name,
            id: &id,
            cpus,
            max_cpus,
            memory_gib: memory,
            max_memory_gib: max_memory,
            workspace_storage_gib: workspace,
            runtime_storage_gib: runtime_storage,
        },
    );
    if let Err(error) = append_restored_settings(&mut arguments, &prepared.runtime_config) {
        let cleanup = cleanup_failed_restore(controller, paths, new_name, &id);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => format!("{error} Cleanup also failed: {cleanup}"),
        });
    }
    let command = backup::MsbCommand {
        executable: paths.executable.clone(),
        home: paths.home.clone(),
        storage_home: paths.storage_home.clone(),
        library: paths.library.clone(),
    };
    progress("Creating restored sandbox");
    let output = match backup::MsbRunner::run(
        &backup::SystemMsbRunner,
        &command,
        &arguments,
        RESTORE_TIMEOUT,
        cancellation,
    ) {
        Ok(output) => output,
        Err(error) => {
            let cleanup = cleanup_failed_restore(controller, &paths, new_name, &id);
            return Err(match cleanup {
                Ok(_) => error.to_string(),
                Err(cleanup) => format!("{error} Cleanup also failed: {cleanup}"),
            });
        }
    };
    if !output.status.success() {
        let detail = if output.stderr.is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        let error = format!("Creating the restored sandbox failed: {detail}");
        let cleanup = cleanup_failed_restore(controller, &paths, new_name, &id);
        return Err(match cleanup {
            Ok(_) => error,
            Err(cleanup) => format!("{error} Cleanup also failed: {cleanup}"),
        });
    }
    progress("Verifying restored sandbox");
    let result = (|| {
        let inspected = inspect(&paths, new_name)?;
        if inspected.status != "Created" {
            return Err(format!(
                "The restored sandbox reported state '{}', not newly created and stopped.",
                inspected.status
            ));
        }
        runtime::ensure_managed(&inspected).map_err(|error| error.to_string())?;
        backup_volumes(&paths, &machine, &inspected)?;
        let mut updated = original.clone();
        updated.machines.push(machine);
        runtime::write_metadata(&paths.metadata, &updated).map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        let cleanup = cleanup_failed_restore(controller, &paths, new_name, &id);
        return Err(match cleanup {
            Ok(_) => error,
            Err(cleanup) => format!("{error} Cleanup also failed: {cleanup}"),
        });
    }
    recovery::remove_disk_marker(&disk_directory)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn cancel_backup_operation(
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
) -> Result<(), String> {
    require_main(&window)?;
    let view = controller
        .view
        .lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?;
    let cancellation = view
        .cancellation
        .as_ref()
        .ok_or("No backup or restore operation is running.")?;
    recovery::cancel(&controller)?;
    cancellation.cancel();
    Ok(())
}

#[tauri::command]
pub(crate) fn dismiss_backup_operation(
    app: AppHandle,
    window: WebviewWindow,
    controller: State<'_, Arc<Controller>>,
    expected_operation: Value,
    expected_operation_id: Option<String>,
) -> Result<(), String> {
    require_main(&window)?;
    if dismiss_finished_operation(&controller, Some(&expected_operation), expected_operation_id.as_deref())? {
        publish(&app, &controller);
    }
    Ok(())
}

fn dismiss_finished_operation(controller: &Controller, expected: Option<&Value>, expected_id: Option<&str>) -> Result<bool, String> {
    let mut view = controller.view.lock()
        .map_err(|_| "Backup state is unavailable.".to_string())?;
    if matches!(view.operation, Some(Operation::Running { .. })) {
        return Ok(false);
    }
    if recovery::unresolved(controller)? { return Ok(false); }
    if recovery::token(controller)?.as_deref() != expected_id { return Ok(false); }
    if let Some(expected) = expected {
        if serde_json::to_value(&view.operation).map_err(|e| e.to_string())? != *expected { return Ok(false); }
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
                    *title = "Backup complete".into();
                    *message = "The backup is complete and all previously running sandboxes are running again.".into();
                    *detail = None;
                } else {
                    *message = format!(
                        "The backup is complete. {} still require a manual restart.",
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
        set_operation(&controller, Operation::Running {
            operation: "restore",
            archive: completed_archive(),
            running_names: Vec::new(),
            target_name: Some("restored".into()),
            progress: 0,
            indeterminate: Some(true),
            phases: vec![Phase { title: "Checking backup".into(), detail: String::new(), tone: "running" }],
        }).unwrap();
        assert!(!dismiss_finished_operation(&controller, None, None).unwrap());
        assert!(matches!(controller.view.lock().unwrap().operation, Some(Operation::Running { .. })));
        advance_restore_phase(&controller, "Unpacking backup");
        let serialized = serde_json::to_value(&controller.view.lock().unwrap().operation).unwrap();
        assert_eq!(serialized["indeterminate"], true);
        assert_eq!(serialized["phases"], serde_json::json!([
            { "title": "Checking backup", "detail": "", "tone": "succeeded" },
            { "title": "Unpacking backup", "detail": "", "tone": "running" },
        ]));
        set_operation(&controller, Operation::Result {
            operation: "restore", archive: completed_archive(), running_names: Vec::new(),
            target_name: Some("restored".into()), outcome: "success", title: "Restored".into(),
            message: "Sandbox restored successfully.".into(), detail: None,
        }).unwrap();
        assert!(dismiss_finished_operation(&controller, None, None).unwrap());
        assert!(!dismiss_finished_operation(&controller, None, None).unwrap());
    }

    #[test]
    fn resumed_work_waits_for_other_sandbox_changes_and_can_cancel_while_waiting() {
        let guard = runtime::MUTATION_LOCK.lock().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = mutation_guard(&backup::Cancellation::default()).map(|_| ());
            sender.send(result).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(20)).is_err());
        let cancellation = backup::Cancellation::default();
        cancellation.cancel();
        assert_eq!(mutation_guard(&cancellation).unwrap_err(), "The operation was cancelled.");
        drop(guard);
        assert!(receiver.recv_timeout(Duration::from_secs(5)).unwrap().is_ok());
        worker.join().unwrap();
    }

    #[test]
    fn delayed_dismissal_cannot_clear_a_new_completed_operation() {
        let directory = tempfile::tempdir().unwrap();
        let controller = history_controller(directory.path().join("backup-history.json"));
        let result = |name: &str| Operation::Result { operation: "restore", archive: completed_archive(), running_names: vec![], target_name: Some(name.into()), outcome: "success", title: "Restore complete".into(), message: "Sandbox restored successfully.".into(), detail: None };
        let old = serde_json::to_value(result("first")).unwrap();
        set_operation(&controller, result("second")).unwrap();
        assert!(!dismiss_finished_operation(&controller, Some(&old), None).unwrap());
        assert!(matches!(&controller.view.lock().unwrap().operation, Some(Operation::Result { target_name: Some(name), .. }) if name == "second"));
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
        let first = unique_archive(directory.path());
        fs::write(&first, b"existing").unwrap();
        let second = unique_archive(directory.path());
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"existing");
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

    #[test]
    fn restore_preserves_identity_without_shell_interpretation() {
        let mut arguments = vec![];
        append_restored_settings(&mut arguments, &serde_json::json!({"env": [{"key":"GIT_AUTHOR_NAME","value":"A $(literal) Name"},{"key":"GIT_AUTHOR_EMAIL","value":"test@example.test"}]})).unwrap();
        assert!(arguments.contains(&"GIT_AUTHOR_NAME=A $(literal) Name".into()));
        assert!(append_restored_settings(
            &mut vec![],
            &serde_json::json!({"env":[{"key":"bad=key","value":"value"}]})
        )
        .is_err());
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
        run(&["exec", name, "--", "sh", "-c", "printf root-proof > /root/silo-backup-proof; printf workspace-proof > /workspace/silo-backup-proof; sync"]);
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
        run(&["exec", second_name, "--", "sh", "-c", "printf second-root > /root/silo-backup-proof; printf second-workspace > /workspace/silo-backup-proof; sync"]);
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
                            was_running: true,
                            volumes: backup_volumes(&paths, &machine, &inspected).unwrap(),
                            runtime_config: inspected.config.clone(),
                            machine_config: serde_json::to_value(&machine).unwrap(),
                        },
                        backup::BackupSource {
                            name: second_name.into(),
                            was_running: false,
                            volumes: backup_volumes(&paths, &second_machine, &second_inspected)
                                .unwrap(),
                            runtime_config: second_inspected.config.clone(),
                            machine_config: serde_json::to_value(&second_machine).unwrap(),
                        },
                    ],
                },
                &backup::Cancellation::default(),
            )
            .unwrap();
        assert_eq!(inspect(&paths, name).unwrap().status, "Running");
        let checked = controller.service.inspect_archive(&archive, &backup::Cancellation::default()).unwrap();
        recovery::begin(&controller, recovery::Journal::backup(archive_from(&archive, &checked), vec![name.into(), second_name.into()])).unwrap();
        recovery::save_sources(&controller, &[
            backup::BackupSource { name: name.into(), was_running: true, volumes: backup_volumes(&paths, &machine, &inspected).unwrap(), runtime_config: inspected.config, machine_config: serde_json::to_value(&machine).unwrap() },
            backup::BackupSource { name: second_name.into(), was_running: false, volumes: backup_volumes(&paths, &second_machine, &second_inspected).unwrap(), runtime_config: second_inspected.config, machine_config: serde_json::to_value(&second_machine).unwrap() },
        ]).unwrap();
        // Archive publication succeeded, but app death can precede completion
        // reporting and restoration of the guest's previous running state.
        run(&["stop", name]);
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(recovery::recover_at_paths(&paths, &controller, &checkpoint, &backup::Cancellation::default()).unwrap());
        assert_eq!(inspect(&paths, name).unwrap().status, "Running");
        assert_eq!(inspect(&paths, second_name).unwrap().status, "Stopped");
        assert_ne!(load_history(&controller.history_path).unwrap().archives[0].size, "Unknown");
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
        let checked = controller.service.inspect_archive(&archive, &backup::Cancellation::default()).unwrap();
        recovery::begin(&controller, recovery::Journal::restore(archive_from(&archive, &checked), restored_name.into(), Some(name.into()))).unwrap();
        // Emulate process death after the owned disk directory was claimed but
        // before msb create. Only this operation's partial disk can be removed.
        let interrupted_id = uuid::Uuid::new_v4().to_string();
        recovery::save_restore_identity(&controller, &interrupted_id).unwrap();
        recovery::claim_disk(&paths.volumes.join(restored_name), &interrupted_id).unwrap();
        fs::write(runtime::disk_path(&paths, restored_name, "workspace"), b"incomplete disk").unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(!recovery::recover_at_paths(&paths, &controller, &checkpoint, &backup::Cancellation::default()).unwrap());
        assert!(!paths.volumes.join(restored_name).exists());
        // A durable cancellation cleans owned partial output and does not create
        // the requested guest when the app reopens.
        recovery::save_restore_identity(&controller, &interrupted_id).unwrap();
        recovery::claim_disk(&paths.volumes.join(restored_name), &interrupted_id).unwrap();
        fs::write(runtime::disk_path(&paths, restored_name, "workspace"), b"cancelled disk").unwrap();
        recovery::cancel(&controller).unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(recovery::recover_at_paths(&paths, &controller, &checkpoint, &backup::Cancellation::default()).unwrap());
        assert!(!paths.volumes.join(restored_name).exists());
        recovery::complete(&controller, Operation::Result { operation: "restore", archive: archive_from(&archive, &checked), running_names: vec![], target_name: Some(restored_name.into()), outcome: "cancelled", title: "Cancelled".into(), message: "Cancelled".into(), detail: None });
        recovery::begin(&controller, recovery::Journal::restore(archive_from(&archive, &checked), restored_name.into(), Some(name.into()))).unwrap();
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
        assert_eq!(*restore_phases.lock().unwrap(), [
            "Preparing restore", "Unpacking backup", "Restoring workspace disk",
            "Creating restored sandbox", "Verifying restored sandbox",
        ]);
        let restored = inspect(&paths, restored_name).unwrap();
        assert_eq!(restored.status, "Created");
        // Metadata was committed, but process death could precede marker removal
        // and delivery of the success event. Relaunch verifies and adopts it.
        let restored_id = restored.config["labels"]["silo.machine-id"].as_str().unwrap();
        fs::write(paths.volumes.join(restored_name).join(".silo-restore-owner"), restored_id).unwrap();
        let checkpoint = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(recovery::recover_at_paths(&paths, &controller, &checkpoint, &backup::Cancellation::default()).unwrap());
        assert!(!paths.volumes.join(restored_name).join(".silo-restore-owner").exists());
        recovery::save_restore_identity(&controller, &uuid::Uuid::new_v4().to_string()).unwrap();
        let foreign = recovery::load(&controller.history_path).unwrap().unwrap();
        assert!(recovery::recover_at_paths(&paths, &controller, &foreign, &backup::Cancellation::default()).unwrap_err().contains("different sandbox"));
        assert_eq!(inspect(&paths, restored_name).unwrap().status, "Created");
        assert!(runtime::disk_path(&paths, restored_name, "workspace").exists());
        recovery::save_restore_identity(&controller, restored_id).unwrap();


        assert_eq!(
            restored.config.get("pull_policy").and_then(Value::as_str),
            Some("Never")
        );
        assert!(backup::default_github_network(&restored.config["network"]));
        assert_eq!(restored.config["labels"]["silo.github-protocol"], "1");
        run(&["start", restored_name]);
        assert_eq!(run(&["exec", restored_name, "--", "git", "config", "--global", "--get", "user.email"]).stdout.trim(), "silo-test@example.invalid");
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
        eprintln!("Verified stopped restore without original VM/cache; both root and workspace files survived.");
    }
}
