//! Detects computer state changes nobody asked for and reports them as notices.
//!
//! Every reading is compared with a per-computer baseline. A difference is reported only when
//! no Silo operation touched that computer since the baseline (the gate's per-computer generation is
//! unchanged) and the computer was idle around the reading. Anything else is a change Silo
//! itself made and silently becomes the new baseline.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tauri::AppHandle;

use crate::notifications::{Category, Notice, NoticeComputer};

/// Poll this often while a local computer is running or starting.
const ACTIVE_INTERVAL: Duration = Duration::from_secs(10);
/// With nothing running, wait for gate activity; this is only a safety net.
const IDLE_FALLBACK: Duration = Duration::from_secs(5 * 60);
/// After a wake, let related gate changes settle so one reading covers them.
const SETTLE: Duration = Duration::from_millis(750);
/// More changed computers than this in one reading are reported as a single notice.
const MAX_INDIVIDUAL_NOTICES: usize = 3;
/// Consecutive failed reads before health checks are reported unavailable.
const FAILURES_BEFORE_UNAVAILABLE: u32 = 2;

pub(crate) struct ComputerReading {
    pub id: String,
    pub name: String,
    pub state: &'static str,
    /// The gate generation for this computer when the reading began.
    pub generation: u64,
    /// True when the computer was idle and untouched by any operation during the reading.
    pub settled: bool,
}

pub(crate) enum Reading {
    /// The reading overlapped a metadata change; it says nothing.
    Discarded,
    /// The runtime could not be inspected.
    Unavailable,
    Computers(Vec<ComputerReading>),
}

struct Baseline {
    state: &'static str,
    generation: u64,
}

#[derive(Default)]
struct HealthState {
    baselines: HashMap<String, Baseline>,
    seen_reading: bool,
    failures: u32,
    reported_unavailable: bool,
    any_running: bool,
}

impl HealthState {
    fn observe(&mut self, reading: Reading) -> Vec<Notice> {
        match reading {
            Reading::Discarded => Vec::new(),
            Reading::Unavailable => {
                self.failures = self.failures.saturating_add(1);
                if self.failures >= FAILURES_BEFORE_UNAVAILABLE && !self.reported_unavailable {
                    self.reported_unavailable = true;
                    return vec![runtime_notice(
                        "Computer health checks unavailable",
                        "Silo can't inspect its computers right now. It will keep trying.",
                    )];
                }
                Vec::new()
            }
            Reading::Computers(computers) => {
                self.failures = 0;
                let mut notices = Vec::new();
                if std::mem::take(&mut self.reported_unavailable) {
                    notices.push(runtime_notice(
                        "Computer health checks available again",
                        "Silo can inspect its computers again.",
                    ));
                }
                notices.extend(self.observe_computers(computers));
                notices
            }
        }
    }

    fn observe_computers(&mut self, computers: Vec<ComputerReading>) -> Vec<Notice> {
        let first = !std::mem::replace(&mut self.seen_reading, true);
        self.any_running = computers
            .iter()
            .any(|computer| matches!(computer.state, "Running" | "Starting"));
        let mut changed = Vec::new();
        let mut present = HashSet::new();
        for computer in &computers {
            present.insert(computer.id.clone());
            // A busy or touched computer keeps its old baseline: once it settles, the
            // generation comparison attributes the change correctly.
            if !computer.settled {
                continue;
            }
            if let Some(baseline) = self.baselines.get(&computer.id) {
                if !first
                    && baseline.generation == computer.generation
                    && baseline.state != computer.state
                {
                    changed.push(computer);
                }
            }
            self.baselines.insert(
                computer.id.clone(),
                Baseline {
                    state: computer.state,
                    generation: computer.generation,
                },
            );
        }
        self.baselines.retain(|id, _| present.contains(id));
        changed.sort_by(|a, b| a.name.cmp(&b.name));
        if changed.len() > MAX_INDIVIDUAL_NOTICES {
            let body = changed
                .iter()
                .map(|computer| format!("{}: {}", computer.name, describe(computer.state)))
                .collect::<Vec<_>>()
                .join(". ");
            return vec![Notice {
                category: Category::Changes,
                key: "health".into(),
                title: format!("{} computers changed", changed.len()),
                body: format!("{body}."),
                computer: None,
            }];
        }
        changed.into_iter().map(computer_notice).collect()
    }

    fn poll_interval(&self) -> Duration {
        if self.any_running {
            ACTIVE_INTERVAL
                .saturating_mul(1u32 << self.failures.min(5))
                .min(IDLE_FALLBACK)
        } else {
            IDLE_FALLBACK
        }
    }
}

