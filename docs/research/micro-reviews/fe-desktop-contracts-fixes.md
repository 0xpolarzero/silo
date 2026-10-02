# Desktop contracts: isolated fix-loop findings

Scope: `app/SiloUI/src/desktop/` and `app/SiloUI/src/contracts/`, checked against native command signatures and serializers.

The initial read-only audit remains in the shared review worktree. These additional findings were reproduced in `codex/fix-fe-desktop-contracts`. All tests use fixtures and mocked native transports; no application, VM, or production data was used.

## fe-desktop-contracts-1: An obsolete read error overrides a newer status event

- **Severity:** P2
- **Location:** `app/SiloUI/src/desktop/computer-use-bridge.ts:109`.
- **Trigger:** A `chatgpt_app_status` read is pending, a `chatgpt-app-status` event reports Ready, then the earlier read rejects.
- **Consequence:** The current Ready status acquires a stale load error and a misleading Refresh status action.
- **Evidence:** `drops a read error superseded by a status event` failed with `loadError: "Status read failed"` despite the newer Ready event. The success path checked both request and event ordering; the rejection path checked only request ordering.
- **Fix:** Apply the event-order guard to rejected reads as well. Fixed and folded in `8ddd1344`.
- **Regression:** Deferred read rejection after a Ready event must retain Ready with no load error.

## fe-desktop-contracts-2: Saved configuration accepts CPU counts Rust cannot deserialize

- **Severity:** P3
- **Location:** `app/SiloUI/src/contracts/silo.ts:44` and the bootstrap CPU fields at line 15.
- **Trigger:** Native settings restore a completed machine draft with `cpus` or `maxCPUs` equal to 256. Rust settings validation accepts these values, and the draft parser uses this frontend contract.
- **Consequence:** The restored machine passes frontend configuration validation but cannot become a `MachineConfiguration::Vm` command argument: `runtime.rs` defines both CPU fields as `u8`. The editor's independent 255 limit does not run when restoring saved drafts.
- **Evidence:** Both native-settings restoration regressions returned the invalid draft, and the configuration boundary test accepted 256. Rust `settings::valid_machine` checks saved numeric resources against `u32::MAX`, while `runtime::MachineConfiguration` declares `cpus: u8` and `max_cpus: u8`.
- **Fix:** Limit both frontend CPU representations to 255. Existing malformed-draft recovery discards an unusable draft while preserving healthy settings. Unfinished editor values remain available for correction. Fixed and folded in `d9b8fa91`.
- **Regression:** Accept 255, reject 256 as saved configuration, retain 256 only in unfinished input, and keep unrelated settings usable when native restoration supplies an invalid draft.

## fe-desktop-contracts-3: Disposed notice listeners still forward pending events

- **Severity:** P3
- **Location:** `app/SiloUI/src/desktop/notices.ts:45`.
- **Trigger:** Dispose a notice subscription before native listener registration resolves, then deliver an event before the delayed unsubscribe function becomes available.
- **Consequence:** The removed application view still forwards a toast. A replacement view can receive the same event through its own active subscription.
- **Evidence:** The existing expected-failure test, converted to a normal regression, failed because the disposed handler received one notice. Cleanup already unsubscribed after late registration, but the callback did not check the disposed flag.
- **Fix:** Check the disposed flag before parsing or forwarding an event. Fixed and folded in `cf9a38f8`.
- **Regression:** No callback after disposal, with the delayed native unsubscribe still executed once.

## fe-desktop-contracts-4: Malformed status reads silently preserve cached authority

- **Severity:** P3
- **Location:** `app/SiloUI/src/desktop/computer-use-bridge.ts:101`.
- **Trigger:** Read a valid ChatGPT app status, then receive a successful command response that is not a status, such as `null`.
- **Consequence:** The cached status remains without a load error or Refresh action. The same malformed response is reported as an error only before any status has been cached.
- **Evidence:** The new status-view regression failed because no alert existed after the second read returned `null`. The Rust remote status command returns the owner's JSON value through `owner_status` and `remote_status`, so the frontend parser owns this boundary. Unknown tagged states already map to `unknown` and remain supported.
- **Fix:** Report every unreadable status read while retaining the last readable status.
- **Regression:** Read Ready, return `null`, require the read error and Refresh action, then return Idle and require the error to clear.

