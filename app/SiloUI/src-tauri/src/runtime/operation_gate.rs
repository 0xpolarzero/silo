//! Ordered admission for operations that change VM runtime state on this computer.
//!
//! Callers wait their turn instead of failing with "busy". Work on different VMs
//! runs concurrently; computer-wide work waits for everything else. Admission is
//! first-come, first-served among conflicting requests, so a waiting computer-wide
//! operation is never starved by a stream of per-VM operations.
//!
//! This is the sole in-process gate for VM-changing work. It does not replace the
//! OS file lock that coordinates cooperating runtime processes, nor short data locks.
use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    /// Changes shared state: VM inventory, host networking, runtime generation, updates.
    Computer,
    /// Changes one VM's runtime or guest state only. Keyed by the stable VM id so a
    /// rename never lets two operations on the same VM run concurrently, and so
    /// id-addressed work (checkpoints, remote lifecycle) shares the same lane as the
    /// name-addressed lifecycle commands.
    Vm { id: String },
}

impl Scope {
    fn conflicts(&self, other: &Scope) -> bool {
        match (self, other) {
            (Scope::Vm { id: a }, Scope::Vm { id: b }) => a == b,
            _ => true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GateError {
    /// An identical request is already waiting; the caller should not run it twice.
    AlreadyQueued,
    /// The current thread already holds an operation; waiting would deadlock.
    Nested,
    /// A `try_` request found conflicting work.
    Busy,
    /// The caller stopped waiting (for example, the user cancelled) before its turn.
    Abandoned,
}

impl std::fmt::Display for GateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyQueued => "This action is already waiting to run.",
            Self::Nested => "Sandbox operation ordering failed.",
            Self::Busy => "Another sandbox operation is still running.",
            Self::Abandoned => "The operation stopped waiting for its turn.",
        })
    }
}

impl std::error::Error for GateError {}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationEntry {
    pub id: u64,
    pub label: String,
    /// Stable VM id this operation is scoped to; `None` for computer-wide operations.
    pub vm_id: Option<String>,
    /// VM display name captured when the operation was admitted; `None` for
    /// computer-wide operations. For display only — ordering keys on `vm_id`.
    pub vm_name: Option<String>,
    /// Milliseconds since the Unix epoch when the operation started running or began waiting.
    pub since_ms: u64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationQueue {
    pub running: Vec<OperationEntry>,
    /// In admission order.
    pub waiting: Vec<OperationEntry>,
}

struct Entry {
    id: u64,
    scope: Scope,
    /// VM display name for per-VM entries; `None` for computer-wide entries.
    vm_name: Option<String>,
    label: String,
    key: Option<String>,
    since: Instant,
    since_ms: u64,
}

impl Entry {
    fn public(&self) -> OperationEntry {
        OperationEntry {
            id: self.id,
            label: self.label.clone(),
            vm_id: match &self.scope {
                Scope::Computer => None,
                Scope::Vm { id } => Some(id.clone()),
            },
            vm_name: self.vm_name.clone(),
            since_ms: self.since_ms,
        }
    }
}

#[derive(Default)]
struct State {
    next_id: u64,
    running: Vec<Entry>,
    waiting: VecDeque<Entry>,
}

impl State {
    /// A request may run when it conflicts with no running work and no earlier waiter.
    fn admissible(&self, index: usize) -> bool {
        let scope = &self.waiting[index].scope;
        !self.running.iter().any(|entry| entry.scope.conflicts(scope))
            && !self.waiting.iter().take(index).any(|entry| entry.scope.conflicts(scope))
    }

    fn free(&self, scope: &Scope) -> bool {
        !self.running.iter().any(|entry| entry.scope.conflicts(scope))
            && !self.waiting.iter().any(|entry| entry.scope.conflicts(scope))
    }

