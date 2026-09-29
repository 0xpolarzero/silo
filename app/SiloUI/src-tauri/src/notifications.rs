//! One router for everything Silo tells the user outside a direct UI response.
//!
//! Ownership (who produces a notice for what):
//! - The frontend toast layer owns results of commands it awaited (push, GitHub apply,
//!   ports, checkpoints, storage reclaim, log export). It mirrors failures and long
//!   successes to the system through `deliver_notice`; it already shows its own toast.
//! - The backend owns background work and lifecycle results (sandbox start/stop/restart,
//!   export/import, sandbox setup, startup, updates) through `notify_native`: the
//!   frontend shows toasts for those from backend state.
//! - The backend owns events nobody asked for (unexpected sandbox changes, startup
//!   failures without a UI owner) through `notify`: an in-app toast plus a system notice.
//!
//! Policy lives here: category preferences, OS authorization, and focus. A system
//! notification is never shown while the main window is focused; the in-app toast
//! already covers it.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};

/// In-app toast event for backend-originated notices. Payload: `Notice`.
pub(crate) const NOTICE_EVENT: &str = "silo://notice";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Category {
    /// Something the user started, or background work, failed.
    Failures,
    /// A sandbox changed state without a Silo operation causing it.
    Changes,
    /// Work that ran for at least `LONG_OPERATION` finished successfully.
    Completions,
}

/// A successful operation this long or longer is worth a completion notice. Matches the
/// frontend `LONG_OPERATION_MS`.
pub(crate) const LONG_OPERATION: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoticeSandbox {
    /// Stable VM id (local or remote). Groups notices and clears them on deletion.
    pub id: String,
    /// Display name, shown in text and used to open the sandbox on click.
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    pub category: Category,
    /// Stable identity. A newer notice with the same key replaces the older one, both
    /// as a system notification and as an in-app toast.
    pub key: String,
    pub title: String,
    pub body: String,
    pub sandbox: Option<NoticeSandbox>,
}

fn flag(settings: &Map<String, Value>, key: &str, legacy: &[&str]) -> bool {
    // New keys win; before they are saved, the legacy per-area switches decide.
    if let Some(value) = settings.get(key).and_then(Value::as_bool) {
        return value;
    }
    legacy
        .iter()
        .all(|key| settings.get(*key).and_then(Value::as_bool).unwrap_or(true))
}

pub(crate) fn enabled(settings: &Map<String, Value>, category: Category) -> bool {
    // Match the persisted settings defaults. OS authorization is checked separately.
    flag(settings, "notificationsEnabled", &[])
        && match category {
            Category::Failures => flag(settings, "notifyFailures", &["notifyActions", "notifyBackup"]),
            Category::Changes => flag(settings, "notifyChanges", &["notifyHealth"]),
            Category::Completions => flag(settings, "notifyCompletions", &[]),
        }
}

pub(crate) fn install(app: &AppHandle) {
    crate::system_integrations::install_notifications();
    crate::health_watch::install(app);
}

/// A notice with no other UI owner: in-app toast and, when unfocused, a system notification.
pub(crate) fn notify(app: &AppHandle, notice: Notice) {
    let _ = app.emit(NOTICE_EVENT, &notice);
    notify_native(app, notice);
}

/// A system notification only, for notices whose toast another owner already shows.
/// Delivery runs off the calling thread and never changes the caller's result.
pub(crate) fn notify_native(app: &AppHandle, notice: Notice) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || deliver(&app, &notice));
}

/// Remove delivered system notifications about one sandbox (for example, after deletion).
pub(crate) fn clear_sandbox(_app: &AppHandle, _sandbox_id: &str) {}

fn main_window_focused(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })
}