## fe-desktop-contracts-5: Successful deletion retains an obsolete backup read error

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/storage/pre-upgrade-backup.tsx`, successful `remove` path.
- **Trigger:** Load a backup, fail a later status read, then successfully delete the backup.
- **Consequence:** The backup is cleared but the earlier load error remains. Storage therefore shows an erroneous "could not check for it" row after native deletion confirmed absence. Reads triggered during deletion can be discarded by the existing deletion sequence guard.
- **Evidence:** `clears a previous read failure once deletion confirms the backup is gone` failed with `"Backup read failed"` instead of a cleared error.
- **Fix:** Clear the read error when deletion succeeds; retain independent subscription failures.
- **Regression:** A successful deletion clears both the cached backup and an obsolete read failure.

## fe-desktop-contracts-6: Recovery results fall between initial read and event registration

- **Severity:** P3
- **Location:** `app/SiloUI/src/features/application/model/transfer-result-notice.ts`, subscription effect.
- **Trigger:** The first result read returns null, recovery records its result before native event registration completes, and no later state change occurs.
- **Consequence:** The migration backup notice omits the recovered export or import outcome. The application can still show it after the user opens Silo because it remains unacknowledged.
- **Evidence:** A deferred-registration regression failed with a null notice after registration completed. The native backup controller emits `silo://application-state-changed` when publishing state; the notice backend uses that event to refresh recovery results.
- **Fix:** Read after event registration settles, including a fallback read after registration failure. Skip that read after disposal.
- **Regression:** A result recorded during registration appears; failed registration still permits a read; late registration after unmount unsubscribes without a new read.

## fe-desktop-contracts-7: SSH repair notices fall between initial read and event registration

- **Severity:** P2
- **Location:** `app/SiloUI/src/features/application/model/editor-include.tsx`, subscription effect.
- **Trigger:** The initial read reports no manual Include line, and native startup repair creates one before listener registration completes.
- **Consequence:** The application omits the SSH configuration notice until another event or window focus. Editors that reconnect independently can continue using the old storage.
- **Evidence:** The component regression failed to find the repair notice after delayed registration. `editor::refresh_transports` spawns a background thread, and `set_manual_include` emits `silo://editor-include-changed` when it records the line. Main-window startup calls this repair after showing the window.
- **Fix:** Reconcile the line after subscription settles, including its failure path. Do not start that read for a replaced or closed view.
- **Regression:** A repair completed during registration must display its line; replaced backend reads and late subscriptions remain isolated.

## Rejected menu-lifetime hypothesis

The pinned versions are Tauri 2.11.5 and muda 0.19.3. GTK popup completion is not an early-dismissal defect in this checkout: [muda's pinned GTK implementation](https://github.com/tauri-apps/muda/blob/muda-v0.19.3/src/platform_impl/gtk/mod.rs#L1416-L1500) iterates GTK until cancel or selection-done, and [Tauri's menu implementation](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/menu/menu.rs#L43-L81) waits for its main-thread call. No menu-lifetime fix was made on that premise.

## fe-desktop-contracts-8: Removed sandbox rows still open and dispatch native menus

- **Severity:** P3
- **Location:** `app/SiloUI/src/desktop/native-workspace-menu.tsx`, menu creation and item callbacks.
- **Trigger:** A sandbox row disappears while asynchronous native menu creation or menu tracking is pending.
- **Consequence:** Late creation opens an orphan menu, and its retained callbacks can start or operate the removed sandbox. An already open menu also remains owned by the discarded component.
- **Evidence:** The deferred-creation regression failed because `popup` was called after unmount. This test supplies native API mocks; it does not establish installed-app menu behavior.
- **Fix:** Close owned menus on disposal, close late-created menus without opening them, and guard item callbacks and feedback against disposal. Release ownership before closing so tracking completion cannot close a menu twice.
- **Regression:** A late menu never opens or starts a sandbox; an open menu closes once on disposal and ignores subsequent actions. Existing remote targeting and website-copy behavior remain covered.
