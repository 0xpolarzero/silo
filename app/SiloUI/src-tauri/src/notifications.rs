//! Notifications follow real operation results and health transitions, never UI refreshes.
use std::collections::HashMap;
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::AppHandle;

#[derive(Clone, Copy, Debug)]
pub(crate) enum Category {
    Health,
    Actions,
    Backup,
}

fn enabled(settings: &Map<String, Value>, category: Category) -> bool {
    // Match the persisted settings defaults. OS authorization is checked separately.
    let flag = |key| settings.get(key).and_then(Value::as_bool).unwrap_or(true);
    flag("notificationsEnabled")
        && flag(match category {
            Category::Health => "notifyHealth",
            Category::Actions => "notifyActions",
            Category::Backup => "notifyBackup",
        })
}

// The first observation establishes a baseline. Disabled notifications still advance it,
// so enabling notifications never replays historical problems.
pub(crate) type HealthObservations = HashMap<String, (String, &'static str)>;
#[derive(Default)]
struct HealthState {
    previous: Option<HealthObservations>,
}
impl HealthState {
    fn observe(&mut self, observations: HealthObservations) -> Vec<String> {
        let mut changes = Vec::new();
        if let Some(previous) = &self.previous {
            for (id, (name, state)) in &observations {
                if previous.get(id).is_some_and(|(_, old)| old != state) {
                    changes.push(format!("{name}: {state}"));
                }
            }
        }
        changes.sort();
        self.previous = Some(observations);
        changes
    }
}

fn health_message(changes: &[String]) -> String {
    let mut message = changes
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(". ");
    if changes.len() > 3 {
        message.push_str(&format!(
            ". {} more {}",
            changes.len() - 3,
            if changes.len() == 4 {
                "change"
            } else {
                "changes"
            }
        ));
    }
    message.push_str(". Open Silo to review sandbox status.");
    message
}

pub(crate) fn install(app: &AppHandle) {
    crate::system_integrations::install_notifications();
    let app = app.clone();
    std::thread::spawn(move || {
        let mut health = HealthState::default();
        loop {
            // One bounded read at a time, including while the main window is hidden.
            if let Some(observations) = crate::runtime::health_observations(&app) {
                let changes = health.observe(observations);
                if !changes.is_empty() {
                    deliver(
                        &app,
                        Category::Health,
                        "Sandbox status changed",
                        &health_message(&changes),
                    );
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        }
    });
}

pub(crate) fn action_failed(app: &AppHandle, title: &'static str) {
    enqueue(
        app,
        Category::Actions,
        title,
        "The operation did not complete. Open Silo to review the error and retry.",
    );
}

fn backup_title(operation: &str, outcome: &str) -> Option<&'static str> {
    match (operation, outcome) {
        ("backup", "failed") => Some("Backup failed"),
        ("backup", "restart-required") => Some("Backup complete; sandbox restart failed"),
        ("restore", "failed") => Some("Restore failed"),
        _ => None,
    }
}

pub(crate) fn backup_result(app: &AppHandle, operation: &str, outcome: &str) {
    let Some(title) = backup_title(operation, outcome) else {
        return;
    };
    enqueue(
        app,
        Category::Backup,
        title,
        "Open Silo’s Backup screen to review the result and recovery instructions.",
    );
}

fn enqueue(app: &AppHandle, category: Category, title: &'static str, body: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || deliver(&app, category, title, body));
}

fn deliver(app: &AppHandle, category: Category, title: &str, body: &str) {
    let Ok(settings) = crate::settings::current_settings(app) else {
        return;
    };
    if !enabled(&settings, category) {
        return;
    }
    // A delivery failure must not change the result of the sandbox/backup operation.
    if crate::system_integrations::deliver_notification(title, body).is_err() {
        eprintln!("Silo could not deliver a system notification.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn settings(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }
    #[test]
    fn master_and_each_category_preference_gate_delivery() {
        for category in [Category::Health, Category::Actions, Category::Backup] {
            assert!(enabled(&settings(json!({})), category));
            assert!(!enabled(
                &settings(json!({"notificationsEnabled": false})),
                category
            ));
        }
        let preferences =
            settings(json!({"notifyHealth": false,"notifyActions": false,"notifyBackup": false}));
        for category in [Category::Health, Category::Actions, Category::Backup] {
            assert!(!enabled(&preferences, category));
        }
        assert!(enabled(
            &settings(json!({"notifyBackup": false})),
            Category::Actions
        ));
    }
    #[test]
    fn health_baseline_and_unchanged_errors_never_alert() {
        let mut state = HealthState::default();
        let failed = HashMap::from([("vm".into(), ("dev".into(), "Failed"))]);
        let healthy = HashMap::from([("vm".into(), ("dev".into(), "Running"))]);
        assert!(state.observe(failed.clone()).is_empty());
        assert!(state.observe(failed.clone()).is_empty());
        assert_eq!(state.observe(healthy.clone()), vec!["dev: Running"]);
        assert_eq!(state.observe(failed.clone()), vec!["dev: Failed"]);
        assert!(state.observe(failed).is_empty());
        assert_eq!(state.observe(healthy), vec!["dev: Running"]);
        assert!(state
            .observe(HashMap::from([(
                "new".into(),
                ("personal".into(), "Failed")
            )]))
            .is_empty());
    }
    #[test]
    fn health_batch_is_bounded_and_shows_actual_states() {
        let message = health_message(&[
            "dev: Running".into(),
            "playgrounds: Stopped".into(),
            "personal: Failed".into(),
            "other: Failed".into(),
        ]);
        assert!(message.contains("dev: Running"));
        assert!(message.contains("personal: Failed"));
        assert!(message.contains("1 more change"));
        assert!(!message.contains("other:"));
    }
    #[test]
    fn backup_failures_and_partial_restart_failures_alert_but_cancel_does_not() {
        assert_eq!(backup_title("backup", "failed"), Some("Backup failed"));
        assert_eq!(backup_title("restore", "failed"), Some("Restore failed"));
        assert!(backup_title("backup", "restart-required").is_some());
        for operation in ["backup", "restore"] {
            for outcome in ["success", "cancelled", "running"] {
                assert!(backup_title(operation, outcome).is_none());
            }
        }
    }
}