fn describe(state: &str) -> &str {
    match state {
        "Running" => "running",
        "Stopped" => "stopped",
        "Starting" => "starting",
        "Failed" => "failed",
        _ => "health check failed",
    }
}

fn computer_notice(computer: &ComputerReading) -> Notice {
    let name = &computer.name;
    let (title, body) = match computer.state {
        "Stopped" => (
            format!("{name} stopped unexpectedly"),
            "The computer is no longer running. Open it to start it again.",
        ),
        "Failed" => (
            format!("{name} failed"),
            "The computer reported a failure. Open it to review the details.",
        ),
        "Running" => (
            format!("{name} is running again"),
            "The computer is running without Silo starting it.",
        ),
        "Starting" => (
            format!("{name} is starting"),
            "The computer began starting without Silo starting it.",
        ),
        _ => (
            format!("{name} health check failed"),
            "A health or configuration check failed. Open it to review the details.",
        ),
    };
    Notice {
        category: Category::Changes,
        key: format!("computer:{}:health", computer.id),
        title,
        body: body.into(),
        computer: Some(NoticeComputer {
            id: computer.id.clone(),
            name: computer.name.clone(),
        }),
    }
}

fn runtime_notice(title: &str, body: &str) -> Notice {
    Notice {
        category: Category::Changes,
        key: "health:runtime".into(),
        title: title.into(),
        body: body.into(),
        computer: None,
    }
}

