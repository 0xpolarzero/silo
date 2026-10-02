# Runtime directory follow-up: runtime-dir-b

Scope: `contract_tests.rs`, `crash_acknowledgement.rs`, `image_cache.rs`, `lifecycle_recovery.rs`, and `operation_gate.rs` in `app/SiloUI/src-tauri/src/runtime/`. This finding was confirmed during the requested fix loop, after the initial shared-worktree audit was written. Tests use temporary files only; no app or VM was launched.

## RUNTIME-DIR-B-3: Unverifiable descriptors are treated as proof of independence

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/runtime/image_cache.rs:106`, the `!is_descriptor` branch in `reads_from`.
- **Trigger:** A `.vmdk` descriptor is larger than 64 KiB or is a symlink. The descriptor still names an extent under the pre-upgrade runtime.
- **Evidence:** `is_descriptor` accepts only regular files up to 64 KiB. `reads_from` previously skipped every rejected path and returned `Ok(false)` without reading it. Two regression tests failed against that code: a descriptor containing valid extent text after comment padding, and a symlink to a descriptor naming the previous runtime. The pinned [MicroSandbox descriptor writer](https://github.com/superradcompany/microsandbox/blob/09df3d4b9d832adaede1fb9a198cfc660bfab8cd/crates/image/lib/stitch/vmdk.rs) was inspected from Cargo's exact-revision source: it emits one or more lines per extent with no descriptor-size bound. Its 2 GiB bound applies to individual extent lines, not descriptor length.
- **Consequence:** `pre_upgrade_backup::ensure_converted_runtime_is_independent` accepts `Ok(false)`, allowing its caller to delete files the unexamined descriptor still needs. This is a source-traced consequence, not a live VM reproduction.
- **Suggested fix:** Keep the bounded regular-file policy, but refuse independence whenever a `.vmdk` entry fails that policy. Non-VMDK cache entries remain irrelevant.
- **Test that catches it:** Oversized and redirected descriptor fixtures must return an error rather than `Ok(false)`. Existing tests continue to allow verified local descriptors and reject remaining previous-runtime dependencies.

## RUNTIME-DIR-B-4: Running state hides interrupted or failed post-boot account setup

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/runtime/lifecycle_recovery.rs:205` (the command error is propagated only when the desired runtime state was not reached).
- **Trigger:** Silo exits after the raw runtime Start reaches Running but before `prepare_booted` finishes, leaving a durable StartPending intent. Recovery sees Running and clears the intent without checking the account. The same gap applies when `working_account::prepare` fails and the cleanup Stop fails to stop the VM; an unsupported working-account record is one concrete setup failure (`working_account.rs:54`).
- **Evidence:** `ProcessRunner` routes successful raw starts through `prepare_booted` (`runtime.rs:1090`). `prepare_booted` discards the cleanup Stop result (`runtime.rs:1191–1202`) and returns the account preparation error. `advance` returns success immediately for an initial Running observation in StartPending (lines 156–164), without calling account preparation. After an attempted command it also observes Running, bypasses `result?` at line 215, then returns success on the next loop's desired-state check. `settle` records success and deletes the lifecycle intent. Existing duplicate-start recovery intentionally accepts a command error followed by Running, so unconditionally propagating every error would regress that behavior. Both paths are source-confirmed; an app crash during preparation and the guest/cleanup double failure were not executed.
- **Consequence:** Start reports success and clears its retry record while the running VM lacks the supported account layout, leaving guest access unusable and losing the setup failure from lifecycle activity.
- **Suggested fix:** Distinguish post-boot preparation failure from raw runtime command failure at the runner boundary. Preserve preparation and cleanup errors even when the runtime reports Running; retain the existing recovery path for a surviving detached start. Do not discriminate by parsing display strings.
- **Test that would catch it:** A saved StartPending intent with a Running VM and missing account record must complete preparation before recovery retires the intent. A synthetic runtime reaches Running, reports an unknown account layout, and rejects cleanup Stop. The public lifecycle Start must return the preparation failure, record failed activity, and retain actionable recovery state. A duplicate raw Start that observes an already prepared Running VM must still settle successfully.
- **Fix-loop status:** Skipped. This requires revising the runner's error contract and its boot, cleanup, recovery, and error-reporting callers outside the scoped module; a one-line change to `advance` cannot distinguish the supported duplicate-start case safely. No live qualification was attempted.

## Fix-loop outcomes and verification

