//! Ordered admission for operations that change VM runtime state on this computer.
//!
//! Callers wait their turn instead of failing with "busy". Work on different VMs
//! runs concurrently; computer-wide work waits for everything else. Admission is
//! first-come, first-served among conflicting requests, so a waiting computer-wide
//! operation is never starved by a stream of per-VM operations.
//!
//! This is the sole in-process gate for VM-changing work. It does not replace the
//! OS file lock that coordinates cooperating runtime processes, nor short data locks.
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// The operation was cancelled by the user (while waiting or, if cancellable, while running).
    Cancelled,
    /// A running operation was asked to cancel but is not marked cancellable.
    NotCancellable,
}

impl std::fmt::Display for GateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyQueued => "This action is already waiting to run.",
            Self::Nested => "Sandbox operation ordering failed.",
            Self::Busy => "Another sandbox operation is still running.",
            Self::Abandoned => "The operation stopped waiting for its turn.",
            Self::Cancelled => "The operation was cancelled.",
            Self::NotCancellable => "This operation can't be cancelled.",
        })
    }
}

impl std::error::Error for GateError {}

/// What an operation is, so observers never parse its display label.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationKind {
    /// Start, stop, restart, or dismiss-error on one sandbox, or a host-wide start.
    Lifecycle,
    CheckpointCapture,
    CheckpointRestore,
    CheckpointFork,
    Export,
    Import,
    StorageReclaim,
    GithubApply,
    Push,
    PortPublish,
    PortRemove,
    /// Stopping local VMs for quit or update.
    Shutdown,
    #[default]
    Other,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationEntry {
    pub id: u64,
    pub label: String,
    pub kind: OperationKind,
    /// Stable VM id this operation is scoped to; `None` for computer-wide operations.
    pub vm_id: Option<String>,
    /// VM display name captured when the operation was admitted; `None` for
    /// computer-wide operations. For display only — ordering keys on `vm_id`.
    pub vm_name: Option<String>,
    /// Milliseconds since the Unix epoch when the operation started running or began waiting.
    pub since_ms: u64,
    /// Whether the user may cancel this operation now. Waiting entries are always
    /// cancellable; a running entry is cancellable only when its work opted in.
    pub cancellable: bool,
    /// Expected maximum duration in milliseconds, used to flag slow operations.
    /// `None` when the operation carried no expectation.
    pub expected_ms: Option<u64>,
    /// True for a waiting entry whose turn is currently held up by internal background
    /// maintenance that is itself hidden from this queue. Lets the UI explain the wait
    /// without naming an operation the user never started. Always false for running entries.
    #[serde(default)]
    pub blocked_by_hidden: bool,
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
    kind: OperationKind,
    key: Option<String>,
    since: Instant,
    since_ms: u64,
    /// True while an operation runs longer than its owner opted to allow cancelling.
    /// Waiting entries report `true` regardless; a running entry reports this flag.
    cancellable: bool,
    /// Set true when a cancel is requested: for a waiting entry it makes the waiter
    /// leave the queue with `Cancelled`; for a cancellable running entry the working
    /// code observes it and stops. Shared with the guard so other threads can read it.
    cancel: Arc<AtomicBool>,
    /// Expected maximum duration, for stuck-operation flagging in the UI.
    expected: Option<Duration>,
    /// Internal background housekeeping that must not surface in the published queue
    /// snapshot. It still holds the gate for mutual exclusion; only its visibility differs.
    hidden: bool,
}

impl Entry {
    fn public(&self, running: bool) -> OperationEntry {
        OperationEntry {
            id: self.id,
            label: self.label.clone(),
            kind: self.kind,
            vm_id: match &self.scope {
                Scope::Computer => None,
                Scope::Vm { id } => Some(id.clone()),
            },
            vm_name: self.vm_name.clone(),
            since_ms: self.since_ms,
            // Waiting entries can always be cancelled; running entries only when opted in.
            cancellable: if running { self.cancellable } else { true },
            expected_ms: self.expected.map(|value| value.as_millis() as u64),
            // Set per waiting entry in `snapshot`, where the full queue is visible.
            blocked_by_hidden: false,
        }
    }
}

