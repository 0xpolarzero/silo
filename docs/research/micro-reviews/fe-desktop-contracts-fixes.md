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

## Rejected menu-lifetime hypothesis

The pinned versions are Tauri 2.11.5 and muda 0.19.3. GTK popup completion is not an early-dismissal defect in this checkout: [muda's pinned GTK implementation](https://github.com/tauri-apps/muda/blob/muda-v0.19.3/src/platform_impl/gtk/mod.rs#L1416-L1500) iterates GTK until cancel or selection-done, and [Tauri's menu implementation](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/src/menu/menu.rs#L43-L81) waits for its main-thread call. No menu-lifetime fix was made on that premise.
