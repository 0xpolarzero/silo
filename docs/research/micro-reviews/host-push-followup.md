# Host push follow-up review

Scope: `app/SiloUI/src-tauri/src/host_push.rs` and `app/SiloUI/src-tauri/src/host_push_operations.rs`.

## HOST-PUSH-3: A current-session unknown push does not block another publication

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/host_push_operations.rs:142`.
- **Trigger:** A final push is interrupted and recorded with `status: unknown`. Another controller with stale repository state sends a fresh operation identifier before the unknown result is dismissed.
- **Consequence:** The host's repository exclusion checks only raw `pushing` records. It dispatches another push despite the unacknowledged unknown outcome. The frontend guard at `production-source.ts:1651` protects only a controller whose current state already includes the unknown result. Restarted unknown results happen to remain blocked because their stored status is still `pushing`.
- **Suggested fix:** Return any existing undismissed `pushing` or `unknown` result instead of claiming a new job. Dismissal already records the explicit acknowledgment.
- **Test:** Seed an unknown result from the current session, claim the repository with a new identifier, and assert that no job is created. Mark the unknown result dismissed and assert that the new request can then be claimed.

Verification uses temporary journal fixtures and source-extracted Rust tests. No Silo app, live VM, or GitHub endpoint is used.