#[derive(Default)]
struct State {
    next_id: u64,
    running: Vec<Entry>,
    waiting: VecDeque<Entry>,
    /// Bumped whenever a visible computer-wide entry is queued, starts, or finishes.
    computer_generation: u64,
    /// Same, for entries scoped to one VM. Absent means never touched.
    vm_generations: BTreeMap<String, u64>,
}

impl State {
    /// Record that an operation touched `scope`, so observers can tell a state change
    /// was caused by Silo. Hidden housekeeping is not attributed.
    fn touch(&mut self, scope: &Scope, hidden: bool) {
        if hidden {
            return;
        }
        match scope {
            Scope::Computer => self.computer_generation += 1,
            Scope::Vm { id } => *self.vm_generations.entry(id.clone()).or_default() += 1,
        }
    }

    fn generation(&self, id: &str) -> u64 {
        self.computer_generation + self.vm_generations.get(id).copied().unwrap_or_default()
    }

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

    fn entry(
        &mut self,
        scope: Scope,
        vm_name: Option<String>,
        kind: OperationKind,
        label: &str,
        key: Option<String>,
    ) -> Entry {
        self.next_id += 1;
        Entry {
            id: self.next_id,
            scope,
            vm_name,
            label: label.to_owned(),
            kind,
            key,
            since: Instant::now(),
            since_ms: now_ms(),
            cancellable: false,
            cancel: Arc::new(AtomicBool::new(false)),
            expected: None,
            hidden: false,
        }
    }
}

pub(crate) struct OperationGate {
    state: Mutex<State>,
    changed: Condvar,
    listener: OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// Count of finished visible operations, for observers that sleep until activity.
    activity: Mutex<u64>,
    activity_changed: Condvar,
}

/// A copy of the gate's generation counters. Compares equal to a later
/// `OperationGate::generation` only if nothing touched the VM in between.
pub(crate) struct Generations {
    computer: u64,
    vms: BTreeMap<String, u64>,
}

impl Generations {
    pub(crate) fn of(&self, id: &str) -> u64 {
        self.computer + self.vms.get(id).copied().unwrap_or_default()
    }
}

/// The gate with the operation kind fixed, so the kind is known at admission.
#[derive(Clone, Copy)]
pub(crate) struct Kinded<'a> {
    gate: &'a OperationGate,
    kind: OperationKind,
}

impl<'a> Kinded<'a> {
    pub(crate) fn computer(&self, label: &str) -> Result<OperationGuard<'a>, GateError> {
        self.acquire(Scope::Computer, None, label, None)
    }

    pub(crate) fn vm(&self, id: &str, name: &str, label: &str) -> Result<OperationGuard<'a>, GateError> {
        self.acquire(Scope::Vm { id: id.to_owned() }, Some(name.to_owned()), label, None)
    }

    pub(crate) fn acquire(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
        key: Option<String>,
    ) -> Result<OperationGuard<'a>, GateError> {
        self.gate.acquire_inner(scope, vm_name, self.kind, label, key, None)
    }

    pub(crate) fn acquire_while(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
        keep_waiting: &dyn Fn() -> bool,
    ) -> Result<OperationGuard<'a>, GateError> {
        self.gate.acquire_inner(scope, vm_name, self.kind, label, None, Some(keep_waiting))
    }
}

thread_local! {
    static HELD: Cell<usize> = const { Cell::new(0) };
    /// Cancel token of the operation the current thread is executing, set while its
    /// guard is held and cleared on drop. Nesting is rejected, so at most one is set.
    static CURRENT: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
    /// Depth of `uncancellable` sections on this thread.
    static MASKED: Cell<usize> = const { Cell::new(0) };
}

/// Run `work` with cancellation masked: a cancel requested meanwhile is not
/// observed (children are not killed) until `work` returns, and is then honoured
/// at the next check. Used for steps such as `msb stop` that must not be cut short.
pub(crate) fn uncancellable<T>(work: impl FnOnce() -> T) -> T {
    struct Unmask;
    impl Drop for Unmask {
        fn drop(&mut self) { MASKED.with(|masked| masked.set(masked.get() - 1)); }
    }
    MASKED.with(|masked| masked.set(masked.get() + 1));
    let _unmask = Unmask;
    work()
}

