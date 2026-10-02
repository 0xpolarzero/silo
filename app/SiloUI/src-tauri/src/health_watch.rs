//! Detects sandbox state changes nobody asked for and reports them as notices.
//!
//! Every reading is compared with a per-VM baseline. A difference is reported only when
//! no Silo operation touched that VM since the baseline (the gate's per-VM generation is
//! unchanged) and the VM was idle around the reading. Anything else is a change Silo
//! itself made and silently becomes the new baseline.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use tauri::AppHandle;

use crate::notifications::{Category, Notice, NoticeSandbox};

/// Poll this often while a local VM is running or starting.
const ACTIVE_INTERVAL: Duration = Duration::from_secs(10);
/// With nothing running, wait for gate activity; this is only a safety net.
const IDLE_FALLBACK: Duration = Duration::from_secs(5 * 60);
/// After a wake, let related gate changes settle so one reading covers them.
const SETTLE: Duration = Duration::from_millis(750);
/// More changed VMs than this in one reading are reported as a single notice.
const MAX_INDIVIDUAL_NOTICES: usize = 3;
/// Consecutive failed reads before health checks are reported unavailable.
const FAILURES_BEFORE_UNAVAILABLE: u32 = 2;

pub(crate) struct VmReading {
    pub id: String,
    pub name: String,
    pub state: &'static str,
    /// The gate generation for this VM when the reading began.
    pub generation: u64,
    /// True when the VM was idle and untouched by any operation during the reading.
    pub settled: bool,
}

