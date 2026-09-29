//! Detects sandbox state changes nobody asked for and reports them as notices.
use std::collections::HashMap;
use std::time::Duration;

use tauri::AppHandle;

use crate::notifications::{Category, Notice};

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
    let app = app.clone();
    std::thread::spawn(move || {
        let mut health = HealthState::default();
        loop {
            // One bounded read at a time, including while the main window is hidden.
            if let Some(observations) = crate::runtime::health_observations(&app) {
                let changes = health.observe(observations);
                if !changes.is_empty() {
                    crate::notifications::notify(
                        &app,
                        Notice {
                            category: Category::Changes,
                            key: "health".into(),
                            title: "Sandbox status changed".into(),
                            body: health_message(&changes),
                            sandbox: None,
                        },
                    );
                }
            }
            std::thread::sleep(Duration::from_secs(30));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
