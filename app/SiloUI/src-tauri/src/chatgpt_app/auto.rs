//! The background worker that keeps the pinned ChatGPT app published.
//!
//! Every computer running Silo prepares its own copy without asking: at app start, and
//! again after a retryable failure, with a growing delay. The pieces here are pure so
//! the schedule, the single-worker rule and the ready hook can be tested without an app.

use super::Status;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex,
    },
    time::Duration,
};

/// How long after the app starts before the first download begins.
pub(super) const START_DELAY: Duration = Duration::from_secs(10);

/// The wait before retry number `failures` (1 for the first retry): 30 s, 1 min, 2 min,
/// 5 min, 10 min, 30 min, then hourly. A download attempt already retries a broken
/// connection a few times with its own short backoff.
pub(super) fn delay_for(failures: u32) -> Duration {
    const MINUTES: [u64; 6] = [1, 2, 5, 10, 30, 60];
    match failures {
        0 | 1 => Duration::from_secs(30),
        n => Duration::from_secs(MINUTES[(n as usize - 2).min(MINUTES.len() - 1)] * 60),
    }
}

/// Runs `attempt` until the app is ready or a failure that retrying cannot fix. Between
/// attempts it calls `wait(delay)`, which returns true when woken early (the user chose
/// Retry), restarting the schedule. `on_ready` runs once when the app becomes ready.
pub(super) fn settle(
    mut attempt: impl FnMut() -> Status,
    mut wait: impl FnMut(Duration) -> bool,
    on_ready: impl FnOnce(),
) -> Status {
    let mut failures = 0u32;
    loop {
        match attempt() {
            status @ Status::Ready { .. } => {
                on_ready();
                return status;
            }
            // A hash mismatch or a pinned version OpenAI no longer serves: retrying
            // unprompted changes nothing. A manual retry starts a new worker.
            status @ Status::Failed {
                retryable: false, ..
            } => return status,
            // Retryable failure (offline, firewall, disk space), or a call that found
            // another run still going: wait, then try again.
            _ => {
                failures += 1;
                if wait(delay_for(failures)) {
                    failures = 0;
                }
            }
        }
    }
}

/// At most one worker per process.
pub(super) struct Slot(AtomicBool);

pub(super) struct Claim<'a>(&'a Slot);

impl Slot {
    pub(super) const fn new() -> Self {
        Self(AtomicBool::new(false))
    }
    pub(super) fn claim(&self) -> Option<Claim<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Claim(self))
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        (self.0).0.store(false, Ordering::SeqCst);
    }
}

pub(super) static WORKER: Slot = Slot::new();
pub(super) static RETRY: Wake = Wake::new();

/// A sleep that "Retry" can cut short.
pub(super) struct Wake {
    woken: Mutex<bool>,
    signal: Condvar,
}

impl Wake {
    pub(super) const fn new() -> Self {
        Self {
            woken: Mutex::new(false),
            signal: Condvar::new(),
        }
    }
    pub(super) fn wake(&self) {
        *self.woken.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.signal.notify_all();
    }
    /// Sleeps up to `delay`; returns whether it was woken.
    pub(super) fn wait(&self, delay: Duration) -> bool {
        let guard = self.woken.lock().unwrap_or_else(|p| p.into_inner());
        let (mut guard, _) = self
            .signal
            .wait_timeout_while(guard, delay, |woken| !*woken)
            .unwrap_or_else(|p| p.into_inner());
        std::mem::take(&mut *guard)
    }
}