| Finding | Outcome | Regression coverage |
| --- | --- | --- |
| RUNTIME-DIR-B-1 | Fixed and folded: `bbdb8418` | Alias dependency detection, safe deletion after rebinding, unresolved extent rejection |
| RUNTIME-DIR-B-2 | Fixed and folded: `fbbef3e5` | Partial success retains a missing-extent error; unreadable descriptors do not stop independent repairs |
| RUNTIME-DIR-B-3 | Fixed and folded: `ae83d9fb` | Oversized and redirected descriptors refuse independence |
| RUNTIME-DIR-B-4 | Skipped: runner readiness/error contract needs broader work | Acceptance cases documented above; no live reproduction |

Six regression tests were added. The actual `image_cache.rs` module was compiled directly with Rust 1.94.0, `--edition=2021 --test`, and the shared target's cached `tempfile` dependency. The first alias regression failed before its fix; the two partial-repair regressions failed before their fix; the two unverifiable-descriptor regressions failed before their fix. The final module run passed all 11 tests, and compilation with `-D warnings` passed. Failing outputs remain under `/tmp/silo-codex-target/verification/runtime-dir-b/`.

`cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`, `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`, and `git diff --check` passed. These checks concern the local task revisions, not every later change merged by other agents.

A focused native Cargo test used `/tmp/silo-codex-target` and the release guide's three explicit synthetic GitHub values. After waiting for the shared artifact lock, its first attempt stopped in the build script because the new worktree lacked `binaries/msb-aarch64-apple-darwin`. Existing generated `binaries` and `runtime` resources from the main checkout were temporarily linked into this worktree for a retry; that retry remained queued on the shared lock and was cancelled with SIGINT after verifying its Cargo executable, exact test arguments, and worktree directory. Its exit status was 130. Those temporary resource links were removed. Native Cargo validation remains incomplete; the successful module tests do not prove application packaging or live VM behavior.

No app bundle was inspected or launched. Tests used temporary filesystem fixtures only. All three fixes include patch changesets; no version or release was published.

## RUNTIME-DIR-B-5: Local extent paths hide missing image files

- **Priority:** P2
- **Trigger and evidence:** A descriptor already points into the current cache, but one of those files has disappeared. `rebind` skipped existence checks on local paths. The filesystem regression returned `Ok(0)` before the fix, while preserving a descriptor that cannot boot.
- **Correction:** Require local extent paths to identify files before accepting the descriptor. Leave a broken descriptor untouched and report the missing image file; restoring the file makes the same descriptor pass without rewriting it.
- **Verification:** The new regression failed before the fix, then all 12 tests in the actual `image_cache.rs` module passed with Rust 1.94.0 and `-D warnings`. No app or VM was launched.

## RUNTIME-DIR-B-6: Explicit queue predicates bypass scoped start conditions

- **Priority:** P2
- **Trigger and evidence:** An admission under `StartCondition` uses `acquire_while`. The gate discarded the scoped condition whenever an explicit predicate existed. A deterministic regression with an expired condition and a true explicit predicate acquired a free turn (`Ok(())`) before the fix instead of refusing it.
- **Correction:** Apply both conditions while queued and keep the scoped condition's final admission check. Only expiration of the scoped condition sets its expired flag; abandonment by the caller's own predicate remains a separate outcome. Already-started work retains normal retry behavior.
- **Verification:** The free-turn regression failed before the fix. All 39 tests in the actual `operation_gate.rs` module passed through a standalone Rust 1.94.0 harness using the shared target's cached Serde/Tauri libraries, including scoped worker propagation and the queue's checked-in JSON contract. Two additional regressions cover remote expiration while blocked and explicit abandonment while the remote request remains valid. Compilation used `-D warnings`. No app or VM was launched; this validates the gate's admission contract, not a live remote connection.

## RUNTIME-DIR-B-7: Damaged activity history reports failure after crash dismissal succeeds

- **Priority:** P2
- **Trigger and evidence:** `dismiss` saves a durable acknowledgement and then calls `acknowledge_failure`. That advisory update propagated corrupt-history errors, so the completed dismissal was reported as failed. Both the direct history-update regression and the crash-dismissal regression failed against the original helper.
- **Correction:** Use the existing advisory-history warning and recording paths for acknowledgement, preserving unreadable bytes instead of overwriting them. The durable crash acknowledgement and lifecycle-intent checks remain authoritative.
- **Verification:** Both regressions pass and verify preserved corrupt bytes plus an activity warning. All 19 tests from the actual `runtime_activity.rs` and `crash_acknowledgement.rs` modules passed in a standalone Rust 1.94.0 harness compiled with `-D warnings`; the harness supplies temporary-path metadata, inspect, setup-history and no-intent lifecycle adapters, so it does not prove the full native application build. Tests launch no app or VM.