fn deliver(app: &AppHandle, notice: &Notice) {
    if main_window_focused(app) {
        return;
    }
    let Ok(settings) = crate::settings::current_settings(app) else {
        return;
    };
    if !enabled(&settings, notice.category) {
        return;
    }
    // A delivery failure must not change the result of the sandbox/backup operation.
    if crate::system_integrations::deliver_notification(&notice.title, &notice.body).is_err() {
        eprintln!("Silo could not deliver a system notification.");
    }
}

/// Frontend mirror of a toast it already shows. System notification only.
#[tauri::command]
pub(crate) fn deliver_notice(app: AppHandle, notice: Notice) {
    notify_native(&app, notice);
}

#[tauri::command]
pub(crate) fn clear_sandbox_notices(app: AppHandle, sandbox_id: String) {
    clear_sandbox(&app, &sandbox_id);
}

// Legacy entry points, replaced by `Notice`s with sandbox names at each call site.
pub(crate) fn action_failed(app: &AppHandle, title: &'static str) {
    notify_native(
        app,
        Notice {
            category: Category::Failures,
            key: title.into(),
            title: title.into(),
            body: "The operation did not complete. Open Silo to review the error and retry.".into(),
            sandbox: None,
        },
    );
}

fn backup_title(operation: &str, outcome: &str) -> Option<&'static str> {
    match (operation, outcome) {
        ("backup", "failed") => Some("Export failed"),
        ("backup", "restart-required") => Some("Export complete; sandbox restart failed"),
        ("restore", "failed") => Some("Import failed"),
        _ => None,
    }
}

pub(crate) fn backup_result(app: &AppHandle, operation: &str, outcome: &str) {
    let Some(title) = backup_title(operation, outcome) else {
        return;
    };
    notify_native(
        app,
        Notice {
            category: Category::Failures,
            key: format!("transfer:{operation}"),
            title: title.into(),
            body: "Open Silo to review the result.".into(),
            sandbox: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn settings(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }
    const ALL: [Category; 3] = [Category::Failures, Category::Changes, Category::Completions];
    #[test]
    fn master_and_each_category_preference_gate_delivery() {
        for category in ALL {
            assert!(enabled(&settings(json!({})), category));
            assert!(!enabled(&settings(json!({"notificationsEnabled": false})), category));
        }
        let preferences = settings(
            json!({"notifyFailures": false, "notifyChanges": false, "notifyCompletions": false}),
        );
        for category in ALL {
            assert!(!enabled(&preferences, category));
        }
        assert!(enabled(&settings(json!({"notifyChanges": false})), Category::Failures));
    }
    #[test]
    fn legacy_switches_apply_until_new_keys_are_saved() {
        assert!(!enabled(&settings(json!({"notifyHealth": false})), Category::Changes));
        assert!(!enabled(&settings(json!({"notifyBackup": false})), Category::Failures));
        assert!(enabled(
            &settings(json!({"notifyBackup": false, "notifyFailures": true})),
            Category::Failures
        ));
    }
    #[test]
    fn notice_wire_shape_is_camel_case() {
        let notice = Notice {
            category: Category::Completions,
            key: "vm:1:lifecycle".into(),
            title: "dev is running".into(),
            body: "".into(),
            sandbox: Some(NoticeSandbox { id: "1".into(), name: "dev".into() }),
        };
        assert_eq!(
            serde_json::to_value(&notice).unwrap(),
            json!({"category": "completions", "key": "vm:1:lifecycle", "title": "dev is running", "body": "", "sandbox": {"id": "1", "name": "dev"}})
        );
    }
    #[test]
    fn backup_failures_and_partial_restart_failures_alert_but_cancel_does_not() {
        assert_eq!(backup_title("backup", "failed"), Some("Export failed"));
        assert_eq!(backup_title("restore", "failed"), Some("Import failed"));
        assert!(backup_title("backup", "restart-required").is_some());
        for operation in ["backup", "restore"] {
            for outcome in ["success", "cancelled", "running"] {
                assert!(backup_title(operation, outcome).is_none());
            }
        }
    }
}
