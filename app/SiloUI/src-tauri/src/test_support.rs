//! Fixtures for native unit tests. Never use product locks to serialize tests.
pub(crate) mod live;

use std::sync::{Mutex, MutexGuard};

static GLOBAL_STATE: Mutex<()> = Mutex::new(());

/// Serializes tests that reach process-wide runtime, GitHub, SSH or secret state.
/// Worker threads belong to their owning test and must be joined before this drops.
pub(crate) fn global_state() -> GlobalStateGuard {
    GlobalStateGuard {
        _guard: GLOBAL_STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()),
    }
}

pub(crate) struct GlobalStateGuard {
    _guard: MutexGuard<'static, ()>,
}
impl Drop for GlobalStateGuard {
    fn drop(&mut self) {
        // Quit tests must reopen admission even when an assertion unwinds.
        crate::runtime::shutdown::cancel();
    }
}