/// True when the operation running on this thread has been asked to cancel. Only ever
/// true for operations that opted in with `OperationGuard::allow_cancel`.
pub(crate) fn cancel_requested() -> bool {
    if MASKED.with(Cell::get) > 0 { return false; }
    CURRENT.with(|current| {
        current
            .borrow()
            .as_ref()
            .is_some_and(|token| token.load(Ordering::SeqCst))
    })
}

/// `Err(GateError::Cancelled)` when the current thread's operation was asked to cancel.
pub(crate) fn check_cancelled() -> Result<(), GateError> {
    if cancel_requested() {
        Err(GateError::Cancelled)
    } else {
        Ok(())
    }
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
                computer_generation: 0,
                vm_generations: BTreeMap::new(),
            }),
            changed: Condvar::new(),
            listener: OnceLock::new(),
            activity: Mutex::new(0),
            activity_changed: Condvar::new(),
        }
    }

    /// Fix the operation kind for the entries this request creates.
    pub(crate) fn kind(&self, kind: OperationKind) -> Kinded<'_> {
        Kinded { gate: self, kind }
    }

    /// A counter that changes whenever an operation touching this VM (or computer-wide
    /// state, which touches every VM) was queued, started, or finished. Equal values
    /// before and after mean no Silo operation affected the VM in between.
    pub(crate) fn generation(&self, id: &str) -> u64 {
        self.lock().generation(id)
    }

    /// Every VM's generation right now, for comparing across a slow read.
    pub(crate) fn generations(&self) -> Generations {
        let state = self.lock();
        Generations {
            computer: state.computer_generation,
            vms: state.vm_generations.clone(),
        }
    }

    /// Current activity counter; advances each time a visible operation finishes.
    pub(crate) fn activity(&self) -> u64 {
        *self.activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sleep until the activity counter differs from `seen` or `timeout` elapses, and
    /// return the current counter. Lets observers act soon after work finishes.
    pub(crate) fn wait_for_activity(&self, seen: u64, timeout: Duration) -> u64 {
        let guard = self.activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (guard, _) = self
            .activity_changed
            .wait_timeout_while(guard, timeout, |current| *current == seen)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard
    }

    fn signal_activity(&self) {
        *self.activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
        self.activity_changed.notify_all();
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
        self.kind(OperationKind::Other).computer(label)
    }

    /// Wait for a turn to change one VM, identified by its stable `id`. `name` is the
    /// current display name captured for the queue; ordering keys on `id` alone.
    pub(crate) fn vm(&self, id: &str, name: &str, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.kind(OperationKind::Other).vm(id, name, label)
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
        self.acquire_inner(scope, vm_name, OperationKind::Other, label, key, None)
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
        self.acquire_inner(scope, vm_name, OperationKind::Other, label, None, Some(keep_waiting))
    }

    fn acquire_inner(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        kind: OperationKind,
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
        let entry = state.entry(scope, vm_name, kind, label, key);
        let id = entry.id;
        state.touch(&entry.scope, false);
        state.waiting.push_back(entry);
        drop(state);
        self.notify();
        let mut state = self.lock();
        let token = loop {
            let index = state
                .waiting
                .iter()
                .position(|entry| entry.id == id)
                .expect("a waiting operation is removed only when admitted");
            // A cancel while waiting removes this entry and reports it to the caller.
            if state.waiting[index].cancel.load(Ordering::SeqCst) {
                state.waiting.remove(index);
                drop(state);
                self.notify();
                return Err(GateError::Cancelled);
            }
            if state.admissible(index) {
                let mut entry = state.waiting.remove(index).expect("index is in range");
                entry.since = Instant::now();
                entry.since_ms = now_ms();
                let token = entry.cancel.clone();
                state.touch(&entry.scope, false);
                state.running.push(entry);
                break token;
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
        };
        drop(state);
        HELD.with(|held| held.set(held.get() + 1));
        CURRENT.with(|current| *current.borrow_mut() = Some(token.clone()));
        self.notify();
        Ok(OperationGuard { gate: self, id, token, _thread_bound: std::marker::PhantomData })
    }

    /// Run only when nothing conflicting is running or waiting. For background work
    /// that should skip busy periods rather than accumulate.
    pub(crate) fn try_acquire(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
    ) -> Result<OperationGuard<'_>, GateError> {
        self.try_acquire_inner(scope, vm_name, label, false)
    }

    fn try_acquire_inner(
        &self,
        scope: Scope,
        vm_name: Option<String>,
        label: &str,
        hidden: bool,
    ) -> Result<OperationGuard<'_>, GateError> {
        if HELD.with(Cell::get) > 0 {
            return Err(GateError::Nested);
        }
        let mut state = self.lock();
        if !state.free(&scope) {
            return Err(GateError::Busy);
        }
        let mut entry = state.entry(scope, vm_name, OperationKind::Other, label, None);
        entry.hidden = hidden;
        let id = entry.id;
        let token = entry.cancel.clone();
        state.touch(&entry.scope, hidden);
        state.running.push(entry);
        drop(state);
        HELD.with(|held| held.set(held.get() + 1));
        CURRENT.with(|current| *current.borrow_mut() = Some(token.clone()));
        self.notify();
        Ok(OperationGuard { gate: self, id, token, _thread_bound: std::marker::PhantomData })
    }

    pub(crate) fn try_computer(&self, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.try_acquire(Scope::Computer, None, label)
    }

    /// Like `try_computer`, but for internal background housekeeping: the operation still
    /// holds the gate for mutual exclusion, yet never appears in the published queue
    /// snapshot, so opportunistic maintenance cannot flash a status in the UI.
    pub(crate) fn try_computer_hidden(&self, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.try_acquire_inner(Scope::Computer, None, label, true)
    }

    /// Like `try_vm`, but hidden from the published queue snapshot (see `try_computer_hidden`).
    pub(crate) fn try_vm_hidden(&self, id: &str, name: &str, label: &str) -> Result<OperationGuard<'_>, GateError> {
        self.try_acquire_inner(Scope::Vm { id: id.to_owned() }, Some(name.to_owned()), label, true)
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

    /// True when no visible computer-wide operation is running or waiting. Hidden
    /// housekeeping and per-VM work never add or remove sandboxes, so state readers
    /// use this instead of `is_idle` and keep other sandboxes' rows current.
    pub(crate) fn is_computer_idle(&self) -> bool {
        let state = self.lock();
        !state.running.iter().chain(state.waiting.iter())
            .any(|entry| !entry.hidden && matches!(entry.scope, Scope::Computer))
    }

    /// True when no operation affecting the VM with stable `id` is running or waiting.
    pub(crate) fn is_vm_idle(&self, id: &str) -> bool {
        self.lock().free(&Scope::Vm { id: id.to_owned() })
    }

    /// True when no visible operation other than the calling thread's own is running or
    /// waiting for the VM with stable `id` (computer-wide work affects every VM). State
    /// readers use this to decide whether a VM's reading is settled: hidden housekeeping
    /// never makes a reading stale, and work reading state after its own change is not
    /// waiting on itself.
    pub(crate) fn is_vm_quiet(&self, id: &str) -> bool {
        let scope = Scope::Vm { id: id.to_owned() };
        let own = CURRENT.with(|current| current.borrow().clone());
        let state = self.lock();
        !state.running.iter().chain(state.waiting.iter()).any(|entry| {
            !entry.hidden
                && entry.scope.conflicts(&scope)
                && !own.as_ref().is_some_and(|token| Arc::ptr_eq(token, &entry.cancel))
        })
    }

    /// The queue as the UI sees it. Hidden internal-housekeeping entries are excluded, but
    /// they still gate real work: a visible waiter held up only by a hidden entry is flagged
    /// with `blocked_by_hidden` so the UI can explain the wait generically.
    pub(crate) fn snapshot(&self) -> OperationQueue {
        let state = self.lock();
        let running = state
            .running
            .iter()
            .filter(|entry| !entry.hidden)
            .map(|entry| entry.public(true))
            .collect();
        let waiting = state
            .waiting
            .iter()
            .enumerate()
            .filter(|(_, entry)| !entry.hidden)
            .map(|(index, entry)| {
                let mut public = entry.public(false);
                // A hidden running entry, or a hidden earlier waiter, that conflicts with
                // this waiter is holding up its turn without appearing in the queue.
                public.blocked_by_hidden = state
                    .running
                    .iter()
                    .any(|other| other.hidden && other.scope.conflicts(&entry.scope))
                    || state
                        .waiting
                        .iter()
                        .take(index)
                        .any(|other| other.hidden && other.scope.conflicts(&entry.scope));
                public
            })
            .collect();
        OperationQueue { running, waiting }
    }

    /// Ask to cancel the operation with `id`.
    ///
    /// A *waiting* entry is signalled to leave the queue; its waiter returns
    /// `GateError::Cancelled`. A *running* entry is signalled only when it opted in as
    /// cancellable (`OperationGuard::allow_cancel`); otherwise `GateError::NotCancellable`
    /// is returned and nothing changes. An unknown id is treated as already finished.
    pub(crate) fn cancel(&self, id: u64) -> Result<(), GateError> {
        let mut state = self.lock();
        if let Some(entry) = state.waiting.iter().find(|entry| entry.id == id) {
            entry.cancel.store(true, Ordering::SeqCst);
            drop(state);
            // Wake the waiter so it observes the flag and leaves the queue.
            self.notify();
            return Ok(());
        }
        if let Some(entry) = state.running.iter().find(|entry| entry.id == id) {
            if !entry.cancellable {
                return Err(GateError::NotCancellable);
            }
            entry.cancel.store(true, Ordering::SeqCst);
            drop(state);
            self.notify();
            return Ok(());
        }
        Ok(())
    }

    /// Signal every waiting entry to leave the queue with `GateError::Cancelled`.
    /// Running work is left untouched. Used by Quit: once admission is refused a
    /// waiter would only be rejected when its turn came, so it is cancelled at once.
    pub(crate) fn cancel_all_waiting(&self) {
        let mut state = self.lock();
        if state.waiting.is_empty() {
            return;
        }
        for entry in state.waiting.iter() {
            entry.cancel.store(true, Ordering::SeqCst);
        }
        drop(state);
        // Wake every waiter so it observes the flag and leaves the queue.
        self.notify();
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
        let finished = state.running.iter().find(|entry| entry.id == id).map(|entry| (entry.scope.clone(), entry.hidden));
        state.running.retain(|entry| entry.id != id);
        if let Some((scope, hidden)) = &finished {
            state.touch(scope, *hidden);
        }
        drop(state);
        HELD.with(|held| held.set(held.get().saturating_sub(1)));
        CURRENT.with(|current| *current.borrow_mut() = None);
        if finished.is_some_and(|(_, hidden)| !hidden) {
            self.signal_activity();
        }
        self.notify();
    }

    /// Mark a running operation cancellable and record it in the queue. Used by
    /// `OperationGuard::allow_cancel`.
    fn mark_cancellable(&self, id: u64) {
        let mut state = self.lock();
        if let Some(entry) = state.running.iter_mut().find(|entry| entry.id == id) {
            entry.cancellable = true;
        }
        drop(state);
        self.notify();
    }

    /// Record the expected maximum duration of a running operation for stuck reporting.
    fn set_expected(&self, id: u64, expected: Duration) {
        let mut state = self.lock();
        if let Some(entry) = state.running.iter_mut().find(|entry| entry.id == id) {
            entry.expected = Some(expected);
        }
        drop(state);
        self.notify();
    }

    /// Point a running operation's cancel flag at an externally owned one, so a subsystem
    /// with its own cancellation (for example backups) and the gate agree on one bit.
    fn replace_token(&self, id: u64, token: Arc<AtomicBool>) {
        let mut state = self.lock();
        if let Some(entry) = state.running.iter_mut().find(|entry| entry.id == id) {
            // Preserve an already-requested cancel across the swap.
            if entry.cancel.load(Ordering::SeqCst) {
                token.store(true, Ordering::SeqCst);
            }
            entry.cancel = token;
        }
        drop(state);
    }
}

