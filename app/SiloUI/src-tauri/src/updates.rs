//! Host-owned signed updates. The webview never chooses an endpoint, key or installer.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, RwLock, RwLockReadGuard},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

// Existing module locks still order their own operations. This one admission gate
// prevents an update from overtaking a queued write, and rejects new writes while
// installation owns the process. Readers never wait behind the installer.
static ADMISSION: RwLock<()> = RwLock::new(());
pub(crate) fn operation_guard() -> Result<RwLockReadGuard<'static, ()>, String> {
    ADMISSION
        .try_read()
        .map_err(|_| "Silo is installing an update. Try again after it restarts.".into())
}
const RELEASE_URL: &str = "https://github.com/0xpolarzero/silo/releases/latest";
const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    phase: String,
    last_checked: Option<String>,
    retry_action: Option<String>,
    current_version: String,
    available_version: Option<String>,
    release_notes: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    automatic_checks: bool,
    package_kind: String,
    release_url: String,
    error: Option<String>,
    error_details: Option<String>,
    running_sandboxes: Vec<String>,
    can_install: bool,
    install_block_reason: Option<String>,
}
struct State {
    snapshot: Snapshot,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}
struct Controller {
    state: Mutex<State>,
    preferences: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    automatic_checks: bool,
}
fn read_preferences(path: &Path) -> Result<bool, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes)
            .map(|p| p.automatic_checks)
            .map_err(|_| {
                "Update preferences could not be read. Save your preference again.".into()
            }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err("Update preferences could not be read. Save your preference again.".into()),
    }
}
fn save_preferences(path: &Path, enabled: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Update preference storage is unavailable.")?;
    fs::create_dir_all(parent).map_err(|_| "Update preferences could not be saved.")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Update preferences could not be saved.")?;
    serde_json::to_writer(
        &mut file,
        &Preferences {
            automatic_checks: enabled,
        },
    )
    .map_err(|_| "Update preferences could not be saved.")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "Update preferences could not be saved.")?;
    file.persist(path)
        .map_err(|_| "Update preferences could not be saved.")?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Update preferences could not be saved.".into())
}
fn package_kind(executable: &Path, appimage: Option<&Path>, bundle: Option<tauri::utils::config::BundleType>) -> &'static str {
    if cfg!(target_os = "macos")
        && executable
            .ancestors()
            .any(|p| p.extension().is_some_and(|e| e == "app"))
    {
        "macos"
    } else if cfg!(target_os = "linux") && matches!(bundle, Some(tauri::utils::config::BundleType::AppImage)) && appimage.is_some_and(|p| p.is_absolute() && p.is_file())
    {
        "appimage"
    } else {
        "manual"
    }
}
fn modify(app: &AppHandle, f: impl FnOnce(&mut State)) -> Result<Snapshot, String> {
    let controller = app.state::<Controller>();
    let mut state = controller
        .state
        .lock()
        .map_err(|_| "Update state is unavailable.")?;
    f(&mut state);
    let snapshot = state.snapshot.clone();
    let _ = app.emit("silo://update-state", &snapshot);
    Ok(snapshot)
}
fn fail(app: &AppHandle, message: &str, details: impl ToString) -> Result<Snapshot, String> {
    modify(app, |s| {
        s.snapshot.phase = "error".into();
        s.snapshot.error = Some(message.into());
        s.snapshot.error_details = Some(details.to_string());
        s.snapshot.retry_action = Some(
            if s.bytes.is_some() {
                "install"
            } else if s.update.is_some() {
                "download"
            } else {
                "check"
            }
            .into(),
        );
    })
}
pub(crate) fn recovery_failed(app: &AppHandle, message: String) {
    let _ = fail(
        app,
        "Some sandboxes could not resume after updating. Relaunch Silo to retry.",
        message,
    );
    crate::notifications::action_failed(app, "Sandboxes could not resume after updating");
}
fn busy(phase: &str) -> bool {
    matches!(phase, "checking" | "downloading" | "installing")
}
fn ready(app: &AppHandle) -> Result<(), String> {
    let _admission = ADMISSION
        .try_write()
        .map_err(|_| "Wait for active operations to finish before updating.")?;
    crate::backup_controller::update_ready(app)?;
    let _github = crate::github::update_guard()?;
    let _secrets = crate::secrets::update_guard()?;
    let _runtime = crate::runtime::MUTATION_LOCK
        .try_lock()
        .map_err(|_| "Wait for sandbox operations to finish before updating.")?;
    Ok(())
}
pub(crate) fn install(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Update storage is unavailable.")?
        .join("update-preferences.json");
    let preference = read_preferences(&path);
    let error = preference.as_ref().err().cloned();
    let automatic = preference.unwrap_or(false);
    let executable = std::env::current_exe().unwrap_or_default();
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    app.manage(Controller {
        preferences: path,
        state: Mutex::new(State {
            update: None,
            bytes: None,
            snapshot: Snapshot {
                last_checked: None,
                retry_action: None,
                phase: if error.is_some() { "error" } else { "idle" }.into(),
                current_version: app.package_info().version.to_string(),
                available_version: None,
                release_notes: None,
                downloaded_bytes: 0,
                total_bytes: None,
                automatic_checks: automatic,
                package_kind: package_kind(&executable, appimage.as_deref(), tauri::utils::platform::bundle_type()).into(),
                release_url: RELEASE_URL.into(),
                error,
                error_details: None,
                running_sandboxes: vec![],
                can_install: false,
                install_block_reason: None,
            },
        }),
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Quiet launch check, then daily while Silo stays open. Failed checks never install anything.
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            let enabled = app
                .state::<Controller>()
                .state
                .lock()
                .map(|s| {
                    s.snapshot.automatic_checks && !busy(&s.snapshot.phase) && s.bytes.is_none()
                })
                .unwrap_or(false);
            if enabled {
                let _ = check_for_update(app.clone()).await;
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
    Ok(())
}
#[tauri::command]
pub(crate) async fn get_update_state(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let readiness = ready(&app);
        // Do not compete with an active runtime mutation just to refresh a settings card.
        let running = readiness.and_then(|_| {
            crate::runtime::update_recovery::running_names(&app).map_err(|_| {
                "Silo could not verify sandbox status. Check Sandboxes before updating.".to_string()
            })
        });
        modify(&app, |s| {
            s.snapshot.can_install = running.is_ok();
            s.snapshot.install_block_reason = running.as_ref().err().cloned();
            if let Ok(names) = running {
                s.snapshot.running_sandboxes = names;
            }
        })
    })
    .await
    .map_err(|_| "Update state could not be read.".to_string())?
}
#[tauri::command]
pub(crate) fn set_update_automatic_checks(
    app: AppHandle,
    enabled: bool,
) -> Result<Snapshot, String> {
    save_preferences(&app.state::<Controller>().preferences, enabled)?;
    modify(&app, |s| s.snapshot.automatic_checks = enabled)
}
#[tauri::command]
pub(crate) async fn check_for_update(app: AppHandle) -> Result<Snapshot, String> {
    {
        let controller = app.state::<Controller>();
        let mut state = controller
            .state
            .lock()
            .map_err(|_| "Update state is unavailable.")?;
        if busy(&state.snapshot.phase) {
            return Err("An update operation is already running.".into());
        }
        state.snapshot.phase = "checking".into();
        state.snapshot.error = None;
        state.snapshot.error_details = None;
        state.update = None;
        state.bytes = None;
        let _ = app.emit("silo://update-state", &state.snapshot);
    }
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            .build()?
            .check()
            .await
    }
    .await;
    match result {
        Ok(update) => modify(&app, |s| {
            s.snapshot.last_checked = time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .ok();
            s.snapshot.retry_action = None;
            s.snapshot.phase = if update.is_some() {
                "available"
            } else {
                "idle"
            }
            .into();
            s.snapshot.available_version = update.as_ref().map(|u| u.version.clone());
            s.snapshot.release_notes = update.as_ref().and_then(|u| u.body.clone());
            s.snapshot.downloaded_bytes = 0;
            s.snapshot.total_bytes = None;
            s.update = update;
        }),
        Err(e) => fail(
            &app,
            "Could not check for updates. Check your connection and try again.",
            e,
        ),
    }
}
#[tauri::command]
pub(crate) async fn download_update(app: AppHandle) -> Result<Snapshot, String> {
    let mut update = {
        let controller = app.state::<Controller>();
        let mut state = controller
            .state
            .lock()
            .map_err(|_| "Update state is unavailable.")?;
        if busy(&state.snapshot.phase) {
            return Err("An update operation is already running.".into());
        }
        if state.snapshot.package_kind == "manual" {
            return Err("Download the package from Releases to update this installation.".into());
        }
        let update = state
            .update
            .clone()
            .ok_or("Check for an update before downloading.")?;
        state.snapshot.phase = "downloading".into();
        state.snapshot.error = None;
        state.snapshot.error_details = None;
        state.snapshot.downloaded_bytes = 0;
        state.snapshot.total_bytes = None;
        state.bytes = None;
        let _ = app.emit("silo://update-state", &state.snapshot);
        update
    };
    update.timeout = Some(Duration::from_secs(30 * 60));
    let limit = tokio::sync::Notify::new();
    let mut received = 0u64;
    let mut last_report = std::time::Instant::now() - Duration::from_secs(1);
    let result = tokio::select! {
        _ = limit.notified() => Err("The update exceeds the supported download size.".to_string()),
        result = update.download(|bytes, total| {
            received = received.saturating_add(bytes as u64);
            if received > MAX_DOWNLOAD_BYTES || total.is_some_and(|size| size > MAX_DOWNLOAD_BYTES) { limit.notify_one(); }
            if last_report.elapsed() >= Duration::from_millis(100) {
                let _ = modify(&app, |s| { s.snapshot.downloaded_bytes = received; s.snapshot.total_bytes = total; }); last_report = std::time::Instant::now();
            }
        }, || {}) => result.map_err(|e| e.to_string()),
    };
    match result {
        Ok(bytes) => { modify(&app, |s| { s.snapshot.phase = "ready".into(); s.snapshot.downloaded_bytes = bytes.len() as u64; s.snapshot.total_bytes = Some(bytes.len() as u64); s.bytes = Some(bytes); })?; get_update_state(app).await },
        Err(e) => fail(&app, "The update could not be downloaded or verified. Your installation was not changed. Try again.", e),
    }
}
fn unpacked_size(bytes: &[u8], macos: bool) -> Result<u64, String> {
    if !macos {
        return Ok(bytes.len() as u64);
    }
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut total = 0u64;
    for entry in archive
        .entries()
        .map_err(|_| "The update archive could not be read.")?
    {
        let entry = entry.map_err(|_| "The update archive is invalid.")?;
        let size = entry
            .header()
            .size()
            .map_err(|_| "The update archive size is invalid.")?;
        total = total
            .checked_add(size)
            .filter(|sum| *sum <= 8 * 1024 * 1024 * 1024)
            .ok_or("The unpacked update exceeds the supported size.")?;
    }
    if total == 0 {
        return Err("The update archive is empty.".into());
    }
    Ok(total)
}
fn installation_preflight(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|_| "The installed application could not be located.")?;
    let destination = if cfg!(target_os = "macos") {
        executable
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .map(Path::to_path_buf)
    } else {
        std::env::var_os("APPIMAGE").map(PathBuf::from)
    }
    .ok_or("This installation must be updated using a downloaded package.")?;
    let parent = destination
        .parent()
        .ok_or("The installation folder could not be located.")?;
    // Test the actual staging directory, rather than assuming Unix mode bits mean writable.
    let probe = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Silo cannot write to its installation folder. Move it to a writable folder or install the new package manually.")?;
    drop(probe);
    use std::os::unix::ffi::OsStrExt;
    let encoded = std::ffi::CString::new(parent.as_os_str().as_bytes())
        .map_err(|_| "The installation folder is invalid.")?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: CString is NUL terminated and stats is a valid exclusive output pointer.
    if unsafe { libc::statvfs(encoded.as_ptr(), &mut stats) } != 0 {
        return Err("Available installation space could not be checked.".into());
    }
    let free = (stats.f_bavail as u64)
        .checked_mul(stats.f_frsize as u64)
        .ok_or("Available installation space is invalid.")?;
    let needed = unpacked_size(bytes, cfg!(target_os = "macos"))?;
    // Existing installation already occupies space. Atomic replacement stages only
    // one new copy beside it; the downloaded archive is held in memory.
    if free < needed {
        return Err(format!(
            "Not enough space to install the update. Free at least {} MB and retry.",
            needed.saturating_sub(free).div_ceil(1024 * 1024)
        ));
    }
    let _ = app;
    Ok(())
}
#[tauri::command]
pub(crate) async fn install_update(
    app: AppHandle,
    stop_sandboxes: bool,
) -> Result<Snapshot, String> {
    let (update, bytes) = {
        let controller = app.state::<Controller>();
        let mut state = controller
            .state
            .lock()
            .map_err(|_| "Update state is unavailable.")?;
        if busy(&state.snapshot.phase) {
            return Err("An update operation is already running.".into());
        }
        if state.snapshot.package_kind == "manual" {
            return Err("Install the downloaded package to update this installation.".into());
        }
        let update = state
            .update
            .clone()
            .ok_or("Download and verify an update before installing.")?;
        let bytes = state
            .bytes
            .take()
            .ok_or("Download and verify an update before installing.")?;
        state.snapshot.phase = "installing".into();
        state.snapshot.error = None;
        state.snapshot.error_details = None;
        let _ = app.emit("silo://update-state", &state.snapshot);
        (update, bytes)
    };
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        crate::startup::cancel_and_wait(&worker);
        // Reservation uses the same atomic gate as backup/restore admission.
        let admission = (|| {
            let admission = ADMISSION.try_write().map_err(|_| "Wait for active operations to finish before updating.")?;
            let backup = crate::backup_controller::update_guard(&worker)?;
            let github = crate::github::update_guard()?;
            let secrets = crate::secrets::update_guard()?;
            let runtime = crate::runtime::MUTATION_LOCK.try_lock().map_err(|_| "Wait for sandbox operations to finish before updating.")?;
            Ok::<_, String>((admission, backup, github, secrets, runtime))
        })();
        let (_admission, _backup, _github, _secrets, _runtime) = match admission {
            Ok(guards) => guards,
            Err(error) => { let _ = modify(&worker, |s| s.bytes = Some(bytes)); return Err(error); }
        };
        let result = installation_preflight(&worker, &bytes)
            .and_then(|_| crate::settings::flush_for_update(&worker))
            .and_then(|_| crate::runtime::update_recovery::prepare(&worker, stop_sandboxes)).and_then(|_| update.install(&bytes).map_err(|e| e.to_string()));
        if let Err(error) = result {
            let restore = crate::runtime::update_recovery::restore_locked(&worker);
            let _ = modify(&worker, |s| s.bytes = Some(bytes));
            return Err(match restore { Ok(()) => error, Err(resume) => format!("{error}\nSandboxes could not resume: {resume}. Relaunch Silo to retry.") });
        }
        // The existing ExitRequested handler flushes frontend/native settings. Keep
        // every operation lock alive until the process exits and restarts.
        worker.restart()
    }).await.unwrap_or_else(|_| Err("Update installation was interrupted. Relaunch Silo to restore the saved sandbox state, then download the update again.".into()));
    match result {
        Ok(()) => get_update_state(app).await,
        Err(e) => fail(
            &app,
            "The update could not be installed. Try again, or download the latest installer.",
            e,
        ),
    }
}
#[tauri::command]
pub(crate) async fn open_update_release() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let opener = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(opener)
            .arg(RELEASE_URL)
            .spawn()
            .map(|_| ())
            .map_err(|_| "The browser could not be opened.".to_string())
    })
    .await
    .map_err(|_| "The browser could not be opened.".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_preferences_enable_checks_but_corrupt_preferences_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("prefs.json");
        assert!(read_preferences(&p).unwrap());
        save_preferences(&p, false).unwrap();
        assert!(!read_preferences(&p).unwrap());
        fs::write(&p, "broken").unwrap();
        assert!(read_preferences(&p).is_err());
    }
    #[test]
    fn ordinary_executable_does_not_claim_updatable_package() {
        assert_eq!(package_kind(Path::new("/usr/bin/silo-ui"), None, None), "manual");
    }
    #[test]
    fn preflight_counts_actual_tar_members_and_rejects_invalid_archive() {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        for size in [16usize, 32] {
            let mut header = tar::Header::new_gnu();
            header.set_size(size as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive
                .append_data(
                    &mut header,
                    format!("Silo.app/file{size}"),
                    vec![0u8; size].as_slice(),
                )
                .unwrap();
        }
        let bytes = archive.into_inner().unwrap().finish().unwrap();
        assert_eq!(unpacked_size(&bytes, true).unwrap(), 48);
        assert_eq!(unpacked_size(&bytes, false).unwrap(), bytes.len() as u64);
        assert!(unpacked_size(b"not an archive", true).is_err());
    }
    #[test]
    fn debian_with_stray_appimage_environment_remains_manual() {
        let image = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(package_kind(Path::new("/usr/bin/silo-ui"), Some(image.path()), Some(tauri::utils::config::BundleType::Deb)), "manual");
    }

}
