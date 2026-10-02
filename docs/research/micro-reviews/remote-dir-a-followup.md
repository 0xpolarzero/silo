# Remote directory fix-loop follow-up

Scope: `remote/operations.rs` and adjacent remote dispatch and transport code. The initial read-only audit remains in [remote-dir-a.md](remote-dir-a.md). REMOTE-DIR-A-1 and REMOTE-DIR-A-2 describe the same admission boundary independently fixed in `6bd7cc69`; the later transport finding is below.

## REMOTE-DIR-A-2: A permission check before mutex contention survives management revocation

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/remote/operations.rs:172` in the initial review source (`wanted()` checks `allowed()` before acquiring the registry mutex).
- **Trigger:** A queued change reads the management permission as true, then waits for the registry mutex while another operation syncs its journal. The owner disables remote management before that mutex becomes available; the original controller connection remains open and the deadline has not expired.
- **Evidence:** `wanted()` retains its successful `allowed()` check across the mutex wait and never rechecks it. The production probe reads `REMOTE_ENABLED` and the shutdown flag (`remote.rs`, `changes_allowed`); disabling management updates `REMOTE_ENABLED` without taking the registry mutex (`set_remote_management`). The gate admits the operation from the predicate's true result. A disposable Rust harness copied the exact admission methods and regression bodies from the worktree, replacing only fixture setup and the surrounding registry types. Its revocation regression failed with `revoked work must not be admitted after registry contention`; the deadline regression failed independently. These are predicate reproductions, not live remote sessions.
- **Consequence:** Disabling remote management can still admit an unstarted remote change that was blocked behind unrelated journal I/O. This differs from an already running operation, which is intentionally allowed to finish.
- **Suggested fix:** Evaluate the management probe after acquiring the registry mutex. The production probe only reads atomic flags; it does not acquire the registry or operation-gate mutex.
- **Test that would catch it:** Hold the registry mutex, start the predicate, revoke a fixture's atomic permission before releasing the mutex, and assert admission is refused. Coordinate the sampled permission with a channel so the original stale true value is captured before revocation; use a bounded wait when the corrected predicate cannot sample until the mutex is released.

## Fix verification

The original report remains uncommitted in the shared review worktree. Fixes and regression tests live in `codex/fix-remote-dir-a`, based on `codex/integration`. Evidence is under the ignored `app/SiloUI/src-tauri/target/verification/remote-dir-a/` directory; test configuration is synthetic and fixtures use temporary journal directories. The two extracted source-predicate regressions failed before correction. Native tests and Clippy use the shared `/tmp/silo-codex-target`; no application or VM is launched.

Both findings were independently fixed on integration by `6bd7cc69` while this loop was running. The local deadline implementation (`5358e28f`) was superseded during fold-conflict resolution: preserve the integration implementation, which samples deadline and permission after both mutex contention and connection probes, and remove the duplicate changeset and clock seam. Integration's two gate-level regressions verify `EXPIRED` and zero executions for stale deadline and stale permission. No second implementation is needed for REMOTE-DIR-A-2.

After resolving the overlap, all nine tests in the unchanged `remote/operations.rs` passed in the isolated module harness, including integration's two gate-level regressions. The harness compiles the unchanged synchronous gate implementation and the relevant bridge-error implementation against cached dependencies; it omits the unused Tauri worker adapter, unrelated gate tests, and runtime error conversions. Rust 1.94.0 `clippy-driver` reported no warnings for that harness; Cargo formatting and `git diff --check` passed. These focused checks type-check the reviewed module but do not qualify the full application build or live two-computer behavior.

The full application Cargo test and Cargo Clippy requests never progressed beyond shared-target lock waits. Both requests and their verified worktree-owned Cargo processes were cancelled with SIGTERM after the integration fix superseded the local implementation; no other worktree process was stopped. No full-application Cargo result is claimed. The final scope pass found no additional concrete defect beyond the two admission checks, and still excludes R-25's previously reported checkpoint timeout.

## REMOTE-DIR-A-3: Overlapping reply prefixes double-count shell output

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/remote.rs`, `read_reply`, mismatch branch.
- **Trigger:** A valid reply follows shell output within the 64 KiB allowance, ending in a NUL byte or containing repeated NUL bytes. The next NUL restarts the preamble match.
- **Evidence:** The parser added the current byte to `skipped` while also retaining it as the first byte of the next potential preamble. The extracted-source regression `reply_search_counts_overlapping_prefix_bytes_once` rejected an exactly 64 KiB fixture ending in NUL; the existing shell-output regression passed.
- **Consequence:** The controller reports unexpected shell output and loses a valid remote result despite receiving a reply within the documented allowance. Repeated NULs can reach this false rejection below 64 KiB.
- **Fix:** Count the mismatched byte as skipped only when it does not begin the next match. Preserve the frame and shell-output limits.
- **Regression:** Both an ordinary 64 KiB banner ending in NUL and a 64 KiB NUL banner must round-trip through a seven-byte buffer. A NUL banner one byte over the allowance must still fail. Both parser tests pass after correction. The disposable harness copies the source functions and test bodies; it replaces only the unused process-wide test guard. Rust 1.94.0 module Clippy, Cargo formatting, and whitespace checks pass; no live SSH session, app, or VM is involved.
