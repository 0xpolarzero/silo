# Runtime activity and logs fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/runtime_activity.rs` and `app/SiloUI/src-tauri/src/runtime_logs.rs`.

The initial audit is in the shared worktree at `docs/research/micro-reviews/runtime-activity-logs.md`. Finding runtime-activity-logs-1 was fixed and folded in commit `7c68425a`.

## runtime-activity-logs-2: Malformed execution bodies are silently presented as readable blank records

- **Priority:** P3
- **Location:** `app/SiloUI/src-tauri/src/runtime_logs.rs:225–243` before this fix.
- **Trigger:** `exec.log` contains valid JSON with a missing or non-string `d` field, including `null`, `[]`, `{}`, a JSON string, or an object whose `d` is numeric.
- **Evidence:** Parsing into `serde_json::Value` succeeds, and `value["d"].as_str().unwrap_or("")` converts the invalid record to a blank line. The decoder sets `unreadable: false`, so a file containing only such malformed records reports no degradation. The pinned writer requires a string body, including system markers: [MicroSandbox `ExecLogEntry` and writer at revision 09df3d4](https://github.com/superradcompany/microsandbox/blob/09df3d4b9d832adaede1fb9a198cfc660bfab8cd/crates/runtime/lib/runner/exec_log.rs#L43).
- **Consequence:** The UI and export coverage omit the unreadable-record warning, and the malformed record appears as an unexplained blank row instead of the existing diagnostic placeholder.
- **Suggested fix:** Require a string `d` field before constructing the decoded execution entry; reuse the existing unreadable execution record placeholder otherwise.
- **Test that catches it:** Query temporary execution files containing each malformed shape followed by a valid sentinel. Require `unreadableRecords`, a placeholder, and the sentinel. Keep controls for a legitimate empty string and base64 output. The extracted production query regression failed on `null` before the fix.

## runtime-activity-logs-3: An intent write failure leaves a permanently running Activity entry

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/runtime/lifecycle_recovery.rs:301–314` before this fix.
- **Trigger:** The activity journal remains writable, but the lifecycle intent cannot be stored, such as when `lifecycle-operations` is a regular file instead of a directory.
- **Evidence:** `begin` journals an unfinished event. Inspection errors call `finish`, but the subsequent `store(paths, &intent)?` returns directly on failure. The existing filesystem-failure regression, extended to read Activity, returned `status: running` after `perform` had failed without reaching any runtime mutation.
- **Consequence:** Activity keeps showing an action as running after its worker has failed; it never records the persistence error or the final outcome during that app session.
- **Fix:** Save the intent inside the existing preflight result path, so persistence failures use the same Activity completion path as inspection and validation failures. No runtime mutation is admitted before a successful intent save.
- **Regression:** The intent-write failure test requires a completed danger entry with the save-error detail and no VM mutation. The extracted production `perform`, intent storage, and Activity reader failed before correction and passed afterward, using temporary files and stubbed runtime inspection.

## Verification

Both new regressions failed against the corresponding pre-fix functions and passed after correction in disposable Rust harnesses under `/tmp/silo-codex-target/verification/runtime-activity-logs/`. The complete extracted retained-log query suite passed all 21 tests with the default parallel test runner, including production JSON Lines export, redaction, rotation, pagination, and follow functions. These tests used temporary files only.

`cargo +1.94.0 fmt --check`, frontend typecheck, frontend lint, and Clippy on the extracted query functions passed. Clippy retained the existing cache type-complexity warning and an unused harness import. The first native Cargo attempt failed during the Tauri build script because this fresh worktree lacked ignored runtime sidecars. Linking the existing local binaries and runtime resources resolved that missing-input setup; the subsequent native suite was queued on the shared Cargo target at this report's cutoff. No app or VM was launched, and no packaged bundle was inspected.