/// Lowers the calling thread's priority so a 450 MB download and the unpacking never
/// compete with the app, VMs or the user's work. Child tools inherit it.
pub(super) fn lower_priority() {
    #[cfg(target_os = "macos")]
    // SAFETY: sets the quality of service of the calling thread only.
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0);
    }
    #[cfg(target_os = "linux")]
    // SAFETY: on Linux a nice value set with a thread id applies to that thread only.
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 10);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn ready() -> Status {
        Status::Ready {
            path: "/chatgpt/1.2.3-arm64".into(),
            version: "1.2.3".into(),
        }
    }
    fn offline() -> Status {
        Status::Failed {
            reason: "offline".into(),
            retryable: true,
        }
    }

    #[test]
    fn the_schedule_grows_and_stops_at_an_hour() {
        let seconds: Vec<u64> = (1..=9).map(|n| delay_for(n).as_secs()).collect();
        assert_eq!(seconds, [30, 60, 120, 300, 600, 1800, 3600, 3600, 3600]);
        assert_eq!(delay_for(0), delay_for(1));
    }

    #[test]
    fn retryable_failures_are_retried_with_backoff_until_ready() {
        let calls = Cell::new(0);
        let waits = RefCell::new(Vec::new());
        let readied = Cell::new(0);
        let status = settle(
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 4 {
                    offline()
                } else {
                    ready()
                }
            },
            |delay| {
                waits.borrow_mut().push(delay.as_secs());
                false
            },
            || readied.set(readied.get() + 1),
        );
        assert_eq!(status, ready());
        assert_eq!(calls.get(), 4);
        assert_eq!(*waits.borrow(), [30, 60, 120]);
        // The ready hook (the sync of running VMs) runs exactly once, at the end.
        assert_eq!(readied.get(), 1);
    }

    #[test]
    fn a_failure_retrying_cannot_fix_stops_the_worker_without_the_ready_hook() {
        let calls = Cell::new(0);
        let fatal = Status::Failed {
            reason: "checksum".into(),
            retryable: false,
        };
        let status = settle(
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    offline()
                } else {
                    fatal.clone()
                }
            },
            |_| false,
            || panic!("not ready"),
        );
        assert_eq!(status, fatal);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn an_early_wake_restarts_the_schedule() {
        let calls = Cell::new(0);
        let waits = RefCell::new(Vec::new());
        settle(
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 5 {
                    offline()
                } else {
                    ready()
                }
            },
            |delay| {
                waits.borrow_mut().push(delay.as_secs());
                // The user chooses Retry during the third wait.
                waits.borrow().len() == 3
            },
            || {},
        );
        assert_eq!(*waits.borrow(), [30, 60, 120, 30]);
    }

    #[test]
    fn a_run_found_in_progress_is_waited_out_not_duplicated() {
        // A call that finds another download running reports progress: not ready, not
        // failed. The worker waits and tries again.
        let calls = Cell::new(0);
        let status = settle(
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Status::Verifying
                } else {
                    ready()
                }
            },
            |_| false,
            || {},
        );
        assert_eq!(status, ready());
    }

    #[test]
    fn only_one_worker_runs_at_a_time() {
        let slot = Slot::new();
        let first = slot.claim();
        assert!(first.is_some());
        assert!(slot.claim().is_none());
        drop(first);
        assert!(slot.claim().is_some());
    }

    #[test]
    fn a_wake_cuts_a_wait_short_and_is_consumed() {
        let wake = Wake::new();
        assert!(!wake.wait(Duration::from_millis(10)));
        wake.wake();
        assert!(wake.wait(Duration::from_secs(30)));
        assert!(!wake.wait(Duration::from_millis(10)));
    }

    #[test]
    fn no_consent_paths_remain() {
        let source = include_str!("../chatgpt_app.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "consent",
            "accept_notice",
            "NotConsented",
            "chatgpt.accept",
            "chatgpt.prepare",
            "chatgpt_app_prepare",
        ] {
            assert!(!code.contains(forbidden), "{forbidden} is still present");
        }
        let build = include_str!("../../build.rs");
        let capabilities = include_str!("../../capabilities/preview.json");
        for removed in ["chatgpt_app_accept_notice", "chatgpt_app_prepare"] {
            assert!(!build.contains(removed));
        }
        assert!(!capabilities.contains("chatgpt-app-accept-notice"));
        assert!(!capabilities.contains("chatgpt-app-prepare"));
        assert!(build.contains("chatgpt_app_retry"));
        assert!(capabilities.contains("allow-chatgpt-app-retry"));
    }
}