pub(crate) enum Reading {
    /// The reading overlapped a metadata change; it says nothing.
    Discarded,
    /// The runtime could not be inspected.
    Unavailable,
    Vms(Vec<VmReading>),
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
                        "Sandbox health checks unavailable",
                        "Silo can't inspect its sandboxes right now. It will keep trying.",
                    )];
                }
                Vec::new()
            }
            Reading::Vms(vms) => {
                self.failures = 0;
                let mut notices = Vec::new();
                if std::mem::take(&mut self.reported_unavailable) {
                    notices.push(runtime_notice(
                        "Sandbox health checks available again",
                        "Silo can inspect its sandboxes again.",
                    ));
                }
                notices.extend(self.observe_vms(vms));
                notices
            }
        }
    }

    fn observe_vms(&mut self, vms: Vec<VmReading>) -> Vec<Notice> {
        let first = !std::mem::replace(&mut self.seen_reading, true);
        self.any_running = vms
            .iter()
            .any(|vm| matches!(vm.state, "Running" | "Starting"));
        let mut changed = Vec::new();
        let mut present = HashSet::new();
        for vm in &vms {
            present.insert(vm.id.clone());
            // A busy or touched VM keeps its old baseline: once it settles, the
            // generation comparison attributes the change correctly.
            if !vm.settled {
                continue;
            }
            if let Some(baseline) = self.baselines.get(&vm.id) {
                if !first && baseline.generation == vm.generation && baseline.state != vm.state {
                    changed.push(vm);
                }
            }
            self.baselines.insert(
                vm.id.clone(),
                Baseline {
                    state: vm.state,
                    generation: vm.generation,
                },
            );
        }
        self.baselines.retain(|id, _| present.contains(id));
        changed.sort_by(|a, b| a.name.cmp(&b.name));
        if changed.len() > MAX_INDIVIDUAL_NOTICES {
            let body = changed
                .iter()
                .map(|vm| format!("{}: {}", vm.name, describe(vm.state)))
                .collect::<Vec<_>>()
                .join(". ");
            return vec![Notice {
                category: Category::Changes,
                key: "health".into(),
                title: format!("{} sandboxes changed", changed.len()),
                body: format!("{body}."),
                sandbox: None,
            }];
        }
        changed.into_iter().map(vm_notice).collect()
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

fn vm_notice(vm: &VmReading) -> Notice {
    let name = &vm.name;
    let (title, body) = match vm.state {
        "Stopped" => (
            format!("{name} stopped unexpectedly"),
            "The sandbox is no longer running. Open it to start it again.",
        ),
        "Failed" => (
            format!("{name} failed"),
            "The sandbox reported a failure. Open it to review the details.",
        ),
        "Running" => (
            format!("{name} is running again"),
            "The sandbox is running without Silo starting it.",
        ),
        "Starting" => (
            format!("{name} is starting"),
            "The sandbox began starting without Silo starting it.",
        ),
        _ => (
            format!("{name} health check failed"),
            "A health or configuration check failed. Open it to review the details.",
        ),
    };
    Notice {
        category: Category::Changes,
        key: format!("vm:{}:health", vm.id),
        title,
        body: body.into(),
        sandbox: Some(NoticeSandbox {
            id: vm.id.clone(),
            name: vm.name.clone(),
        }),
    }
}

fn runtime_notice(title: &str, body: &str) -> Notice {
    Notice {
        category: Category::Changes,
        key: "health:runtime".into(),
        title: title.into(),
        body: body.into(),
        sandbox: None,
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

    fn vm(id: &str, state: &'static str, generation: u64, settled: bool) -> VmReading {
        VmReading {
            id: id.into(),
            name: id.to_uppercase(),
            state,
            generation,
            settled,
        }
    }
    fn reading(vms: Vec<VmReading>) -> Reading {
        Reading::Vms(vms)
    }

    #[test]
    fn first_observation_and_new_vms_are_silent() {
        let mut state = HealthState::default();
        assert!(state
            .observe(reading(vec![vm("a", "Failed", 0, true)]))
            .is_empty());
        assert!(state
            .observe(reading(vec![
                vm("a", "Failed", 0, true),
                vm("b", "Stopped", 0, true)
            ]))
            .is_empty());
    }

    #[test]
    fn unexpected_change_notifies_once_for_that_vm() {
        let mut state = HealthState::default();
        state.observe(reading(vec![vm("a", "Running", 0, true)]));
        let notices = state.observe(reading(vec![vm("a", "Stopped", 0, true)]));
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].key, "vm:a:health");
        assert_eq!(notices[0].title, "A stopped unexpectedly");
        assert_eq!(notices[0].category, Category::Changes);
        assert_eq!(notices[0].sandbox.as_ref().unwrap().id, "a");
        assert!(state
            .observe(reading(vec![vm("a", "Stopped", 0, true)]))
            .is_empty());
        let back = state.observe(reading(vec![vm("a", "Running", 0, true)]));
        assert_eq!(back[0].title, "A is running again");
        let failed = state.observe(reading(vec![vm("a", "Failed", 0, true)]));
        assert_eq!(failed[0].title, "A failed");
        let check = state.observe(reading(vec![vm(
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
        state.observe(reading(vec![vm("a", "Running", 4, true)]));
        // The user stopped it: the generation advanced, so the change is silent.
        assert!(state
            .observe(reading(vec![vm("a", "Stopped", 6, true)]))
            .is_empty());
        // The new baseline holds: a later external change is reported.
        assert_eq!(
            state
                .observe(reading(vec![vm("a", "Failed", 6, true)]))
                .len(),
            1
        );
    }

    #[test]
    fn start_then_stop_between_readings_stays_silent() {
        let mut state = HealthState::default();
        state.observe(reading(vec![vm("a", "Stopped", 2, true)]));
        // Started and stopped by the user within one interval: same state, new generation.
        assert!(state
            .observe(reading(vec![vm("a", "Stopped", 6, true)]))
            .is_empty());
        assert!(state
            .observe(reading(vec![vm("a", "Stopped", 6, true)]))
            .is_empty());
    }

    #[test]
    fn a_busy_vm_is_skipped_while_others_are_still_evaluated() {
        let mut state = HealthState::default();
        state.observe(reading(vec![
            vm("a", "Running", 0, true),
            vm("b", "Running", 0, true),
        ]));
        let notices = state.observe(reading(vec![
            vm("a", "Stopped", 1, false),
            vm("b", "Stopped", 0, true),
        ]));
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].key, "vm:b:health");
        // Once a settles at a new generation, it is rebaselined silently.
        assert!(state
            .observe(reading(vec![
                vm("a", "Stopped", 2, true),
                vm("b", "Stopped", 0, true)
            ]))
            .is_empty());
    }

    #[test]
    fn a_busy_reading_does_not_hide_a_crash_when_nothing_touched_the_vm() {
        // Hidden housekeeping makes a VM busy without bumping its generation.
        let mut state = HealthState::default();
        state.observe(reading(vec![vm("a", "Running", 3, true)]));
        assert!(state
            .observe(reading(vec![vm("a", "Stopped", 3, false)]))
            .is_empty());
        assert_eq!(
            state
                .observe(reading(vec![vm("a", "Stopped", 3, true)]))
                .len(),
            1
        );
    }

    #[test]
    fn many_changes_are_one_batched_notice() {
        let mut state = HealthState::default();
        let ids = ["a", "b", "c", "d"];
        state.observe(reading(
            ids.iter().map(|id| vm(id, "Running", 0, true)).collect(),
        ));
        let three = state.observe(reading(
            ids.iter()
                .map(|id| vm(id, if *id == "d" { "Running" } else { "Stopped" }, 0, true))
                .collect(),
        ));
        assert_eq!(three.len(), 3);
        state.observe(reading(
            ids.iter().map(|id| vm(id, "Running", 5, true)).collect(),
        ));
        let four = state.observe(reading(
            ids.iter().map(|id| vm(id, "Stopped", 5, true)).collect(),
        ));
        assert_eq!(four.len(), 1);
        assert_eq!(four[0].key, "health");
        assert!(four[0].sandbox.is_none());
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
        assert_eq!(available[0].title, "Sandbox health checks available again");
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
        state.observe(reading(vec![vm("a", "Running", 0, true)]));
        for seconds in [20, 40, 80, 160, 300, 300] {
            state.observe(Reading::Unavailable);
            assert_eq!(state.poll_interval(), Duration::from_secs(seconds));
        }
        state.observe(Reading::Discarded);
        assert_eq!(state.poll_interval(), IDLE_FALLBACK);
        state.observe(reading(vec![vm("a", "Running", 0, true)]));
        assert_eq!(state.poll_interval(), ACTIVE_INTERVAL);
        state.observe(reading(vec![vm("a", "Stopped", 0, true)]));
        state.observe(Reading::Unavailable);
        assert_eq!(state.poll_interval(), IDLE_FALLBACK);
    }

    #[test]
    fn polling_is_frequent_only_while_a_vm_runs() {
        let mut state = HealthState::default();
        state.observe(reading(vec![vm("a", "Stopped", 0, true)]));
        assert_eq!(state.poll_interval(), IDLE_FALLBACK);
        state.observe(reading(vec![vm("a", "Starting", 0, true)]));
        assert_eq!(state.poll_interval(), ACTIVE_INTERVAL);
    }
}
