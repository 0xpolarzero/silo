# Backup controller micro-review

Scope: `app/SiloUI/src-tauri/src/backup_controller.rs` and `app/SiloUI/src-tauri/src/backup_controller/`.

Read-only source review. Compared against the first and second review reports in the main workspace and the third-pass reports in this worktree. No builds, tests, native app, or live data were used.

## BACKUP-CONTROLLER-1: Queued archive inspections lose cancellation

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/backup_controller.rs:542`–`546`, `:619`–`632`.
- **Trigger:** Submit `inspect_backup_archive`, then close the import review while its blocking worker has not started. Registration happens inside `spawn_blocking`, whereas `cancel_backup_inspection` runs immediately and only cancels an already registered request. With no matching registration, it returns false and stores no cancellation. When the queued worker starts, it creates a fresh uncancelled token and checks the archive. The frontend sends this cancellation once from its abort listener (`app/SiloUI/src/desktop/production-source.ts:1797`–`1800`).
- **Consequence:** Closing the review does not stop that inspection: it can continue reading and hashing a large export after the caller has abandoned it. If a newer inspection registers before the older worker starts, the older worker's later registration also cancels the newer request through `view.inspection.replace` (`:599`–`600`). Request age is currently determined by blocking-worker scheduling rather than command admission.
- **Suggested fix:** Allocate the request id and register its cancellation token before dispatching the blocking worker; move only filesystem work into the worker. Preserve command registration order and pass the registered token into the closure.
- **Regression test:** Hold the inspection worker behind a deterministic barrier, cancel after command admission, then release it. Assert the worker observes cancellation before reading the archive. Also admit requests A then B, execute B's worker before A's, and assert A cannot cancel B.
- **Evidence limit:** The scheduling and state transitions are source-confirmed; this review did not execute the interleaving.

## BACKUP-CONTROLLER-2: A delayed cancellation write changes the next transfer's journal

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/backup_controller.rs:1964`–`1969`; `app/SiloUI/src-tauri/src/backup_controller/recovery.rs:728`–`729`.
- **Trigger:** Cancel transfer A. After its in-memory token is cancelled and the view lock is released, suspend that cancellation command before `recovery::cancel`. Let A finish and release `busy`, then start B. `recovery::begin` accepts replacement of A's terminal journal (`recovery.rs:535`–`540`). Resume A's cancellation command: `recovery::cancel` calls `update` on whichever journal is now current, without checking A's operation id (`recovery.rs:543`–`552`). B's journal is consequently written with `cancelled: true`, although B's cancellation token was never cancelled.
- **Consequence:** B's durable state falsely records a user cancellation. If B is interrupted before producing a completed export or committing an import, recovery reports B as cancelled instead of reporting an interrupted operation (`recovery.rs:1270` and `:1306`). This finding establishes incorrect persisted identity and recovery messaging, not deletion of a completed result.
- **Suggested fix:** Capture A's journal identity while holding the view lock and make the persisted cancellation update conditional on that identity still being current. Keep the in-memory cancellation first so filesystem failures cannot prevent cancellation.
- **Regression test:** Pause A's cancellation between token cancellation and journal update, finish A, install B's journal, then resume A's update. Assert B's persisted and in-memory journal remain uncancelled; interrupt B and assert recovery reports interruption.
- **Evidence limit:** The interleaving follows the existing lock boundaries and terminal-journal replacement rule; it was not executed here.
