# Host push follow-up review

Scope: `app/SiloUI/src-tauri/src/host_push.rs`, `app/SiloUI/src-tauri/src/host_push_operations.rs`, and adjacent publishing-cache code.

## HOST-PUSH-3: A current-session unknown push does not block another publication

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/host_push_operations.rs:142`.
- **Trigger:** A final push is interrupted and recorded with `status: unknown`. Another controller with stale repository state sends a fresh operation identifier before the unknown result is dismissed.
- **Consequence:** The host's repository exclusion checks only raw `pushing` records. It dispatches another push despite the unacknowledged unknown outcome. The frontend guard at `production-source.ts:1651` protects only a controller whose current state already includes the unknown result. Restarted unknown results happen to remain blocked because their stored status is still `pushing`.
- **Suggested fix:** Return any existing undismissed `pushing` or `unknown` result instead of claiming a new job. Dismissal already records the explicit acknowledgment.
- **Test:** Seed an unknown result from the current session, claim the repository with a new identifier, and assert that no job is created. Mark the unknown result dismissed and assert that the new request can then be claimed.

Verification uses temporary journal fixtures and source-extracted Rust tests. No Silo app, live VM, or GitHub endpoint is used.

## HOST-PUSH-4: A lost Git status response reports failure after publication

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/host_push.rs`, unsuccessful process status handling in `HostGit::run`.
- **Trigger:** The receive-pack process updates the branch, then its final status response is lost. A disposable fixture using bundled Git and an SSH adapter that forwards the advertisement but discards the final response reproduced exit code 128 with an empty porcelain response and a remote branch already at the new commit.
- **Consequence:** The nonzero exit became an ordinary failed operation, allowing a retry without checking the branch.
- **Fix:** Interpret the existing porcelain response. Preserve explicit local and remote rejections as failures; treat a missing response or remote failure as unknown. [Git's output reference](https://git-scm.com/docs/git-push#_output) distinguishes a refused update from an unreported update and documents the tab-separated porcelain fields.
- **Regression:** Exercise the process boundary with missing status, remote failure, local rejection, and remote rejection. The first two must be unknown and the latter two must preserve their actionable Git failure.

## HOST-PUSH-5: Concurrent cache deletion fails another repository's push

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/host_push_cache.rs`, `sweep` and `Cache::discard`.
- **Trigger:** A push discards a failed import under its repository lock while another push scans the cache root. The scan enumerates the first directory, then its owner removes it before size inspection.
- **Consequence:** A missing file or directory becomes a fatal publishing-cache error in the unrelated push.
- **Regression:** Hold the first repository lock, discard its directory after the scanner observes it, and assert the second repository's sweep and acquisition succeed while the first lock remains exclusive. The fixture failed before the fix.
- **Fix:** Take the repository lock before inspection, tolerate a vanished directory, and treat active-cache sizing errors as advisory. Idle caches still undergo strict symlink and size validation.
