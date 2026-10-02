# Status bar, storage, and updates micro-review

Scope: `app/SiloUI/src/features/status-bar/`, `app/SiloUI/src/features/storage/`, and `app/SiloUI/src/features/updates/`.

Read-only source review. No tests or builds ran. Checked the first, second, and available third-pass review reports for duplicates. No additional concrete defect found in the status-bar scope.

## fe-status-storage-updates-1: Focus refresh hides a failed update subscription without repairing it

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/updates/update-store.tsx:80` (also lines 61–71 and 90–95).
- **Trigger:** Initial `backend.subscribe()` rejects. Before using Retry, the user leaves and returns to the window. The focus handler successfully reads an idle update snapshot.
- **Evidence:** Subscription failure sets `connectionError`, but only a backend change or `reconnect()` reruns the subscription effect. The independent focus read stores the snapshot and clears that error at line 84 without registering a listener. Idle snapshots have no polling timer. In `updates.tsx`, Retry calls `reconnect()` only when there is no snapshot; once the focus read supplies one, that recovery path is gone. The desktop backend subscribes to `silo://update-state`; native automatic checks publish their results through that event.
- **Consequence:** The UI looks connected while automatic update discovery no longer updates the card or notice. Intermediate download progress is also unobserved. A later focus read or remount restores displayed state, but focus reads never repair the listener.
- **Suggested fix:** Track subscription health separately from snapshot-read health. Retry failed registration and retain its recovery action until registration succeeds; a successful read must not mark the event connection healthy.
- **Test that would catch it:** Reject the first subscription, dispatch focus, and resolve `read()` with an idle snapshot. Assert subscription recovery remains available or registration retries. Complete registration, emit an available-version event, and assert the update notice appears without another focus or manual check.

## fe-status-storage-updates-2: Initial backup read races listener registration and can retain a deleted backup

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/storage/pre-upgrade-backup.tsx:82` (also line 86).
- **Trigger:** Listener registration remains pending while the initial read returns an existing backup. Automatic cleanup deletes that backup and emits its change event before the listener has registered. Registration then finishes.
- **Evidence:** `backend.subscribe()` and `refresh.current()` start independently. The subscription continuation only saves the unsubscribe function; it performs no reconciliation read. After mount, reads occur only through received events, explicit Retry, or failed local removal. The native hourly cleanup emits `silo://pre-upgrade-backup-changed` once after deletion (`src-tauri/src/pre_upgrade_backup.rs:425`). `StorageSection` offers Retry only when no backup is displayed. If measurement observes deletion, it sets size to `unavailable` rather than clearing the backup.
- **Consequence:** Storage retains the deleted backup's date and Show/Delete controls until remount or another change event. Show targets a folder that no longer exists, and the displayed backup no longer provides the recovery copy it claims to show.
- **Suggested fix:** Register the listener before the initial read, or perform a generation-protected reconciliation read after registration completes. Surface registration failure with a usable recovery path rather than logging it alone.
- **Test that would catch it:** Hold subscription registration unresolved; let the initial read return a backup; delete it before completing registration so the event is missed; then resolve registration and make subsequent reads return null. Assert the Storage section disappears without remounting or manually deleting again.
