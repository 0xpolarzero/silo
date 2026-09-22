use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct StartupState {
    cancelled: AtomicBool,
    active: Mutex<()>,
}

fn selected_sandboxes(settings: &Map<String, Value>) -> Vec<String> {
    if settings.get("onboardingComplete").and_then(Value::as_bool) != Some(true)
        || settings
            .get("startWorkspacesAtLaunch")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    settings
        .get("startupWorkspaceIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty() && seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect()
}

fn preserve_recovered_stops(settings: &mut Map<String, Value>, stopped: &HashSet<String>) {
    if let Some(ids) = settings.get_mut("startupWorkspaceIds").and_then(Value::as_array_mut) {
        ids.retain(|id| !id.as_str().is_some_and(|id| stopped.contains(id)));
    }
}

fn settings_for_launch(
    mut settings: Map<String, Value>,
    metadata: &Path,
    stopped: &HashSet<String>,
) -> Result<Map<String, Value>, String> {
    // Older switches saved only the opt-in, leaving the displayed default
    // selection absent on disk. Match that default without overriding an
    // explicit selection (including []) or inferring a remote launch target.
    if settings.get("onboardingComplete").and_then(Value::as_bool) == Some(true)
        && settings.get("startWorkspacesAtLaunch").and_then(Value::as_bool) == Some(true)
        && !settings.contains_key("startupWorkspaceIds")
    {
        let configuration = crate::runtime::read_metadata(metadata).map_err(|error| error.to_string())?;
        let mut local = configuration.machines.iter().filter(|machine| machine.is_vm());
        let initial = local.clone().find(|machine| machine.name() == "dev").or_else(|| local.next());
        settings.insert("startupWorkspaceIds".into(), serde_json::json!(initial.map(|machine| machine.id()).into_iter().collect::<Vec<_>>()));
    }
    preserve_recovered_stops(&mut settings, stopped);
    Ok(settings)
}

fn start_selected(
    settings: &Map<String, Value>,
    cancelled: &AtomicBool,
    mut start: impl FnMut(&str) -> Result<(), String>,
) -> Vec<String> {
    let mut failures = Vec::new();
    for id in selected_sandboxes(settings) {
        if cancelled.load(Ordering::SeqCst) {
            break;
        }
        if let Err(error) = start(&id) {
            failures.push(error);
        }
    }
    failures
}

// Called once by native app setup, never by a webview mount, refresh or reopen.
pub(crate) fn install(app: &AppHandle) {
    app.manage(StartupState::default());
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StartupState>();
        let Ok(_active) = state.active.lock() else {
            return;
        };
        if let Err(message) = crate::backup_controller::wait_for_recovery(&app) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::system_integrations::show_integration_error(app.clone(), window, message);
            }
            return;
        }
        if state.cancelled.load(Ordering::SeqCst) { return; }
        if let Err(message) = crate::runtime::configuration_recovery::recover(&app) {
            crate::notifications::action_failed(&app, "Sandbox setup could not resume");
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::system_integrations::show_integration_error(app.clone(), window,
                    format!("{message}\n\nSaved setup progress was preserved. Relaunch Silo to retry."));
            }
            return;
        }
        let recovered_stops = match crate::runtime::lifecycle_recovery::recover(&app) {
            Ok(stopped) => stopped,
            Err(message) => {
                crate::notifications::action_failed(&app, "Sandbox actions could not resume");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = crate::system_integrations::show_integration_error(app.clone(), window, message);
                }
                return;
            }
        };
        match crate::runtime::update_recovery::recover(&app) {
            Ok(true) => return, // Preserve the exact pre-update running set, even if empty.
            Ok(false) => (),
            Err(message) => { crate::updates::recovery_failed(&app, message); return; }
        }
        let result = crate::settings::current_settings(&app).and_then(|settings| {
            let paths = crate::runtime::runtime_paths(&app)?;
            let settings = settings_for_launch(settings, &paths.metadata, &recovered_stops)?;
            Ok(start_selected(&settings, &state.cancelled, |id| {
                let result = crate::runtime::start_at_launch(&app, id);
                let _ = app.emit("silo://application-state-changed", ());
                result
            }))
        });
        let failures = result.unwrap_or_else(|error| vec![error]);
        if !failures.is_empty() && !state.cancelled.load(Ordering::SeqCst) {
            crate::notifications::action_failed(&app, "Sandbox startup failed");
            if let Some(window) = app.get_webview_window("main") {
                let message = format!("Some sandboxes could not start automatically:\n\n{}\n\nOther selected sandboxes may have started. Check their status and use Start to retry. Update the startup selection in Settings if needed.", failures.join("\n"));
                let _ = crate::system_integrations::show_integration_error(
                    app.clone(),
                    window,
                    message,
                );
            }
        }
    });
}

pub(crate) fn is_cancelled(app: &AppHandle) -> bool {
    app.try_state::<StartupState>()
        .is_some_and(|state| state.cancelled.load(Ordering::SeqCst))
}

pub(crate) fn cancel(app: &AppHandle) {
    if let Some(state) = app.try_state::<StartupState>() {
        state.cancelled.store(true, Ordering::SeqCst);
    }
}

