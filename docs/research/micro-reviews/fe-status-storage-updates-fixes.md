# Status, storage, and updates fix-loop findings

Scope: `app/SiloUI/src/features/status-bar/`, `app/SiloUI/src/features/storage/`, and `app/SiloUI/src/features/updates/`.

The initial two findings are recorded in the shared review worktree's `fe-status-storage-updates.md`. This file records additional defects reproduced during the isolated fix loop. Tests use frontend fixtures; no app or VM was launched.

## fe-status-storage-updates-3: Failed backup listener has no visible recovery

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/storage/pre-upgrade-backup.tsx:87`; `app/SiloUI/src/features/storage/storage-section.tsx:46`.
- **Trigger:** Backup event-listener registration rejects while the initial backup read succeeds.
- **Consequence:** Only a console message reports the failure. Storage continues to show a backup after automatic deletion because there is no registered listener, polling, or visible Retry action. A failed later read is also hidden when a last-known backup exists.
- **Evidence:** The regression test `reports a failed backup listener and reconnects it through Retry` failed because no alert appeared. The previous hook caught registration failure only with `console.error`; the section rendered errors and Retry only when no backup was present.
- **Suggested fix:** Keep subscription failure distinct from read failure, show it beside last-known backup data, and let Retry register the listener again before reconciling state.
- **Regression test:** Reject registration once, retain the visible backup with an alert, click Retry, then delete through the backend. Assert the registered event removes Storage without a remount.