    fn entry(&mut self, scope: Scope, vm_name: Option<String>, label: &str, key: Option<String>) -> Entry {
        self.next_id += 1;
        Entry {
            id: self.next_id,
            scope,
            vm_name,
            label: label.to_owned(),
            key,
            since: Instant::now(),
            since_ms: now_ms(),
        }
    }
}

pub(crate) struct OperationGate {
    state: Mutex<State>,
    changed: Condvar,
    listener: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

thread_local! {
    static HELD: Cell<usize> = const { Cell::new(0) };
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

impl OperationGate {
    pub(crate) const fn new() -> Self {
        Self {
            state: Mutex::new(State {
                next_id: 0,
                running: Vec::new(),
                waiting: VecDeque::new(),
            }),
            changed: Condvar::new(),
            listener: OnceLock::new(),
        }
    }

    /// Called after every queue change, outside the internal lock. Set once at startup.
    pub(crate) fn set_listener(&self, listener: impl Fn() + Send + Sync + 'static) {
        let _ = self.listener.set(Box::new(listener));
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // The state is a plain list; a panic while holding it cannot leave it half-updated.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self) {
        self.changed.notify_all();
        if let Some(listener) = self.listener.get() {
            listener();
        }
    }

    /// Wait for a turn to change shared computer state.
    pub(crate) fn computer(&self, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.acquire(Scope::Computer, None, label, None)
    }

    /// Wait for a turn to change one VM, identified by its stable `id`. `name` is the
    /// current display name captured for the queue; ordering keys on `id` alone.
    pub(crate) fn vm(&self, id: &str, name: &str, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.acquire(Scope::Vm { id: id.to_owned() }, Some(name.to_owned()), label, None)
    }

    /// Wait for a turn, rejecting the request when an identical `key` is already waiting.
    /// `vm_name` is the display name for per-VM scopes (`None` for computer scope).
    pub(crate) fn acquire(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
        key: Option<String>,
    ) -> Result<OperationGuard<'_>, GateError> {
        self.acquire_inner(scope, vm_name, label, key, None)
    }

    /// Wait for a turn while `keep_waiting` returns true; otherwise leave the queue
    /// with `GateError::Abandoned`. Checked at least every 100 ms.
    pub(crate) fn acquire_while(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
        keep_waiting: &dyn Fn() -> bool,
    ) -> Result<OperationGuard<'_>, GateError> {
        self.acquire_inner(scope, vm_name, label, None, Some(keep_waiting))
    }

    fn acquire_inner(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
        key: Option<String>,
        keep_waiting: Option<&dyn Fn() -> bool>,
    ) -> Result<OperationGuard<'_>, GateError> {
        if HELD.with(Cell::get) > 0 {
            return Err(GateError::Nested);
        }
        let mut state = self.lock();
        if key.is_some() && state.waiting.iter().any(|entry| entry.key == key) {
            return Err(GateError::AlreadyQueued);
        }
        let entry = state.entry(scope, vm_name, label, key);
        let id = entry.id;
        state.waiting.push_back(entry);
        drop(state);
        self.notify();
        let mut state = self.lock();
        loop {
            let index = state
                .waiting
                .iter()
                .position(|entry| entry.id == id)
                .expect("a waiting operation is removed only when admitted");
            if state.admissible(index) {
                let mut entry = state.waiting.remove(index).expect("index is in range");
                entry.since = Instant::now();
                entry.since_ms = now_ms();
                state.running.push(entry);
                break;
            }
            match keep_waiting {
                None => {
                    state = self
                        .changed
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                Some(keep_waiting) => {
                    state = self
                        .changed
                        .wait_timeout(state, std::time::Duration::from_millis(100))
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .0;
                    // Re-check admission first: a turn that arrived is not given up.
                    let index = state.waiting.iter().position(|entry| entry.id == id);
                    if index.is_some_and(|index| !state.admissible(index)) && !keep_waiting() {
                        state.waiting.retain(|entry| entry.id != id);
                        drop(state);
                        self.notify();
                        return Err(GateError::Abandoned);
                    }
                }
            }
        }
        drop(state);
        HELD.with(|held| held.set(held.get() + 1));
        self.notify();
        Ok(OperationGuard { gate: self, id, _thread_bound: std::marker::PhantomData })
    }

    /// Run only when nothing conflicting is running or waiting. For background work
    /// that should skip busy periods rather than accumulate.
    pub(crate) fn try_acquire(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
    ) -> Result<OperationGuard<'_>, GateError> {
        if HELD.with(Cell::get) > 0 {
            return Err(GateError::Nested);
        }
        let mut state = self.lock();
        if !state.free(&scope) {
            return Err(GateError::Busy);
        }
        let entry = state.entry(scope, vm_name, label, None);
        let id = entry.id;
        state.running.push(entry);
        drop(state);
        HELD.with(|held| held.set(held.get() + 1));
        self.notify();
        Ok(OperationGuard { gate: self, id, _thread_bound: std::marker::PhantomData })
    }

    pub(crate) fn try_computer(&self, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.try_acquire(Scope::Computer, None, label)
    }

    /// Run work for one VM only when nothing conflicting for that VM is running or
    /// waiting. For background repair that should skip busy VMs rather than queue.
    /// Identified by the stable `id`; `name` is the display name for the queue.
    pub(crate) fn try_vm(&self, id: &str, name: &str, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.try_acquire(Scope::Vm { id: id.to_owned() }, Some(name.to_owned()), label)
    }

