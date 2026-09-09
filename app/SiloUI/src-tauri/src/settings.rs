use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU8, Ordering},
        Condvar, Mutex, MutexGuard,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;
const MAX_DRAFT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    settings: Map<String, Value>,
    onboarding_draft: Value,
    save_error: Option<String>,
}

struct SettingsStore {
    path: Option<PathBuf>,
    document: Map<String, Value>,
    snapshot: Snapshot,
    protected_error: Option<String>,
    dirty: bool,
}

impl SettingsStore {
    fn load(path: Option<PathBuf>) -> Self {
        let mut store = Self {
            path,
            document: json!({"schemaVersion": 1, "settings": {}, "onboardingDraft": null})
                .as_object()
                .unwrap()
                .clone(),
            snapshot: Snapshot {
                revision: 0,
                settings: Map::new(),
                onboarding_draft: Value::Null,
                save_error: None,
            },
            protected_error: None,
            dirty: false,
        };
        if let Some(path) = &store.path {
            match read_document(path) {
                Ok(Some(document)) => {
                    if document.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                        store.protect("Settings use an unsupported file version; the file was left unchanged.");
                    }
                    if let Some(settings) = document.get("settings").and_then(Value::as_object) {
                        for (key, value) in settings {
                            match valid_setting(key, value) {
                                Some(true) => { store.snapshot.settings.insert(key.clone(), value.clone()); }
                                Some(false) => store.protect("Saved settings contain an invalid value; the file was left unchanged."),
                                None => {}, // Preserve future fields on disk without exposing them to views.
                            }
                        }
                    } else if document.contains_key("settings") {
                        store.protect("Saved settings have an invalid structure; the file was left unchanged.");
                    }
                    if let Some(draft) = document.get("onboardingDraft") {
                        if valid_draft(draft) {
                            store.snapshot.onboarding_draft = draft.clone();
                        } else {
                            store.protect(
                                "Saved onboarding data is invalid; the file was left unchanged.",
                            );
                        }
                    }
                    store.document = document;
                }
                Ok(None) => {}
                Err(error) => store.protect(&format!(
                    "Settings could not be read; the file was left unchanged: {error}"
                )),
            }
        }
        store
    }

    fn protect(&mut self, error: &str) {
        self.protected_error = Some(error.to_owned());
        self.snapshot.save_error = self.protected_error.clone();
    }

    fn snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }

    fn update(&mut self, patch: Map<String, Value>) -> Result<Snapshot, String> {
        if patch
            .iter()
            .any(|(key, value)| valid_setting(key, value) != Some(true))
        {
            return Err("Invalid settings change".into());
        }
        if !patch.is_empty() {
            self.snapshot.settings.extend(patch);
            self.changed();
        }
        Ok(self.snapshot())
    }

    fn update_draft(&mut self, draft: Value) -> Result<Snapshot, String> {
        if !valid_draft(&draft) {
            return Err("Invalid onboarding draft".into());
        }
        self.snapshot.onboarding_draft = draft;
        self.changed();
        Ok(self.snapshot())
    }

    fn import_theme(&mut self, theme: String) -> Result<Snapshot, String> {
        if valid_setting("theme", &Value::String(theme.clone())) != Some(true) {
            return Err("Invalid legacy theme".into());
        }
        if !self.snapshot.settings.contains_key("theme") {
            self.snapshot
                .settings
                .insert("theme".into(), Value::String(theme));
            self.changed();
        }
        Ok(self.snapshot())
    }

    fn changed(&mut self) {
        self.snapshot.revision += 1;
        self.dirty = true;
        let _ = self.save();
    }

    fn save(&mut self) -> Result<(), String> {
        if let Some(error) = &self.protected_error {
            return Err(error.clone());
        }
        if !self.dirty {
            return Ok(());
        }
        let mut document = self.document.clone();
        let settings = document.entry("settings").or_insert_with(|| json!({}));
        settings
            .as_object_mut()
            .expect("invalid document is write-protected")
            .extend(self.snapshot.settings.clone());
        document.insert(
            "onboardingDraft".into(),
            self.snapshot.onboarding_draft.clone(),
        );
        let result = match &self.path {
            Some(path) => write_document(path, &document)
                .map_err(|error| format!("Settings could not be saved: {error}")),
            None => Ok(()),
        };
        self.snapshot.save_error = result.as_ref().err().cloned();
        if result.is_ok() {
            self.document = document;
            self.dirty = false;
        }
        result
    }
}

fn read_document(path: &Path) -> io::Result<Option<Map<String, Value>>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "settings file is too large",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    value
        .as_object()
        .cloned()
        .map(Some)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "expected a settings object"))
}