pub(crate) fn install(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut health = HealthState::default();
        loop {
            // Anything finishing during the read wakes the next wait immediately.
            let seen = crate::runtime::OPERATIONS.activity();
            // One bounded read at a time, including while the main window is hidden.
            for notice in health.observe(crate::runtime::health_observations(&app)) {
                crate::notifications::notify(&app, notice);
            }
            let woken =
                crate::runtime::OPERATIONS.wait_for_activity(seen, health.poll_interval()) != seen;
            if woken {
                std::thread::sleep(SETTLE);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn computer(id: &str, state: &'static str, generation: u64, settled: bool) -> ComputerReading {
        ComputerReading {
            id: id.into(),
            name: id.to_uppercase(),
            state,
            generation,
            settled,
        }
    }
    fn reading(computers: Vec<ComputerReading>) -> Reading {
        Reading::Computers(computers)
    }

    #[test]
    fn first_observation_and_new_computers_are_silent() {
        let mut state = HealthState::default();
        assert!(state
            .observe(reading(vec![computer("a", "Failed", 0, true)]))
            .is_empty());
        assert!(state
            .observe(reading(vec![
                computer("a", "Failed", 0, true),
                computer("b", "Stopped", 0, true)
            ]))
            .is_empty());
    }

    #[test]
    fn unexpected_change_notifies_once_for_that_computer() {
        let mut state = HealthState::default();
        state.observe(reading(vec![computer("a", "Running", 0, true)]));
        let notices = state.observe(reading(vec![computer("a", "Stopped", 0, true)]));
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].key, "computer:a:health");
        assert_eq!(notices[0].title, "A stopped unexpectedly");
        assert_eq!(notices[0].category, Category::Changes);
        assert_eq!(notices[0].computer.as_ref().unwrap().id, "a");
        assert!(state
            .observe(reading(vec![computer("a", "Stopped", 0, true)]))
            .is_empty());
        let back = state.observe(reading(vec![computer("a", "Running", 0, true)]));
        assert_eq!(back[0].title, "A is running again");
        let failed = state.observe(reading(vec![computer("a", "Failed", 0, true)]));
        assert_eq!(failed[0].title, "A failed");
        let check = state.observe(reading(vec![computer(
            "a",
            "Health or configuration check failed",
            0,
            true,
        )]));
        assert_eq!(check[0].title, "A health check failed");
    }

    #[test]
    fn a_changed_generation_attributes_the_change_to_silo() {
        let mut state = HealthState::default();
        state.observe(reading(vec![computer("a", "Running", 4, true)]));
        // The user stopped it: the generation advanced, so the change is silent.
        assert!(state
            .observe(reading(vec![computer("a", "Stopped", 6, true)]))
            .is_empty());
        // The new baseline holds: a later external change is reported.
        assert_eq!(
            state
                .observe(reading(vec![computer("a", "Failed", 6, true)]))
                .len(),
            1
        );
    }

    #[test]
    fn start_then_stop_between_readings_stays_silent() {
        let mut state = HealthState::default();
        state.observe(reading(vec![computer("a", "Stopped", 2, true)]));
        // Started and stopped by the user within one interval: same state, new generation.
        assert!(state
            .observe(reading(vec![computer("a", "Stopped", 6, true)]))
            .is_empty());
        assert!(state
            .observe(reading(vec![computer("a", "Stopped", 6, true)]))
            .is_empty());
    }

    #[test]
    fn a_busy_computer_is_skipped_while_others_are_still_evaluated() {
        let mut state = HealthState::default();
        state.observe(reading(vec![
            computer("a", "Running", 0, true),
            computer("b", "Running", 0, true),
        ]));
        let notices = state.observe(reading(vec![
            computer("a", "Stopped", 1, false),
            computer("b", "Stopped", 0, true),
        ]));
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].key, "computer:b:health");
        // Once a settles at a new generation, it is rebaselined silently.
        assert!(state
            .observe(reading(vec![
                computer("a", "Stopped", 2, true),
                computer("b", "Stopped", 0, true)
            ]))
            .is_empty());
    }

    #[test]
    fn a_busy_reading_does_not_hide_a_crash_when_nothing_touched_the_computer() {
        // Hidden housekeeping makes a computer busy without bumping its generation.
        let mut state = HealthState::default();
        state.observe(reading(vec![computer("a", "Running", 3, true)]));
        assert!(state
            .observe(reading(vec![computer("a", "Stopped", 3, false)]))
            .is_empty());
        assert_eq!(
            state
                .observe(reading(vec![computer("a", "Stopped", 3, true)]))
                .len(),
            1
        );
    }

    #[test]
    fn many_changes_are_one_batched_notice() {
        let mut state = HealthState::default();
        let ids = ["a", "b", "c", "d"];
        state.observe(reading(
            ids.iter()
                .map(|id| computer(id, "Running", 0, true))
                .collect(),
        ));
        let three = state.observe(reading(
            ids.iter()
                .map(|id| computer(id, if *id == "d" { "Running" } else { "Stopped" }, 0, true))
                .collect(),
        ));
        assert_eq!(three.len(), 3);
        state.observe(reading(
            ids.iter()
                .map(|id| computer(id, "Running", 5, true))
                .collect(),
        ));
        let four = state.observe(reading(
            ids.iter()
                .map(|id| computer(id, "Stopped", 5, true))
                .collect(),
        ));
        assert_eq!(four.len(), 1);
        assert_eq!(four[0].key, "health");
        assert!(four[0].computer.is_none());
        assert!(four[0].body.contains("A: stopped"));
    }

    #[test]
    fn runtime_availability_is_debounced_and_never_first() {
        let mut state = HealthState::default();
        assert!(state.observe(Reading::Unavailable).is_empty());
        let unavailable = state.observe(Reading::Unavailable);
        assert_eq!(unavailable.len(), 1);
        assert_eq!(unavailable[0].key, "health:runtime");
        assert!(state.observe(Reading::Unavailable).is_empty());
        let available = state.observe(reading(vec![]));
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].title, "Computer health checks available again");
        assert!(state.observe(reading(vec![])).is_empty());
    }

    #[test]
    fn one_transient_failure_is_silent_and_discards_are_neutral() {
        let mut state = HealthState::default();
        state.observe(reading(vec![]));
        assert!(state.observe(Reading::Unavailable).is_empty());
        assert!(state.observe(Reading::Discarded).is_empty());
        assert!(state.observe(reading(vec![])).is_empty());
        // The failure count reset, so one more failure is again below the threshold.
        assert!(state.observe(Reading::Unavailable).is_empty());
    }

    #[test]
    fn failed_active_health_reads_back_off_to_the_idle_cap_and_reset_on_success() {
        let mut state = HealthState::default();
        state.observe(reading(vec![computer("a", "Running", 0, true)]));
        for seconds in [20, 40, 80, 160, 300, 300] {
            state.observe(Reading::Unavailable);
            assert_eq!(state.poll_interval(), Duration::from_secs(seconds));
        }
        state.observe(Reading::Discarded);
        assert_eq!(state.poll_interval(), IDLE_FALLBACK);
        state.observe(reading(vec![computer("a", "Running", 0, true)]));
        assert_eq!(state.poll_interval(), ACTIVE_INTERVAL);
        state.observe(reading(vec![computer("a", "Stopped", 0, true)]));
        state.observe(Reading::Unavailable);
        assert_eq!(state.poll_interval(), IDLE_FALLBACK);
    }

    #[test]
    fn polling_is_frequent_only_while_a_computer_runs() {
        let mut state = HealthState::default();
        state.observe(reading(vec![computer("a", "Stopped", 0, true)]));
        assert_eq!(state.poll_interval(), IDLE_FALLBACK);
        state.observe(reading(vec![computer("a", "Starting", 0, true)]));
        assert_eq!(state.poll_interval(), ACTIVE_INTERVAL);
    }
}