    /// True when no operation is running or waiting. Observers use this to discard
    /// readings that overlapped a change.
    pub(crate) fn is_idle(&self) -> bool {
        let state = self.lock();
        state.running.is_empty() && state.waiting.is_empty()
    }

    /// True when no operation affecting the VM with stable `id` is running or waiting.
    pub(crate) fn is_vm_idle(&self, id: &str) -> bool {
        self.lock().free(&Scope::Vm { id: id.to_owned() })
    }

    pub(crate) fn snapshot(&self) -> OperationQueue {
        let state = self.lock();
        OperationQueue {
            running: state.running.iter().map(Entry::public).collect(),
            waiting: state.waiting.iter().map(Entry::public).collect(),
        }
    }

    /// Longest-running operation and its age, for stuck-operation reporting.
    pub(crate) fn oldest_running(&self) -> Option<(String, std::time::Duration)> {
        let state = self.lock();
        state
            .running
            .iter()
            .min_by_key(|entry| entry.since)
            .map(|entry| (entry.label.clone(), entry.since.elapsed()))
    }

    fn release(&self, id: u64) {
        let mut state = self.lock();
        state.running.retain(|entry| entry.id != id);
        drop(state);
        HELD.with(|held| held.set(held.get().saturating_sub(1)));
        self.notify();
    }
}

/// Held for the duration of one operation, including all of its internal steps.
#[must_use = "the operation ends when the guard is dropped"]
pub(crate) struct OperationGuard<'a> {
    gate: &'a OperationGate,
    id: u64,
    /// Nesting is tracked per thread, so a guard must be released where it was taken.
    _thread_bound: std::marker::PhantomData<*const ()>,
}

impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.gate.release(self.id);
    }
}