fn write_document(path: &Path, document: &Map<String, Value>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing settings directory"))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut bytes = serde_json::to_vec_pretty(document)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "settings file is too large",
        ));
    }
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    // Rename is atomic; syncing the directory makes its new entry durable as well.
    File::open(parent)?.sync_all()
}

fn bounded_string(value: &Value, max: usize, allow_empty: bool) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.encode_utf16().count() <= max && (allow_empty || !text.is_empty()))
}

fn valid_setting(key: &str, value: &Value) -> Option<bool> {
    Some(match key {
        "theme" => matches!(value.as_str(), Some("system" | "light" | "dark")),
        "launchAtLogin"
        | "onboardingComplete"
        | "startWorkspacesAtLaunch"
        | "reduceMotion"
        | "notificationsEnabled"
        | "notifyHealth"
        | "notifyActions"
        | "notifyBackup"
        | "terminalUseSystemDefault"
        | "editorUseSystemDefault"
        | "browserUseSystemDefault" => value.is_boolean(),
        "terminal" | "editor" | "browser" => bounded_string(value, 256, false),
        "terminalPath" | "editorPath" | "browserPath" => {
            value.is_null()
                || (bounded_string(value, 4096, false)
                    && value
                        .as_str()
                        .is_some_and(|path| Path::new(path).is_absolute()))
        }
        "startupWorkspaceIds" => value.as_array().is_some_and(|ids| {
            ids.len() <= 256 && ids.iter().all(|id| bounded_string(id, 256, false))
        }),
        _ => return None,
    })
}

fn only_fields(object: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|key| object.contains_key(*key))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
}

fn valid_uuid(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let Ok(id) = uuid::Uuid::try_parse(text) else {
        return false;
    };
    id.hyphenated().to_string().eq_ignore_ascii_case(text)
        && (id.is_nil()
            || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
            || (id.get_variant() == uuid::Variant::RFC4122
                && (1..=8).contains(&id.get_version_num())))
}