pub(crate) fn cancel_and_wait(app: &AppHandle) {
    if let Some(state) = app.try_state::<StartupState>() {
        state.cancelled.store(true, Ordering::SeqCst);
        // Finish the current bounded start; do not launch the remaining selections.
        drop(state.active.lock());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vm(id: &str, name: &str) -> Value {
        json!({"kind":"vm", "id":id, "name":name, "cpus":2, "maxCPUs":2,
            "memoryGiB":2, "maxMemoryGiB":2, "workspaceStorageGiB":10, "runtimeStorageGiB":10})
    }

    #[test]
    fn enabled_startup_without_saved_ids_starts_the_displayed_default() {
        let directory = tempfile::tempdir().unwrap();
        let metadata = directory.path().join("machines.json");
        let id = "00000000-0000-4000-8000-000000000001";
        std::fs::write(&metadata, json!({"schemaVersion":1,"machines":[vm(id, "dev")]}).to_string()).unwrap();
        // This is the saved state produced by accepting the UI's default chip.
        let settings = json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true});
        let resolved = settings_for_launch(settings.as_object().unwrap().clone(), &metadata, &HashSet::new()).unwrap();
        let mut started = Vec::new();
        let failures = start_selected(&resolved, &AtomicBool::new(false), |id| {
            started.push(id.to_owned());
            Ok(())
        });
        assert!(failures.is_empty());
        assert_eq!(started, vec![id]);
    }

    #[test]
    fn missing_selection_prefers_dev_then_first_local_vm_and_preserves_recovered_stops() {
        let directory = tempfile::tempdir().unwrap();
        let metadata = directory.path().join("machines.json");
        let first = "00000000-0000-4000-8000-000000000001";
        let dev = "00000000-0000-4000-8000-000000000002";
        let remote = json!({"kind":"ssh", "id":"00000000-0000-4000-8000-000000000003", "name":"remote", "host":"example.test", "user":"owner", "port":22});
        let settings = json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true});
        for (machines, expected) in [
            (vec![remote.clone(), vm(first, "alpha"), vm(dev, "dev")], vec![dev]),
            (vec![remote.clone(), vm(first, "alpha")], vec![first]),
            (vec![remote], vec![]),
            (vec![], vec![]),
        ] {
            std::fs::write(&metadata, json!({"schemaVersion":1,"machines":machines}).to_string()).unwrap();
            let resolved = settings_for_launch(settings.as_object().unwrap().clone(), &metadata, &HashSet::new()).unwrap();
            assert_eq!(selected_sandboxes(&resolved), expected);
            let stopped = expected.iter().map(|id| (*id).to_owned()).collect();
            let resolved = settings_for_launch(settings.as_object().unwrap().clone(), &metadata, &stopped).unwrap();
            assert!(selected_sandboxes(&resolved).is_empty());
        }
    }

    #[test]
    fn explicit_selections_and_disabled_startup_do_not_read_default_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let metadata = directory.path().join("machines.json");
        std::fs::write(&metadata, "invalid configuration").unwrap();
        for settings in [
            json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":[]}),
            json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":["selected"]}),
            json!({"onboardingComplete":true,"startWorkspacesAtLaunch":false}),
            json!({"onboardingComplete":false,"startWorkspacesAtLaunch":true}),
            json!({}),
        ] {
            let settings = settings.as_object().unwrap().clone();
            let resolved = settings_for_launch(settings.clone(), &metadata, &HashSet::new()).unwrap();
            assert_eq!(resolved, settings);
        }
        let enabled = json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true});
        assert!(settings_for_launch(enabled.as_object().unwrap().clone(), &metadata, &HashSet::new()).unwrap_err().contains("configuration is invalid"));
    }

    #[test]
    fn recovered_explicit_stops_are_not_undone_by_launch_preferences() {
        let mut settings = serde_json::json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":["stopped","other"]}).as_object().unwrap().clone();
        preserve_recovered_stops(&mut settings, &HashSet::from(["stopped".into()]));
        assert_eq!(selected_sandboxes(&settings), vec!["other"]);
    }

    #[test]
    fn startup_requires_completed_onboarding_and_explicit_opt_in() {
        for settings in [
            json!({}),
            json!({"onboardingComplete":false,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":["dev"]}),
            json!({"onboardingComplete":true,"startWorkspacesAtLaunch":false,"startupWorkspaceIds":["dev"]}),
        ] {
            assert!(selected_sandboxes(settings.as_object().unwrap()).is_empty());
        }
    }

    #[test]
    fn startup_uses_only_selected_ids_once_in_saved_order() {
        let settings = json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":["second","first","second"]});
        assert_eq!(
            selected_sandboxes(settings.as_object().unwrap()),
            vec!["second", "first"]
        );
        let empty = json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":[]});
        assert!(selected_sandboxes(empty.as_object().unwrap()).is_empty());
    }
    #[test]
    fn failed_start_does_not_block_other_selections_and_quit_stops_remaining() {
        let settings = json!({"onboardingComplete":true,"startWorkspacesAtLaunch":true,"startupWorkspaceIds":["first","second","third"]});
        let cancelled = AtomicBool::new(false);
        let mut calls = Vec::new();
        let failures = start_selected(settings.as_object().unwrap(), &cancelled, |id| {
            calls.push(id.to_owned());
            if id == "first" {
                Err("First failed".into())
            } else {
                cancelled.store(true, Ordering::SeqCst);
                Ok(())
            }
        });
        assert_eq!(calls, vec!["first", "second"]);
        assert_eq!(failures, vec!["First failed"]);
    }
}