impl std::fmt::Debug for OperationGuard<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("OperationGuard").field("id", &self.id).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    fn leak() -> &'static OperationGate {
        Box::leak(Box::new(OperationGate::new()))
    }

    /// Nesting is per thread, so a second concurrent caller needs its own thread.
    fn elsewhere<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
        thread::spawn(work).join().unwrap()
    }

    fn wait_until(gate: &OperationGate, predicate: impl Fn(&OperationQueue) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate(&gate.snapshot()) {
            assert!(Instant::now() < deadline, "gate did not reach expected state");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn different_vms_run_concurrently() {
        let gate = leak();
        let a = gate.vm("id-a", "a", "Start a").unwrap();
        let (sent, received) = mpsc::channel();
        thread::spawn(move || {
            let _b = gate.vm("id-b", "b", "Start b").unwrap();
            sent.send(()).unwrap();
        });
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(a);
    }

    #[test]
    fn same_vm_waits_instead_of_failing() {
        let gate = leak();
        let first = gate.vm("id-a", "a", "Start a").unwrap();
        let handle = thread::spawn(move || {
            let _second = gate.vm("id-a", "a", "Stop a").unwrap();
        });
        wait_until(gate, |queue| queue.waiting.len() == 1 && queue.waiting[0].label == "Stop a");
        drop(first);
        handle.join().unwrap();
        assert!(gate.is_idle());
    }

    #[test]
    fn same_vm_id_conflicts_even_when_the_name_differs() {
        // A rename mid-flight keeps the stable id, so a second operation on the same
        // VM waits its turn even though it carries a different display name.
        let gate = leak();
        let first = gate.vm("id-a", "old-name", "Start old-name").unwrap();
        let handle = thread::spawn(move || {
            let _second = gate.vm("id-a", "new-name", "Stop new-name").unwrap();
        });
        wait_until(gate, |queue| queue.waiting.len() == 1 && queue.waiting[0].label == "Stop new-name");
        // The running entry reports the id it is keyed on and the name it captured.
        let running = &gate.snapshot().running[0];
        assert_eq!(running.vm_id.as_deref(), Some("id-a"));
        assert_eq!(running.vm_name.as_deref(), Some("old-name"));
        drop(first);
        handle.join().unwrap();
        assert!(gate.is_idle());
    }

    #[test]
    fn different_ids_sharing_a_name_do_not_conflict() {
        // Two VMs that transiently share a display name still run concurrently: the
        // gate keys on id, not name.
        let gate = leak();
        let a = gate.vm("id-a", "shared", "Start id-a").unwrap();
        let (sent, received) = mpsc::channel();
        thread::spawn(move || {
            let _b = gate.vm("id-b", "shared", "Start id-b").unwrap();
            sent.send(()).unwrap();
        });
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(a);
    }

    #[test]
    fn computer_operation_is_not_starved_by_later_vm_work() {
        let gate = leak();
        let order = Arc::new(Mutex::new(Vec::new()));
        let a = gate.vm("id-a", "a", "Backup a").unwrap();
        let computer = {
            let order = order.clone();
            thread::spawn(move || {
                let _guard = gate.computer("Update").unwrap();
                order.lock().unwrap().push("update");
            })
        };
        wait_until(gate, |queue| queue.waiting.len() == 1);
        let later = {
            let order = order.clone();
            thread::spawn(move || {
                let _guard = gate.vm("id-b", "b", "Start b").unwrap();
                order.lock().unwrap().push("start b");
            })
        };
        wait_until(gate, |queue| queue.waiting.len() == 2);
        drop(a);
        computer.join().unwrap();
        later.join().unwrap();
        assert_eq!(*order.lock().unwrap(), ["update", "start b"]);
    }

    #[test]
    fn unrelated_vm_bypasses_a_waiter_for_another_vm() {
        let gate = leak();
        let a = gate.vm("id-a", "a", "Backup a").unwrap();
        let waiter = thread::spawn(move || drop(gate.vm("id-a", "a", "Stop a").unwrap()));
        wait_until(gate, |queue| queue.waiting.len() == 1);
        assert!(elsewhere(move || gate.vm("id-b", "b", "Stop b").is_ok()));
        drop(a);
        waiter.join().unwrap();
    }

    #[test]
    fn identical_waiting_request_is_rejected() {
        let gate = leak();
        let running = gate.computer("Edit").unwrap();
        let key = Some("vm:id-a:start".to_owned());
        let first = {
            let key = key.clone();
            thread::spawn(move || {
                drop(
                    gate.acquire(Scope::Vm { id: "id-a".into() }, Some("a".into()), "Start a", key)
                        .unwrap(),
                )
            })
        };
        wait_until(gate, |queue| queue.waiting.len() == 1);
        assert_eq!(
            elsewhere(move || gate
                .acquire(Scope::Vm { id: "id-a".into() }, Some("a".into()), "Start a", key)
                .unwrap_err()),
            GateError::AlreadyQueued
        );
        drop(running);
        first.join().unwrap();
    }

    #[test]
    fn nested_acquire_fails_instead_of_deadlocking() {
        let gate = leak();
        let _outer = gate.vm("id-a", "a", "Fork a").unwrap();
        assert_eq!(gate.computer("Inner").unwrap_err(), GateError::Nested);
        assert_eq!(gate.vm("id-b", "b", "Inner").unwrap_err(), GateError::Nested);
    }

    #[test]
    fn try_acquire_skips_busy_and_waiting_work() {
        let gate = leak();
        let a = gate.vm("id-a", "a", "Start a").unwrap();
        assert_eq!(elsewhere(move || gate.try_computer("Reclaim").unwrap_err()), GateError::Busy);
        assert!(elsewhere(move || gate.try_vm("id-b", "b", "Sync b").is_ok()));
        assert_eq!(elsewhere(move || gate.try_vm("id-a", "a", "Sync a").unwrap_err()), GateError::Busy);
        assert!(!gate.is_vm_idle("id-a"));
        assert!(gate.is_vm_idle("id-b"));
        drop(a);
        assert!(elsewhere(move || gate.try_computer("Reclaim").is_ok()));
    }

    #[test]
    fn abandoned_waiter_leaves_the_queue_and_unblocks_later_work() {
        let gate = leak();
        let running = gate.computer("Update").unwrap();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let waiter = {
            let cancelled = cancelled.clone();
            thread::spawn(move || {
                gate.acquire_while(Scope::Computer, None, "Backup", &|| !cancelled.load(Ordering::SeqCst))
                    .unwrap_err()
            })
        };
        wait_until(gate, |queue| queue.waiting.len() == 1);
        cancelled.store(true, Ordering::SeqCst);
        assert_eq!(waiter.join().unwrap(), GateError::Abandoned);
        assert!(gate.snapshot().waiting.is_empty());
        drop(running);
        assert!(gate.is_idle());
    }

    #[test]
    fn listener_observes_changes() {
        let gate = leak();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        gate.set_listener(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        });
        drop(gate.computer("Edit").unwrap());
        assert!(calls.load(Ordering::SeqCst) >= 2);
        assert!(gate.oldest_running().is_none());
    }
}
