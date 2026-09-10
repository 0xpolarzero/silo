use serde_json::{Map, Value};
use std::{
    collections::HashSet,
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
        if let Err(message) = crate::runtime::configuration_recovery::recover(&app) {
            crate::notifications::action_failed(&app, "Sandbox setup could not resume");
            if let Some(window) = app.get_webview_window("main") {
                let _ = crate::system_integrations::show_integration_error(app.clone(), window,
                    format!("{message}\n\nSaved setup progress was preserved. Relaunch Silo to retry."));
            }
            return;
        }
        let result = crate::settings::current_settings(&app).map(|settings| {
            start_selected(&settings, &state.cancelled, |id| {
                let result = crate::runtime::start_at_launch(&app, id);
                let _ = app.emit("silo://application-state-changed", ());
                result
            })
        });
        let failures = result.unwrap_or_else(|_| vec!["Saved startup preferences could not be read. No automatic starts were requested. Check Settings.".into()]);
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
