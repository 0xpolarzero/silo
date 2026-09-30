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
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::Duration;

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

impl Category {
    /// Stable name, used to group system notifications that have no sandbox.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Failures => "failures",
            Self::Changes => "changes",
            Self::Completions => "completions",
        }
    }
}

impl Notice {
    /// Where a click on the system notification opens the app. Same shape as
    /// `desktop/use-main-route.ts`.
    pub(crate) fn route(&self) -> Value {
        match &self.sandbox {
            Some(sandbox) => serde_json::json!({"tab": "workspaces", "workspace": sandbox.name}),
            None => serde_json::json!({"tab": "workspaces"}),
        }
    }

    /// Notifications with the same thread collapse together in Notification Center.
    pub(crate) fn thread(&self) -> &str {
        self.sandbox
            .as_ref()
            .map_or(self.category.as_str(), |sandbox| sandbox.id.as_str())
    }
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
            Category::Failures => flag(
                settings,
                "notifyFailures",
                &["notifyActions", "notifyBackup"],
            ),
            Category::Changes => flag(settings, "notifyChanges", &["notifyHealth"]),
            Category::Completions => flag(settings, "notifyCompletions", &[]),
        }
}

pub(crate) fn install(app: &AppHandle) {
    crate::system_integrations::install_notifications(app);
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

/// Delivered system notifications by sandbox id, so deleting a sandbox can withdraw them.
#[derive(Default)]
struct DeliveredIndex {
    keys: HashMap<String, BTreeSet<String>>,
}

impl DeliveredIndex {
    fn record(&mut self, notice: &Notice) {
        if let Some(sandbox) = &notice.sandbox {
            self.keys
                .entry(sandbox.id.clone())
                .or_default()
                .insert(notice.key.clone());
        }
    }
    fn take(&mut self, sandbox_id: &str) -> Vec<String> {
        self.keys
            .remove(sandbox_id)
            .map(|keys| keys.into_iter().collect())
            .unwrap_or_default()
    }
}

static DELIVERED: Mutex<Option<DeliveredIndex>> = Mutex::new(None);

fn with_delivered<T>(f: impl FnOnce(&mut DeliveredIndex) -> T) -> T {
    let mut guard = DELIVERED.lock().unwrap_or_else(|error| error.into_inner());
    f(guard.get_or_insert_with(DeliveredIndex::default))
}

/// Remove delivered system notifications about one sandbox (for example, after deletion).
/// Runs off the calling thread; failures are ignored.
pub(crate) fn clear_sandbox(_app: &AppHandle, sandbox_id: &str) {
    let keys = with_delivered(|index| index.take(sandbox_id));
    if keys.is_empty() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::system_integrations::clear_notifications(&keys);
    });
}

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
    match crate::system_integrations::deliver_notification(notice) {
        Ok(()) => with_delivered(|index| index.record(notice)),
        Err(_) => eprintln!("Silo could not deliver a system notification."),
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

/// Longest body shown in a system notification. Full detail stays in the app.
const BODY_LIMIT: usize = 200;

/// One-line, bounded text for a system notification body.
pub(crate) fn bounded_body(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= BODY_LIMIT {
        return collapsed;
    }
    let mut cut: String = collapsed.chars().take(BODY_LIMIT - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('\u{2026}');
    cut
}

/// What a lifecycle (start/stop/restart) operation ended as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome<'a> {
    Succeeded,
    /// The user cancelled. An expected result, never a notice.
    Cancelled,
    /// A duplicate request was handed to the one already queued. Never a notice.
    AlreadyQueued,
    Failed(&'a str),
}

fn seconds(elapsed: Duration) -> String {
    format!("Took {} seconds.", elapsed.as_secs())
}

/// Notice for a sandbox start, stop or restart, local or remote. Failures always notify;
/// successes only when the operation was long enough that the user likely looked away.
pub(crate) fn lifecycle_notice(
    action: &str,
    name: &str,
    sandbox: Option<NoticeSandbox>,
    elapsed: Duration,
    outcome: Outcome<'_>,
) -> Option<Notice> {
    let (verb, done) = match action {
        "start" => ("start", format!("{name} is running")),
        "stop" => ("stop", format!("{name} stopped")),
        "restart" => ("restart", format!("{name} restarted")),
        _ => return None,
    };
    let key = sandbox.as_ref().map_or_else(
        || format!("lifecycle:{name}"),
        |s| format!("vm:{}:lifecycle", s.id),
    );
    match outcome {
        Outcome::Cancelled | Outcome::AlreadyQueued => None,
        Outcome::Failed(message) => Some(Notice {
            category: Category::Failures,
            key,
            title: format!("Couldn\u{2019}t {verb} {name}"),
            body: bounded_body(message),
            sandbox,
        }),
        Outcome::Succeeded if elapsed >= LONG_OPERATION => Some(Notice {
            category: Category::Completions,
            key,
            title: done,
            body: seconds(elapsed),
            sandbox,
        }),
        Outcome::Succeeded => None,
    }
}

/// Notice for an export (`backup`) or import (`restore`).
pub(crate) fn transfer_notice(
    operation: &str,
    label: &str,
    sandbox: Option<NoticeSandbox>,
    elapsed: Duration,
    outcome: &str,
    message: &str,
) -> Option<Notice> {
    let (noun, done) = match operation {
        "backup" => ("export", "Exported"),
        "restore" => ("import", "Imported"),
        _ => return None,
    };
    let key = sandbox.as_ref().map_or_else(
        || "transfer".to_string(),
        |s| format!("vm:{}:transfer", s.id),
    );
    let (category, title, body) = match outcome {
        "failed" => (
            Category::Failures,
            format!("Couldn\u{2019}t {noun} {label}"),
            bounded_body(message),
        ),
        "success" if elapsed >= LONG_OPERATION => (
            Category::Completions,
            format!("{done} {label}"),
            seconds(elapsed),
        ),
        _ => return None,
    };
    Some(Notice {
        category,
        key,
        title,
        body,
        sandbox,
    })
}

/// A failure notice with a bounded body.
pub(crate) fn failure(
    key: &str,
    title: &str,
    message: &str,
    sandbox: Option<NoticeSandbox>,
) -> Notice {
    Notice {
        category: Category::Failures,
        key: key.into(),
        title: title.into(),
        body: bounded_body(message),
        sandbox,
    }
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
            assert!(!enabled(
                &settings(json!({"notificationsEnabled": false})),
                category
            ));
        }
        let preferences = settings(
            json!({"notifyFailures": false, "notifyChanges": false, "notifyCompletions": false}),
        );
        for category in ALL {
            assert!(!enabled(&preferences, category));
        }
        assert!(enabled(
            &settings(json!({"notifyChanges": false})),
            Category::Failures
        ));
    }
    #[test]
    fn legacy_switches_apply_until_new_keys_are_saved() {
        assert!(!enabled(
            &settings(json!({"notifyHealth": false})),
            Category::Changes
        ));
        assert!(!enabled(
            &settings(json!({"notifyBackup": false})),
            Category::Failures
        ));
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
            sandbox: Some(NoticeSandbox {
                id: "1".into(),
                name: "dev".into(),
            }),
        };
        assert_eq!(
            serde_json::to_value(&notice).unwrap(),
            json!({"category": "completions", "key": "vm:1:lifecycle", "title": "dev is running", "body": "", "sandbox": {"id": "1", "name": "dev"}})
        );
    }
    fn sandbox() -> Option<NoticeSandbox> {
        Some(NoticeSandbox {
            id: "1".into(),
            name: "dev".into(),
        })
    }
    const SHORT: Duration = Duration::from_secs(1);
    const LONG: Duration = LONG_OPERATION;
    #[test]
    fn body_is_one_bounded_line() {
        assert_eq!(
            bounded_body("  first\n second\t line "),
            "first second line"
        );
        let body = bounded_body(&"x".repeat(500));
        assert_eq!(body.chars().count(), BODY_LIMIT);
        assert!(body.ends_with('\u{2026}'));
        assert_eq!(
            bounded_body(&"y".repeat(BODY_LIMIT)).chars().count(),
            BODY_LIMIT
        );
    }
    #[test]
    fn lifecycle_failures_name_the_sandbox_and_share_a_key() {
        let notice = lifecycle_notice(
            "start",
            "dev",
            sandbox(),
            SHORT,
            Outcome::Failed("no memory\nleft"),
        )
        .unwrap();
        assert_eq!(notice.category, Category::Failures);
        assert_eq!(notice.title, "Couldn\u{2019}t start dev");
        assert_eq!(notice.body, "no memory left");
        assert_eq!(notice.key, "vm:1:lifecycle");
        let done = lifecycle_notice("stop", "dev", sandbox(), LONG, Outcome::Succeeded).unwrap();
        assert_eq!(done.key, notice.key);
        assert_eq!(done.category, Category::Completions);
        assert_eq!(done.title, "dev stopped");
        assert_eq!(
            lifecycle_notice("restart", "dev", sandbox(), LONG, Outcome::Succeeded)
                .unwrap()
                .title,
            "dev restarted"
        );
        assert_eq!(
            lifecycle_notice("start", "dev", sandbox(), LONG, Outcome::Succeeded)
                .unwrap()
                .title,
            "dev is running"
        );
    }
    #[test]
    fn lifecycle_successes_notify_only_after_the_long_threshold() {
        assert!(lifecycle_notice("start", "dev", sandbox(), SHORT, Outcome::Succeeded).is_none());
        assert!(lifecycle_notice(
            "start",
            "dev",
            sandbox(),
            LONG - Duration::from_millis(1),
            Outcome::Succeeded
        )
        .is_none());
        assert!(lifecycle_notice("start", "dev", sandbox(), LONG, Outcome::Succeeded).is_some());
    }
    #[test]
    fn cancellation_queue_dedupe_and_dismiss_never_notify() {
        for elapsed in [SHORT, LONG] {
            assert!(
                lifecycle_notice("start", "dev", sandbox(), elapsed, Outcome::Cancelled).is_none()
            );
            assert!(
                lifecycle_notice("start", "dev", sandbox(), elapsed, Outcome::AlreadyQueued)
                    .is_none()
            );
            assert!(lifecycle_notice(
                "dismiss-error",
                "dev",
                sandbox(),
                elapsed,
                Outcome::Succeeded
            )
            .is_none());
            assert!(lifecycle_notice(
                "dismiss-error",
                "dev",
                sandbox(),
                elapsed,
                Outcome::Failed("x")
            )
            .is_none());
        }
    }
    #[test]
    fn lifecycle_without_a_known_id_still_has_a_stable_key() {
        let notice = lifecycle_notice("start", "dev", None, SHORT, Outcome::Failed("x")).unwrap();
        assert_eq!(notice.key, "lifecycle:dev");
        assert!(notice.sandbox.is_none());
    }
    #[test]
    fn transfer_notices_follow_the_outcome() {
        let failed =
            transfer_notice("backup", "dev", sandbox(), SHORT, "failed", "disk full").unwrap();
        assert_eq!(
            (failed.category, failed.title.as_str(), failed.key.as_str()),
            (
                Category::Failures,
                "Couldn\u{2019}t export dev",
                "vm:1:transfer"
            )
        );
        assert_eq!(failed.body, "disk full");
        assert!(transfer_notice("restore", "dev", sandbox(), SHORT, "success", "").is_none());
        let long = transfer_notice("restore", "dev", sandbox(), LONG, "success", "").unwrap();
        assert_eq!(
            (long.category, long.title.as_str()),
            (Category::Completions, "Imported dev")
        );
        assert_eq!(
            transfer_notice("backup", "3 sandboxes", None, LONG, "success", "")
                .unwrap()
                .key,
            "transfer"
        );
        for operation in ["backup", "restore"] {
            // Exports no longer stop sandboxes, so there is no restart outcome to report.
            for outcome in ["cancelled", "running", "restart-required"] {
                assert!(transfer_notice(operation, "dev", sandbox(), LONG, outcome, "x").is_none());
            }
        }
    }
    #[test]
    fn click_routes_open_the_sandbox_or_the_list() {
        let mut notice = failure("k", "t", "b", sandbox());
        assert_eq!(
            notice.route(),
            json!({"tab": "workspaces", "workspace": "dev"})
        );
        assert_eq!(notice.thread(), "1");
        notice.sandbox = None;
        assert_eq!(notice.route(), json!({"tab": "workspaces"}));
        assert_eq!(notice.thread(), "failures");
    }
    #[test]
    fn delivered_index_tracks_and_clears_per_sandbox() {
        let mut index = DeliveredIndex::default();
        let notice = |id: &str, key: &str| Notice {
            sandbox: Some(NoticeSandbox {
                id: id.into(),
                name: "n".into(),
            }),
            ..failure(key, "t", "b", None)
        };
        index.record(&notice("1", "vm:1:lifecycle"));
        index.record(&notice("1", "vm:1:lifecycle"));
        index.record(&notice("1", "vm:1:transfer"));
        index.record(&notice("2", "vm:2:lifecycle"));
        index.record(&failure("startup", "t", "b", None));
        assert_eq!(index.take("1"), vec!["vm:1:lifecycle", "vm:1:transfer"]);
        assert!(index.take("1").is_empty());
        assert_eq!(index.take("2"), vec!["vm:2:lifecycle"]);
    }
}
