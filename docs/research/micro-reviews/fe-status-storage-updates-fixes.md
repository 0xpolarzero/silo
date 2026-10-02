# Status, storage, and updates fix-loop findings

Scope: `app/SiloUI/src/features/status-bar/`, `app/SiloUI/src/features/storage/`, and `app/SiloUI/src/features/updates/`.

The initial two findings are recorded in the shared review worktree's `fe-status-storage-updates.md`. This file records additional defects reproduced during the isolated fix loop. Tests use frontend fixtures; no app or VM was launched.

## fe-status-storage-updates-1 follow-up: Repeated focus during listener recovery

The test `keeps a failed update connection visible when focus returns during listener recovery` reproduced the original error-masking defect under a second focus event during registration. That focus started an independent read, which resolved after registration failed again and cleared its error. The provider now tracks connecting, connected, and failed states; focus reads wait for a connected listener, and focus retries failed registration once per attempt.

## fe-status-storage-updates-3: Failed backup listener has no visible recovery

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/storage/pre-upgrade-backup.tsx:87`; `app/SiloUI/src/features/storage/storage-section.tsx:46`.
- **Trigger:** Backup event-listener registration rejects while the initial backup read succeeds.
- **Consequence:** Only a console message reports the failure. Storage continues to show a backup after automatic deletion because there is no registered listener, polling, or visible Retry action. A failed later read is also hidden when a last-known backup exists.
- **Evidence:** The regression test `reports a failed backup listener and reconnects it through Retry` failed because no alert appeared. The previous hook caught registration failure only with `console.error`; the section rendered errors and Retry only when no backup was present.
- **Suggested fix:** Keep subscription failure distinct from read failure, show it beside last-known backup data, and let Retry register the listener again before reconciling state.
- **Regression test:** Reject registration once, retain the visible backup with an alert, click Retry, then delete through the backend. Assert the registered event removes Storage without a remount.

## fe-status-storage-updates-4: Manual installer-page Retry invokes the update checker

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/updates/updates.tsx:32`.
- **Trigger:** A manual installation has an available update, and opening View installers on GitHub rejects. The user clicks the error's Retry button.
- **Consequence:** Retry checks the update feed instead of retrying the browser action. It cannot recover the failed installer-page launch; the original View installers button remains a workaround.
- **Evidence:** The regression test `retries opening manual installers after the release page failed to open` failed with one `openRelease` call where two were required. The fallback Retry branch called `updates.check()` for this state.
- **Suggested fix:** Route Retry to `openRelease()` when the available manual update's action is View installers.
- **Regression test:** Reject the first `openRelease()`, click Retry, and assert the second browser action runs without invoking the update checker or downloader.
