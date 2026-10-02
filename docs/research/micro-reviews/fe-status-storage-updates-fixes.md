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

## fe-status-storage-updates-5: Queued folder reads start after the picker closes

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/status-bar/status-folder-picker.tsx:28`.
- **Trigger:** Rapidly visit several cached folders while three directory requests are pending, then close the picker before one request completes.
- **Consequence:** Queued reads for folders that are no longer visible still invoke the VM directory loader after the picker unmounts. Closing the picker only removes its polling timer and window listeners; it does not cancel queued backend work.
- **Evidence:** The regression test `cancels queued directory reads when the folder picker closes` queued `/workspace/c`, unmounted, completed `/workspace/a`, and observed a new loader call for `/workspace/c`. The directory store already supports canceling queued work through `invalidateWorkspace()`.
- **Suggested fix:** Invalidate the picker's workspace requests on unmount or target replacement. Keep the store reusable through StrictMode's cleanup replay rather than permanently disposing it during that replay.
- **Regression tests:** Navigate cached folders until a read queues, unmount, settle an active read, and assert the queued path is never requested. Under StrictMode, assert folders still load and opening becomes enabled after setup replays.

## fe-status-storage-updates-6: Overlapping backup Retry reports success before deletion finishes

- **Severity:** P2
- **Location:** `app/SiloUI/src/features/storage/pre-upgrade-backup.tsx:110`.
- **Trigger:** A deletion fails and leaves a Retry toast. The user starts another deletion through the row, then clicks the old toast's Retry while that deletion is pending.
- **Consequence:** The duplicate call resolves immediately through the boolean guard, so its operation toast claims the backup was deleted even if the active deletion later fails.
- **Evidence:** `does not report deletion success when an old toast retries an unfinished deletion` reproduced the visible success toast before the deferred backend deletion settled. Only one backend deletion ran.
- **Suggested fix:** Store and return the active deletion promise so every caller waits for the real result, while retaining single backend admission.
- **Regression test:** Fail one deletion, start a deferred second attempt, click the old Retry, and assert no success appears. Reject the active attempt; both callers must report failure and the backup remains visible.

## fe-status-storage-updates-7: Disposed backup observers still read native state during registration

- **Severity:** P3
- **Locations:** `app/SiloUI/src/features/storage/pre-upgrade-backup.tsx:85`; `app/SiloUI/src/features/application/model/transfer-result-notice.ts:68`.
- **Trigger:** The view closes while native listener registration is pending, then the registered handler receives an event before the unsubscribe handle becomes available.
- **Consequence:** Both observers invoke another native state read for a closed view. The storage observer also dispatches through the mutable refresh ref, so an obsolete subscription can invoke a replacement observer's reader.
- **Evidence:** The new storage test and extended transfer-notice cleanup test each observed one backend read after unmount. Tauri's installed `@tauri-apps/api/event.js` passes `transformCallback(handler)` to the listen invocation before its promise resolves with the unsubscribe handle.
- **Suggested fix:** Check the subscription effect's lifetime before invoking its refresh handler, rather than guarding only publication after the read.
- **Regression tests:** Keep registration unresolved, unmount, deliver an event, then finish registration. Assert no backend read occurs and the late unsubscribe handle is released once.

## Finding 8: Native sandbox menus appear after their row disappears (P2)

- Location: `app/SiloUI/src/desktop/native-workspace-menu.tsx`, after `Menu.new`.
- Trigger: open sandbox actions, remove the row or replace the status panel while asynchronous native menu creation is pending, then finish creation.
- Consequence: an orphan native popup offers commands for a sandbox no longer shown.
- Reproduction: `native-workspace-menu.test.tsx` delays `Menu.new`, unmounts the row, resolves creation, and observes `popup` called once. Failing output: `/tmp/fe-status-storage-updates-8-failing.log`.
- Fix: check the originating button's connection before showing the menu; the existing `finally` releases its native resource.
- Validation: focused native-menu and status-panel tests, frontend typecheck, touched-file lint, and Rust formatting. Fixture data only; no application launched.

## Finding 9: Escape cancels quit confirmation and hides the status panel together (P2)

- Location: `app/SiloUI/src/components/inline-confirmation.tsx`, Escape event listener.
- Trigger: open the native status panel's quit confirmation, then press Escape.
- Consequence: `StatusPanel` handles the bubbling key before the confirmation's document listener; one Escape both cancels confirmation and sends `hide_status`, contrary to the host's nested-dismissal policy.
- Reproduction: `status-panel.test.tsx` opens quit confirmation and requires no `hide_status` until a second Escape. Failing output: `/tmp/fe-status-storage-updates-9-failing.log`.
- Fix: the topmost inline confirmation handles Escape in document capture and prevents its default dismissal before the status panel receives the key. Already handled keys are ignored.
- Validation: focused status, inline confirmation, updates, and shutdown tests; typecheck, touched-file lint, Rust formatting. Fixture data only.