/// Held for the duration of one operation, including all of its internal steps.
#[must_use = "the operation ends when the guard is dropped"]
pub(crate) struct OperationGuard<'a> {
    gate: &'a OperationGate,
    id: u64,
    /// Shared cancel flag for this operation. Cloneable so work on other threads
    /// (spawn_blocking, std::thread::spawn) can observe cancellation explicitly.
    token: Arc<AtomicBool>,
    /// Nesting is tracked per thread, so a guard must be released where it was taken.
    _thread_bound: std::marker::PhantomData<*const ()>,
}

impl OperationGuard<'_> {
    /// Allow the user to cancel this operation while it runs. The work must observe
    /// cancellation via `operation_gate::check_cancelled`/`cancel_requested` (same
    /// thread) or the token from `cancel_token` (other threads); nothing is force-killed
    /// except child processes in the runtime polling loops.
    pub(crate) fn allow_cancel(&self) {
        self.gate.mark_cancellable(self.id);
    }

    /// Declare the expected maximum duration so the UI can flag the operation as slow.
    pub(crate) fn expect_within(&self, expected: Duration) {
        self.gate.set_expected(self.id, expected);
    }

    /// A cloneable handle to this operation's cancel flag, for passing to work that runs
    /// on other threads where the thread-local current-operation token is not set.
    pub(crate) fn cancel_token(&self) -> Arc<AtomicBool> {
        self.token.clone()
    }

    /// Share an externally owned cancel flag with this operation, so a cancel through
    /// either the gate or the owning subsystem flips the same bit. Used by backups.
    pub(crate) fn adopt_cancel_token(&mut self, token: Arc<AtomicBool>) {
        self.gate.replace_token(self.id, token.clone());
        // Keep the thread-local current-operation token in sync so `cancel_requested`
        // and `check_cancelled` observe the shared flag on this thread.
        CURRENT.with(|current| *current.borrow_mut() = Some(token.clone()));
        self.token = token;
    }
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

    #[test]
    fn cancelling_a_waiting_entry_makes_its_waiter_return_cancelled() {
        let gate = leak();
        let running = gate.computer("Update").unwrap();
        let waiter = thread::spawn(move || gate.computer("Backup").unwrap_err());
        wait_until(gate, |queue| queue.waiting.len() == 1);
        let waiting_id = gate.snapshot().waiting[0].id;
        // Waiting entries always report themselves as cancellable.
        assert!(gate.snapshot().waiting[0].cancellable);
        gate.cancel(waiting_id).unwrap();
        assert_eq!(waiter.join().unwrap(), GateError::Cancelled);
        assert!(gate.snapshot().waiting.is_empty());
        drop(running);
        assert!(gate.is_idle());
    }

    #[test]
    fn cancel_all_waiting_cancels_every_waiter_and_leaves_running_work() {
        let gate = leak();
        // One running entry that must be left untouched.
        let running = gate.computer("Exporting sandbox").unwrap();
        let first = thread::spawn(move || gate.vm("id-a", "a", "Stop a").unwrap_err());
        wait_until(gate, |queue| queue.waiting.len() == 1);
        let second = thread::spawn(move || gate.vm("id-b", "b", "Stop b").unwrap_err());
        wait_until(gate, |queue| queue.waiting.len() == 2);
        gate.cancel_all_waiting();
        assert_eq!(first.join().unwrap(), GateError::Cancelled);
        assert_eq!(second.join().unwrap(), GateError::Cancelled);
        let queue = gate.snapshot();
        assert!(queue.waiting.is_empty());
        assert_eq!(queue.running.len(), 1);
        assert_eq!(queue.running[0].label, "Exporting sandbox");
        drop(running);
        assert!(gate.is_idle());
    }

    #[test]
    fn cancelling_a_cancellable_running_entry_kills_its_child() {
        let gate = leak();
        let (ready, started) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        thread::spawn(move || {
            let guard = gate.vm("id-a", "a", "Starting a").unwrap();
            guard.allow_cancel();
            // Stand in for a runtime child: a long sleep that a polling loop kills when
            // the current operation is cancel-requested, exactly like run_msb_process.
            let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
            ready.send(child.id()).unwrap();
            let killed = loop {
                if cancel_requested() {
                    let _ = child.kill();
                    let _ = child.wait();
                    break true;
                }
                if child.try_wait().unwrap().is_some() {
                    break false;
                }
                thread::sleep(Duration::from_millis(5));
            };
            done.send(killed).unwrap();
        });
        let _child_pid = started.recv_timeout(Duration::from_secs(5)).unwrap();
        wait_until(gate, |queue| queue.running.iter().any(|entry| entry.cancellable));
        let running_id = gate.snapshot().running[0].id;
        gate.cancel(running_id).unwrap();
        assert!(finished.recv_timeout(Duration::from_secs(5)).unwrap());
    }

    #[test]
    fn uncancellable_section_defers_a_cancel_until_it_returns() {
        let gate = leak();
        let guard = gate.vm("id-a", "a", "Restarting a").unwrap();
        guard.allow_cancel();
        gate.cancel(gate.snapshot().running[0].id).unwrap();
        assert!(!uncancellable(cancel_requested));
        assert!(cancel_requested());
        drop(guard);
    }

    #[test]
    fn cancelling_a_non_cancellable_running_entry_is_rejected() {
        let gate = leak();
        let running = gate.computer("Stopping").unwrap();
        let id = gate.snapshot().running[0].id;
        assert!(!gate.snapshot().running[0].cancellable);
        assert_eq!(gate.cancel(id).unwrap_err(), GateError::NotCancellable);
        drop(running);
    }

    #[test]
    fn hidden_housekeeping_is_excluded_from_the_snapshot_but_still_exclusive() {
        let gate = leak();
        // A hidden background reconcile holds the computer gate but never surfaces.
        let housekeeping = gate.try_computer_hidden("Reconciling SSH access").unwrap();
        let snapshot = gate.snapshot();
        assert!(snapshot.running.is_empty(), "hidden entry must not appear in the queue");
        assert!(snapshot.waiting.is_empty());
        // It is not idle, though: a conflicting try still finds the gate busy.
        assert!(!gate.is_idle());
        assert_eq!(elsewhere(move || gate.try_computer("Reclaim").unwrap_err()), GateError::Busy);
        drop(housekeeping);
        assert!(gate.is_idle());
        assert!(elsewhere(move || gate.try_computer("Reclaim").is_ok()));
    }

    #[test]
    fn a_visible_waiter_blocked_only_by_hidden_work_is_flagged() {
        let gate = leak();
        // Hidden computer-wide housekeeping is running.
        let housekeeping = gate.try_computer_hidden("Cleaning up expired logs").unwrap();
        // A user-initiated per-VM operation arrives and must wait behind it.
        let waiter = thread::spawn(move || drop(gate.vm("id-a", "a", "Start a").unwrap()));
        wait_until(gate, |queue| {
            // The waiter is visible; the hidden blocker is not, so it is flagged instead.
            queue.waiting.len() == 1 && queue.waiting[0].label == "Start a" && queue.waiting[0].blocked_by_hidden
        });
        assert!(gate.snapshot().running.is_empty(), "the hidden blocker stays out of the queue");
        drop(housekeeping);
        waiter.join().unwrap();
        assert!(gate.is_idle());
    }

    #[test]
    fn a_waiter_blocked_by_visible_work_is_not_flagged_as_hidden() {
        let gate = leak();
        let visible = gate.computer("Updating").unwrap();
        let waiter = thread::spawn(move || drop(gate.vm("id-a", "a", "Start a").unwrap()));
        wait_until(gate, |queue| queue.waiting.len() == 1 && queue.waiting[0].label == "Start a");
        assert!(!gate.snapshot().waiting[0].blocked_by_hidden);
        drop(visible);
        waiter.join().unwrap();
    }

    #[test]
    fn expected_duration_is_reported_in_the_queue() {
        let gate = leak();
        let guard = gate.computer("Working").unwrap();
        guard.expect_within(Duration::from_secs(120));
        assert_eq!(gate.snapshot().running[0].expected_ms, Some(120_000));
        drop(guard);
    }

    #[test]
    fn kinds_are_known_while_waiting_and_serialize_camel_case() {
        let gate = leak();
        let first = gate.kind(OperationKind::Lifecycle).vm("id-a", "a", "Start a").unwrap();
        let waiter = thread::spawn(move || {
            drop(gate.kind(OperationKind::CheckpointCapture).vm("id-a", "a", "Creating checkpoint").unwrap());
        });
        wait_until(gate, |queue| queue.waiting.len() == 1);
        let queue = gate.snapshot();
        assert_eq!(queue.running[0].kind, OperationKind::Lifecycle);
        assert_eq!(queue.waiting[0].kind, OperationKind::CheckpointCapture);
        let json = serde_json::to_value(&queue).unwrap();
        assert_eq!(json["running"][0]["kind"], "lifecycle");
        assert_eq!(json["waiting"][0]["kind"], "checkpointCapture");
        drop(first);
        waiter.join().unwrap();
        let other = gate.computer("Anything").unwrap();
        assert_eq!(serde_json::to_value(gate.snapshot()).unwrap()["running"][0]["kind"], "other");
        drop(other);
        for (kind, name) in [
            (OperationKind::CheckpointRestore, "checkpointRestore"),
            (OperationKind::CheckpointFork, "checkpointFork"),
            (OperationKind::StorageReclaim, "storageReclaim"),
            (OperationKind::GithubApply, "githubApply"),
            (OperationKind::PortPublish, "portPublish"),
            (OperationKind::PortRemove, "portRemove"),
            (OperationKind::Shutdown, "shutdown"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }
    }

    #[test]
    fn generation_changes_when_an_operation_is_queued_runs_or_finishes() {
        let gate = leak();
        let start = gate.generation("id-a");
        let first = gate.vm("id-a", "a", "Start a").unwrap();
        let running = gate.generation("id-a");
        assert_ne!(running, start);
        assert_eq!(gate.generation("id-b"), start.min(gate.generation("id-b")));
        drop(first);
        assert_ne!(gate.generation("id-a"), running);
        let settled = gate.generation("id-a");
        assert_eq!(gate.generation("id-a"), settled, "reading is stable while idle");
    }

    #[test]
    fn a_vm_is_quiet_unless_visible_work_other_than_the_callers_own_touches_it() {
        let gate = leak();
        assert!(gate.is_vm_quiet("id-a"));
        let hidden = gate.try_computer_hidden("Cleaning up expired logs").unwrap();
        assert!(elsewhere(move || gate.is_vm_quiet("id-a")), "hidden housekeeping never settles a VM");
        drop(hidden);
        let own = gate.vm("id-a", "a", "Creating checkpoint").unwrap();
        assert!(gate.is_vm_quiet("id-a"), "a thread reading after its own change");
        assert!(!elsewhere(move || gate.is_vm_quiet("id-a")), "other readers see the VM busy");
        assert!(elsewhere(move || gate.is_vm_quiet("id-b")), "other VMs stay quiet");
        drop(own);
        let change = gate.computer("Applying sandbox changes").unwrap();
        assert!(gate.is_vm_quiet("id-b"));
        assert!(!elsewhere(move || gate.is_vm_quiet("id-b")), "computer-wide work touches every VM");
        drop(change);
    }

    #[test]
    fn a_computer_wide_operation_touches_every_vm_and_hidden_ones_touch_none() {
        let gate = leak();
        let before = gate.generation("id-a");
        drop(gate.computer("Updating").unwrap());
        assert_ne!(gate.generation("id-a"), before);
        let other = gate.generation("id-b");
        let snapshot = gate.generations();
        drop(gate.try_vm("id-a", "a", "Sync a").unwrap());
        assert_eq!(gate.generation("id-b"), other);
        assert_ne!(gate.generation("id-a"), snapshot.of("id-a"));
        assert_eq!(gate.generation("id-b"), snapshot.of("id-b"));
        let stable = gate.generation("id-a");
        drop(gate.try_computer_hidden("Reconciling SSH access").unwrap());
        drop(gate.try_vm_hidden("id-a", "a", "Reconciling ports on a").unwrap());
        assert_eq!(gate.generation("id-a"), stable);
    }

    #[test]
    fn activity_wakes_observers_when_a_visible_operation_finishes() {
        let gate = leak();
        let seen = gate.activity();
        let guard = gate.vm("id-a", "a", "Start a").unwrap();
        assert_eq!(gate.wait_for_activity(seen, Duration::from_millis(20)), seen);
        let waiter = thread::spawn(move || gate.wait_for_activity(seen, Duration::from_secs(5)));
        thread::sleep(Duration::from_millis(20));
        drop(guard);
        assert_ne!(waiter.join().unwrap(), seen);
        let seen = gate.activity();
        drop(gate.try_computer_hidden("Reconciling SSH access").unwrap());
        assert_eq!(gate.activity(), seen);
    }
}