fn valid_name(value: &Value) -> bool {
    value.as_str().is_some_and(|name| {
        (1..=32).contains(&name.len())
            && name.as_bytes()[0].is_ascii_lowercase()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

fn one_of(value: &Value, choices: &[f64]) -> bool {
    value
        .as_f64()
        .is_some_and(|number| choices.contains(&number))
}

fn valid_machine(value: &Value, unfinished: bool) -> bool {
    let Some(machine) = value.as_object() else {
        return false;
    };
    let fields = match machine.get("kind").and_then(Value::as_str) {
        Some("vm") => &[
            "id",
            "kind",
            "name",
            "cpus",
            "maxCPUs",
            "memoryGiB",
            "maxMemoryGiB",
            "workspaceStorageGiB",
            "runtimeStorageGiB",
        ][..],
        Some("ssh") => &["id", "kind", "name", "host", "user", "port"][..],
        _ => return false,
    };
    if !only_fields(machine, fields, &[])
        || !valid_uuid(&machine["id"])
        || !(if unfinished {
            machine["name"].is_string()
        } else {
            valid_name(&machine["name"])
        })
    {
        return false;
    }
    if machine["kind"] == "vm" {
        return ["cpus", "maxCPUs"]
            .iter()
            .all(|key| one_of(&machine[*key], &[4., 6., 8., 12.]))
            && ["memoryGiB", "maxMemoryGiB"]
                .iter()
                .all(|key| one_of(&machine[*key], &[16., 32., 48.]))
            && ["workspaceStorageGiB", "runtimeStorageGiB"]
                .iter()
                .all(|key| one_of(&machine[*key], &[60., 80., 100., 120.]))
            && (unfinished
                || (machine["cpus"].as_f64() <= machine["maxCPUs"].as_f64()
                    && machine["memoryGiB"].as_f64() <= machine["maxMemoryGiB"].as_f64()));
    }
    if unfinished {
        return machine["host"].is_string()
            && machine["user"].is_string()
            && machine["port"].is_number();
    }
    machine["host"].as_str().is_some_and(|host| {
        !host.trim().is_empty()
            && host.trim().encode_utf16().count() <= 253
            && !host.trim().chars().any(char::is_whitespace)
    }) && machine["user"].as_str().is_some_and(|user| {
        let user = user.trim().as_bytes();
        !user.is_empty()
            && user.len() <= 64
            && (user[0].is_ascii_alphabetic() || user[0] == b'_')
            && user
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
    }) && machine["port"]
        .as_f64()
        .is_some_and(|port| port.fract() == 0. && (1. ..=65535.).contains(&port))
}

// This boundary accepts unfinished text, but never accepts auth, runtime state, or arbitrary fields.
// TypeScript applies the existing domain validation before a draft is used as configuration.
fn valid_draft(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(draft) = value.as_object() else {
        return false;
    };
    if serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > MAX_DRAFT_BYTES)
        || !only_fields(
            draft,
            &[
                "currentStep",
                "machines",
                "unfinishedMachineEditor",
                "workspaceSelections",
                "workspaceIdentities",
            ],
            &["workspaceRepositoryAccess"],
        )
    {
        return false;
    }
    if !matches!(
        draft["currentStep"].as_str(),
        Some("dependencies" | "workspaces" | "github" | "review")
    ) || !draft["machines"].as_array().is_some_and(|machines| {
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        (1..=64).contains(&machines.len())
            && machines.iter().all(|machine| {
                valid_machine(machine, false)
                    && ids.insert(machine["id"].as_str().unwrap())
                    && names.insert(machine["name"].as_str().unwrap().to_lowercase())
            })
    }) {
        return false;
    }
    if !draft["unfinishedMachineEditor"].is_null() {
        let Some(editor) = draft["unfinishedMachineEditor"].as_object() else {
            return false;
        };
        if !only_fields(
            editor,
            &["draft", "insertAt"],
            &["originalID", "displayAfterID"],
        ) || !valid_machine(&editor["draft"], true)
            || !editor["insertAt"].as_f64().is_some_and(|position| {
                position.fract() == 0. && (0. ..=9007199254740991.).contains(&position)
            })
            || ["originalID", "displayAfterID"]
                .iter()
                .any(|key| editor.get(*key).is_some_and(|value| !valid_uuid(value)))
        {
            return false;
        }
    }
    if draft
        .get("workspaceRepositoryAccess")
        .is_some_and(|access| {
            !access.as_object().is_some_and(|workspaces| {
                workspaces.values().all(|value| {
                    value.as_object().is_some_and(|policy| {
                        only_fields(
                            policy,
                            &["repositoryMode", "allRepositoriesAllowChanges"],
                            &[],
                        ) && matches!(policy["repositoryMode"].as_str(), Some("selected" | "all"))
                            && policy["allRepositoriesAllowChanges"].is_boolean()
                    })
                })
            })
        })
    {
        return false;
    }
    let Some(selections) = draft["workspaceSelections"].as_object() else {
        return false;
    };
    let Some(identities) = draft["workspaceIdentities"].as_object() else {
        return false;
    };
    selections.values().all(|value| {
        value.as_array().is_some_and(|repositories| {
            repositories.iter().all(|value| {
                value.as_object().is_some_and(|repository| {
                    only_fields(repository, &["repository", "allowPushes"], &[])
                        && repository["repository"].is_string()
                        && repository["allowPushes"].is_boolean()
                })
            })
        })
    }) && identities.values().all(|value| {
        value.as_object().is_some_and(|identity| {
            only_fields(identity, &["name", "email", "apply"], &[])
                && identity["name"].is_string()
                && identity["email"].is_string()
                && identity["apply"].is_boolean()
        })
    })
}

struct InitializedSettings {
    store: SettingsStore,
}

#[derive(Default)]
struct SettingsState {
    store: Mutex<Option<InitializedSettings>>,
    ready: Condvar,
}

impl SettingsState {
    fn initialize(
        &self,
        path: impl FnOnce() -> Result<Option<PathBuf>, String>,
    ) -> Result<Snapshot, String> {
        let mut initialized = self.store.lock().map_err(|_| "Settings are unavailable")?;
        if let Some(current) = initialized.as_ref() {
            return Ok(current.store.snapshot());
        }
        let store = match path() {
            Ok(path) => SettingsStore::load(path),
            Err(error) => {
                let mut store = SettingsStore::load(None);
                store.protect(&format!("The settings directory is unavailable: {error}"));
                store
            }
        };
        let snapshot = store.snapshot();
        *initialized = Some(InitializedSettings { store });
        self.ready.notify_all();
        Ok(snapshot)
    }

    fn initialized(&self) -> Result<MutexGuard<'_, Option<InitializedSettings>>, String> {
        let guard = self.store.lock().map_err(|_| "Settings are unavailable")?;
        // This is called only from blocking workers. Waiting releases the mutex so
        // the main window can initialize persistent settings first.
        let (guard, _) = self
            .ready
            .wait_timeout_while(guard, Duration::from_secs(10), |value| value.is_none())
            .map_err(|_| "Settings are unavailable")?;
        if guard.is_none() {
            return Err("Settings have not been initialized by the main window".into());
        }
        Ok(guard)
    }
}

#[derive(Default)]
struct ShutdownState(AtomicU8);

impl ShutdownState {
    const REQUESTED: u8 = 1;
    const APPROVED: u8 = 2;
    const FINISHING: u8 = 3;
    const FLUSHING: u8 = 4;

    fn request(&self) -> bool {
        self.0
            .compare_exchange(0, Self::REQUESTED, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    fn begin_flush(&self) -> bool {
        self.0
            .compare_exchange(
                Self::REQUESTED,
                Self::FLUSHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    fn claim_exit(&self, frontend_completed: bool) -> bool {
        let expected = if frontend_completed {
            Self::FLUSHING
        } else {
            Self::REQUESTED
        };
        self.0
            .compare_exchange(
                expected,
                Self::FINISHING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    fn approved(&self) -> bool {
        self.0.load(Ordering::SeqCst) == Self::APPROVED
    }

    fn allow_exit(&self) {
        self.0.store(Self::APPROVED, Ordering::SeqCst);
    }
}

fn settings_path(app: &AppHandle) -> tauri::Result<Option<PathBuf>> {
    Ok(Some(app.path().app_config_dir()?.join("settings.json")))
}

pub fn install(app: &AppHandle) {
    app.manage(SettingsState::default());
    app.manage(ShutdownState::default());
}

/// Read validated, persisted preferences from a blocking native worker.
pub(crate) fn current_settings(app: &AppHandle) -> Result<Map<String, Value>, String> {
    let state = app.state::<SettingsState>();
    let snapshot = state.initialize(|| settings_path(app).map_err(|error| error.to_string()))?;
    match snapshot.save_error {
        Some(error) => Err(error),
        None => Ok(snapshot.settings),
    }
}

#[tauri::command]
pub async fn initialize_settings(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Snapshot, String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SettingsState>();
        let snapshot =
            state.initialize(|| settings_path(&app).map_err(|error| error.to_string()))?;
        publish(&app, &snapshot);
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn require_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Only the main window can change settings".into())
    }
}

fn publish(app: &AppHandle, snapshot: &Snapshot) {
    if let Some(error) = &snapshot.save_error {
        eprintln!("Silo settings: {error}");
    }
    crate::status_panel::report(app.emit_to("main", "settings:changed", snapshot));
    let mut public = snapshot.clone();
    public.onboarding_draft = Value::Null;
    crate::status_panel::report(app.emit_to("status", "settings:changed", public));
}

async fn change(
    app: AppHandle,
    operation: impl FnOnce(&mut SettingsStore) -> Result<Snapshot, String> + Send + 'static,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SettingsState>();
        let mut initialized = state.initialized()?;
        let snapshot = operation(&mut initialized.as_mut().unwrap().store)?;
        publish(&app, &snapshot);
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_settings(app: AppHandle, window: WebviewWindow) -> Result<Snapshot, String> {
    let main = window.label() == "main";
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SettingsState>();
        let mut snapshot = state.initialized()?.as_ref().unwrap().store.snapshot();
        if !main {
            snapshot.onboarding_draft = Value::Null;
        }
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    window: WebviewWindow,
    patch: Map<String, Value>,
) -> Result<Snapshot, String> {
    require_main(window.label())?;
    change(app, move |store| store.update(patch)).await
}

#[tauri::command]
pub async fn update_onboarding_draft(
    app: AppHandle,
    window: WebviewWindow,
    draft: Value,
) -> Result<Snapshot, String> {
    require_main(window.label())?;
    change(app, move |store| store.update_draft(draft)).await
}

#[tauri::command]
pub async fn import_legacy_theme(
    app: AppHandle,
    window: WebviewWindow,
    theme: String,
) -> Result<Snapshot, String> {
    require_main(window.label())?;
    change(app, move |store| {
        // Fixture modes never inherit a theme from the production webview origin.
        if store.path.is_none() {
            Ok(store.snapshot())
        } else {
            store.import_theme(theme)
        }
    })
    .await
}

#[tauri::command]
pub async fn flush_settings(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(window.label())?;
    let snapshot = change(app, |store| {
        store.snapshot.revision += 1;
        let _ = store.save();
        Ok(store.snapshot())
    })
    .await?;
    snapshot.save_error.map_or(Ok(()), Err)
}

fn finish_exit(app: &AppHandle, frontend_completed: bool) {
    if !app.state::<ShutdownState>().claim_exit(frontend_completed) {
        return;
    }
    crate::startup::cancel_and_wait(app);
    // The frontend has drained its invoke queue. Wait for any native write already in progress.
    if let Ok(mut initialized) = app.state::<SettingsState>().store.lock() {
        if let Some(current) = initialized.as_mut() {
            if let Err(error) = current.store.save() {
                eprintln!("Silo settings: {error}");
            }
        }
    }
    app.state::<ShutdownState>().allow_exit();
    app.exit(0);
}

pub fn prevent_exit_until_saved(app: &AppHandle, api: &tauri::ExitRequestApi) {
    let state = app.state::<ShutdownState>();
    if state.approved() {
        return;
    }
    api.prevent_exit();
    crate::startup::cancel(app);
    if !state.request() {
        return;
    }
    if app.get_webview_window("main").is_some() {
        crate::status_panel::report(app.emit_to("main", "settings:flush-request", ()));
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Only a webview that never acknowledges may use the fallback. A responsive
        // frontend can take as long as it needs to drain its pending changes.
        std::thread::sleep(Duration::from_secs(2));
        finish_exit(&app, false);
    });
}

#[tauri::command]
pub fn begin_settings_flush(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(window.label())?;
    if app.state::<ShutdownState>().begin_flush() {
        Ok(())
    } else {
        Err("A settings flush is not awaiting acknowledgment".into())
    }
}

#[tauri::command]
pub async fn complete_settings_flush(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || finish_exit(&app, true))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_default_modes_preserve_explicit_applications_across_restarts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let explicit = json!({
            "terminal": "Custom Terminal", "terminalPath": "/Applications/Custom Terminal.app",
            "editor": "Custom Editor", "editorPath": "/Applications/Custom Editor.app",
            "browser": "Custom Browser", "browserPath": "/Applications/Custom Browser.app"
        })
        .as_object()
        .unwrap()
        .clone();
        let mut store = SettingsStore::load(Some(path.clone()));
        store.update(explicit.clone()).unwrap();
        store = SettingsStore::load(Some(path.clone()));
        assert_eq!(store.snapshot().settings, explicit);

        for enabled in [true, false] {
            let modes = json!({
                "terminalUseSystemDefault": enabled,
                "editorUseSystemDefault": enabled,
                "browserUseSystemDefault": enabled
            })
            .as_object()
            .unwrap()
            .clone();
            assert!(store.update(modes.clone()).unwrap().save_error.is_none());
            store = SettingsStore::load(Some(path.clone()));
            let mut expected = explicit.clone();
            expected.extend(modes);
            assert_eq!(store.snapshot().settings, expected);
            assert!(store.snapshot().save_error.is_none());
        }

        let saved = fs::read(&path).unwrap();
        for key in [
            "terminalUseSystemDefault",
            "editorUseSystemDefault",
            "browserUseSystemDefault",
        ] {
            for invalid in [json!("true"), Value::Null, json!(0)] {
                let mut patch = json!({"theme": "light"}).as_object().unwrap().clone();
                patch.insert(key.into(), invalid);
                assert!(store.update(patch).is_err());
                assert_eq!(fs::read(&path).unwrap(), saved);
            }
        }
        let document: Value = serde_json::from_slice(&saved).unwrap();
        assert_eq!(document["schemaVersion"], 1);
    }

    #[test]
    fn chosen_application_label_and_location_survive_restart_together() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut store = SettingsStore::load(Some(path.clone()));
        store.update(json!({ "editor": "Custom Editor", "editorPath": "/Applications/Custom Editor.app" }).as_object().unwrap().clone()).unwrap();
        let restored = SettingsStore::load(Some(path)).snapshot();
        assert_eq!(
            restored.settings.get("editor"),
            Some(&json!("Custom Editor"))
        );
        assert_eq!(
            restored.settings.get("editorPath"),
            Some(&json!("/Applications/Custom Editor.app"))
        );
        assert_eq!(
            valid_setting("editorPath", &json!("relative.app")),
            Some(false)
        );
        assert_eq!(valid_setting("editorPath", &Value::Null), Some(true));
    }
    #[test]
    fn settings_survive_restart_including_false_and_empty_selections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let patch = json!({
            "theme": "light", "launchAtLogin": false,
            "startWorkspacesAtLaunch": false, "startupWorkspaceIds": [],
            "terminal": "iTerm", "editor": "Cursor", "browser": "Firefox",
            "reduceMotion": true, "notificationsEnabled": false,
            "notifyHealth": true, "notifyActions": false, "notifyBackup": true
        });
        let mut store = SettingsStore::load(Some(path.clone()));
        assert!(store
            .update(patch.as_object().unwrap().clone())
            .unwrap()
            .save_error
            .is_none());
        assert_eq!(
            SettingsStore::load(Some(path)).snapshot().settings,
            patch.as_object().unwrap().clone()
        );
    }

    #[test]
    fn independent_changes_preserve_unknown_saved_fields() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schemaVersion": 1, "futureDocumentField": {"keep": true},
                "settings": {"theme": "dark", "launchAtLogin": false, "futurePreference": 42},
                "onboardingDraft": null
            }))
            .unwrap(),
        )
        .unwrap();
        let mut store = SettingsStore::load(Some(path.clone()));
        store
            .update(json!({"editor": "Cursor"}).as_object().unwrap().clone())
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["settings"]["theme"], "dark");
        assert_eq!(saved["settings"]["launchAtLogin"], false);
        assert_eq!(saved["settings"]["futurePreference"], 42);
        assert_eq!(saved["futureDocumentField"]["keep"], true);
    }

    #[test]
    fn corrupt_and_newer_documents_are_never_overwritten() {
        for bytes in [
            b"{broken".as_slice(),
            br#"{"schemaVersion":2,"settings":{"theme":"dark"}}"#,
            br#"{"schemaVersion":1,"settings":{"theme":"dark","reduceMotion":"yes"}}"#,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("settings.json");
            std::fs::write(&path, bytes).unwrap();
            let mut store = SettingsStore::load(Some(path.clone()));
            assert!(store.snapshot().save_error.is_some());
            let snapshot = store
                .update(json!({"editor":"Cursor"}).as_object().unwrap().clone())
                .unwrap();
            assert_eq!(snapshot.settings["editor"], "Cursor");
            assert!(snapshot.save_error.is_some());
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn legacy_theme_fills_only_a_missing_value_and_does_not_seed_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut store = SettingsStore::load(Some(path.clone()));
        assert!(store.snapshot().settings.is_empty());
        assert!(!path.exists());
        assert!(store.import_theme("sepia".into()).is_err());
        assert!(!path.exists());
        store.import_theme("light".into()).unwrap();
        store.import_theme("dark".into()).unwrap();
        assert_eq!(
            SettingsStore::load(Some(path)).snapshot().settings,
            json!({"theme":"light"}).as_object().unwrap().clone()
        );
    }

    #[test]
    fn rejected_patch_does_not_partially_change_other_settings() {
        let mut store = SettingsStore::load(None);
        for patch in [
            json!({"theme":"light", "reduceMotion":"yes"}),
            json!({"theme":"light", "credentials":"secret"}),
            json!({"terminal":""}),
            json!({"startupWorkspaceIds":[""]}),
        ] {
            assert!(store.update(patch.as_object().unwrap().clone()).is_err());
            assert_eq!(store.snapshot().revision, 0);
            assert!(store.snapshot().settings.is_empty());
        }
        assert!(require_main("main").is_ok());
        assert!(require_main("status").is_err());
    }

    fn unfinished_draft() -> Value {
        json!({
            "currentStep":"workspaces", "machines": [{
                "id":"95168b7e-aa9f-4dc1-a5de-2865c1b0bb64", "kind":"ssh", "name":"dev",
                "host":"server.local", "user":"dev", "port":22
            }], "unfinishedMachineEditor": {
                "draft": {"id":"025da8eb-56bf-4519-85cb-3316b2feb549", "kind":"ssh", "name":"",
                    "host":"", "user":"", "port":0}, "insertAt":1
            }, "workspaceSelections":{"dev":[{"repository":"owner/repo", "allowPushes":false}]},
            "workspaceIdentities":{"dev":{"name":"", "email":"unfinished@", "apply":false}}
        })
    }

    #[test]
    fn all_repository_intent_survives_restart_and_rejects_malformed_access() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut store = SettingsStore::load(Some(path.clone()));
        let mut draft = unfinished_draft();
        draft["workspaceRepositoryAccess"] =
            json!({"dev":{"repositoryMode":"all","allRepositoriesAllowChanges":false}});
        store.update_draft(draft.clone()).unwrap();
        assert_eq!(
            SettingsStore::load(Some(path)).snapshot().onboarding_draft,
            draft.clone()
        );
        for invalid in [
            json!(null),
            json!({"dev":{"repositoryMode":"unknown","allRepositoriesAllowChanges":false}}),
            json!({"dev":{"repositoryMode":"all","allRepositoriesAllowChanges":"yes"}}),
            json!({"dev":{"repositoryMode":"all","allRepositoriesAllowChanges":false,"token":"secret"}}),
        ] {
            draft["workspaceRepositoryAccess"] = invalid;
            assert!(!valid_draft(&draft));
        }
    }

    #[test]
    fn unfinished_onboarding_survives_restart_and_clearing_preserves_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut store = SettingsStore::load(Some(path.clone()));
        store.import_theme("dark".into()).unwrap();
        store.update_draft(unfinished_draft()).unwrap();
        let mut restarted = SettingsStore::load(Some(path.clone()));
        assert_eq!(restarted.snapshot().onboarding_draft, unfinished_draft());
        assert!(restarted.snapshot().save_error.is_none());
        restarted.update_draft(Value::Null).unwrap();
        let snapshot = SettingsStore::load(Some(path)).snapshot();
        assert!(snapshot.onboarding_draft.is_null());
        assert_eq!(snapshot.settings["theme"], "dark");
    }

    #[test]
    fn drafts_reject_credentials_and_runtime_results() {
        let mut store = SettingsStore::load(None);
        for field in ["credentials", "connection", "progress", "completed"] {
            let mut draft = unfinished_draft();
            draft[field] = json!("do not persist");
            assert!(store.update_draft(draft).is_err());
        }
        let mut draft = unfinished_draft();
        draft["unfinishedMachineEditor"]["draft"]["password"] = json!("secret");
        assert!(store.update_draft(draft).is_err());
        assert!(store.snapshot().onboarding_draft.is_null());
    }

    #[test]
    fn independent_concurrent_patches_do_not_lose_other_fields() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = std::sync::Arc::new(Mutex::new(SettingsStore::load(Some(path.clone()))));
        let threads: Vec<_> = [
            json!({"theme":"dark"}),
            json!({"editor":"Cursor"}),
            json!({"startupWorkspaceIds":[]}),
        ]
        .into_iter()
        .map(|patch| {
            let store = store.clone();
            std::thread::spawn(move || {
                store
                    .lock()
                    .unwrap()
                    .update(patch.as_object().unwrap().clone())
                    .unwrap()
            })
        })
        .collect();
        let mut revisions: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap().revision)
            .collect();
        revisions.sort();
        assert_eq!(revisions, [1, 2, 3]);
        assert_eq!(
            SettingsStore::load(Some(path)).snapshot().settings,
            json!({"theme":"dark","editor":"Cursor","startupWorkspaceIds":[]})
                .as_object()
                .unwrap()
                .clone()
        );
    }

    #[test]
    fn failed_write_keeps_old_file_and_retries_session_choices() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut store = SettingsStore::load(Some(path.clone()));
        store.import_theme("dark".into()).unwrap();
        let saved = fs::read(&path).unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o500)).unwrap();
        let result = store
            .update(json!({"editor":"Cursor"}).as_object().unwrap().clone())
            .unwrap();
        // Restore permissions before asserting, so a failed assertion cannot strand the fixture.
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.save_error.is_some());
        assert_eq!(result.settings["editor"], "Cursor");
        assert_eq!(fs::read(&path).unwrap(), saved);
        let snapshot = store
            .update(json!({"browser":"Firefox"}).as_object().unwrap().clone())
            .unwrap();
        assert!(snapshot.save_error.is_none());
        assert_eq!(
            SettingsStore::load(Some(path)).snapshot().settings["editor"],
            "Cursor"
        );
    }

    #[test]
    fn incomplete_temporary_file_does_not_replace_the_last_commit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut store = SettingsStore::load(Some(path.clone()));
        store.import_theme("light".into()).unwrap();
        let mut interrupted = tempfile::NamedTempFile::new_in(directory.path()).unwrap();
        interrupted
            .write_all(br#"{"schemaVersion":1,"settings":{"theme":"da"#)
            .unwrap();
        interrupted.as_file().sync_all().unwrap();
        assert_eq!(
            SettingsStore::load(Some(path)).snapshot().settings["theme"],
            "light"
        );
    }

    #[test]
    fn memory_fixture_has_no_saved_state_to_reload() {
        let mut fixture = SettingsStore::load(None);
        fixture.import_theme("light".into()).unwrap();
        fixture.update_draft(unfinished_draft()).unwrap();
        assert_eq!(fixture.snapshot().settings["theme"], "light");
        assert!(SettingsStore::load(None).snapshot().settings.is_empty());
        assert!(SettingsStore::load(None)
            .snapshot()
            .onboarding_draft
            .is_null());
    }

    #[test]
    fn invalid_saved_machine_semantics_protect_the_entire_original_file() {
        let mut candidates = Vec::new();
        let mut empty = unfinished_draft();
        empty["machines"] = json!([]);
        candidates.push(empty);
        for (field, invalid) in [
            ("id", json!("not-a-uuid")),
            ("name", json!("Invalid name")),
            ("host", json!("")),
            ("user", json!("root user")),
            ("port", json!(0)),
        ] {
            let mut draft = unfinished_draft();
            draft["machines"][0][field] = invalid;
            candidates.push(draft);
        }
        let mut duplicate = unfinished_draft();
        let machine = duplicate["machines"][0].clone();
        duplicate["machines"].as_array_mut().unwrap().push(machine);
        candidates.push(duplicate);
        for draft in candidates {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("settings.json");
            let original = serde_json::to_vec(
                &json!({"schemaVersion":1,"settings":{"theme":"dark"},"onboardingDraft":draft}),
            )
            .unwrap();
            fs::write(&path, &original).unwrap();
            let mut store = SettingsStore::load(Some(path.clone()));
            assert!(store.snapshot().save_error.is_some());
            assert_eq!(store.snapshot().settings["theme"], "dark");
            store.update_draft(unfinished_draft()).unwrap();
            store
                .update(json!({"editor":"Cursor"}).as_object().unwrap().clone())
                .unwrap();
            assert_eq!(fs::read(path).unwrap(), original);
        }
    }

    #[test]
    fn unfinished_vm_resources_can_exceed_ceiling_but_must_use_existing_choices() {
        let mut draft = unfinished_draft();
        let vm = json!({
            "id":"025da8eb-56bf-4519-85cb-3316b2feb549", "kind":"vm", "name":"unfinished name",
            "cpus":12,"maxCPUs":4,"memoryGiB":48,"maxMemoryGiB":16,
            "workspaceStorageGiB":60,"runtimeStorageGiB":80
        });
        draft["unfinishedMachineEditor"]["draft"] = vm.clone();
        assert!(valid_draft(&draft));
        draft["unfinishedMachineEditor"]["draft"]["cpus"] = json!(3);
        assert!(!valid_draft(&draft));
        let mut saved = vm;
        saved["name"] = json!("dev");
        assert!(!valid_machine(&saved, false));
        saved["maxCPUs"] = json!(12);
        saved["maxMemoryGiB"] = json!(48);
        assert!(valid_machine(&saved, false));
    }

    #[test]
    fn startup_id_limit_matches_the_typescript_boundary() {
        let ids = vec![json!("temporarily-unavailable-id"); 256];
        assert_eq!(
            valid_setting("startupWorkspaceIds", &json!(ids)),
            Some(true)
        );
        assert_eq!(
            valid_setting("startupWorkspaceIds", &json!(vec!["id"; 257])),
            Some(false)
        );
    }

    #[test]
    fn initialization_resolves_storage_once_and_reuses_loaded_state() {
        let state = SettingsState::default();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let snapshot = state.initialize(|| Ok(Some(path))).unwrap();
        assert!(snapshot.settings.is_empty());
        state
            .initialized()
            .unwrap()
            .as_mut()
            .unwrap()
            .store
            .import_theme("light".into())
            .unwrap();
        assert_eq!(
            state
                .initialize(|| panic!("reinitialization must not reread storage"))
                .unwrap()
                .settings["theme"],
            "light"
        );
    }

    #[test]
    fn status_reads_wait_for_main_initialization_without_holding_its_lock() {
        let state = std::sync::Arc::new(SettingsState::default());
        let reader_state = state.clone();
        let (started, ready) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            started.send(()).unwrap();
            reader_state
                .initialized()
                .unwrap()
                .as_ref()
                .unwrap()
                .store
                .snapshot()
        });
        ready.recv().unwrap();
        state.initialize(|| Ok(None)).unwrap();
        assert!(reader.join().unwrap().settings.is_empty());
    }

    #[test]
    fn quit_timeout_cannot_cut_off_an_acknowledged_flush() {
        let state = ShutdownState::default();
        assert!(state.request());
        assert!(state.begin_flush());
        assert!(!state.claim_exit(false));
        assert!(!state.request());
        assert!(!state.approved());
        assert!(state.claim_exit(true));
        assert!(!state.approved());
        state.allow_exit();
        assert!(state.approved());
        assert!(!state.claim_exit(true));
    }

    #[test]
    fn quit_timeout_can_finish_when_the_frontend_never_acknowledges() {
        let state = ShutdownState::default();
        assert!(state.request());
        assert!(state.claim_exit(false));
        assert!(!state.begin_flush());
        assert!(!state.claim_exit(true));
        state.allow_exit();
        assert!(state.approved());
    }
}
