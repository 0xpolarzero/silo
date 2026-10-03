# Native computer-use micro-review

Scope: `app/SiloUI/src-tauri/src/computer_use.rs` and `app/SiloUI/src-tauri/src/computer_use/`.

Read-only source review on 2026-10-02. Prior first-pass, second-pass, and third-pass reports were checked; their findings are excluded. No builds, tests, app launches, or live data access were performed.

## COMPUTER-USE-NATIVE-1: Fork succeeds without saving inherited approval

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/computer_use.rs:334` (`inherit_settings`, lines 331–342).
- **Trigger:** Fork a source whose saved approval is Auto while the `computer-use` directory permits reading but not writing, with the checkpoint and metadata directories still writable. For example, an existing owner-controlled directory with mode `0500` allows reading the source policy but prevents creating the temporary child policy. `runtime::prepare_private_directory` does not restore owner write permission in this case (`runtime.rs:869–895`).
- **Evidence:** `inherit_settings` reads the source's Auto choice, discards the result of `write_atomic`, and returns `()`. Its production caller, `runtime/checkpoints.rs:1535`, continues copying assignments and publishing the child in metadata; the success branch at line 1551 returns `Ok(())`. No child policy is saved. `read_policy_checked` treats a missing policy as `Policy::default()` (`computer_use.rs:208`), whose approval is Ask. The existing inheritance test covers only successful writes (`computer_use/tests.rs:239`).
- **Consequence:** A successful fork silently loses the source's approval choice. After directory write permission is repaired, the fork's first boot applies Ask to a disk inherited from an Auto source, rather than inheriting Auto as promised. While the directory remains unwritable, its setup cannot save an attempt marker and cannot run the helper.
- **Suggested fix:** Return `Result` from `inherit_settings` and propagate its write failure through the fork transaction. Include inheritance in the rollback path so a failed policy copy cannot publish a successful fork or leave its checkpoint record behind.
- **Test that would catch it:** Save Auto for a source, make only the computer-use directory read-only, and call the existing fork-commit fixture. Assert an error, no child in metadata, and no orphan child checkpoint record. Restore permissions for cleanup. Also retain the successful inheritance assertion and verify that the resulting child's first helper invocation uses Auto. These tests were not executed in this review.

## Fix-loop verification

- Fixed in `1846c9a5`: inheritance returns its write error; fork commit performs inheritance inside its rollback transaction. A changeset documents the user-visible failure behavior.
- Added a native fork-commit regression for a readable but unwritable policy directory. Extended successful inheritance and inventory-failure rollback coverage, and updated both direct inheritance callers in computer-use tests to check their result.
- A disposable Rust fixture extracted the actual policy, directory preparation, inheritance, and fork-commit functions. Runtime inventory, checkpoint storage, and assignment collaborators were synthetic; policy files and permission failures used real temporary filesystem state. Before the fix, it failed with `fork reported success without saving its approval`. After the fix, it passed with no published child, no child checkpoint record, and no copied assignments. It also passed after resolving the integration merge with the concurrent fork-publication fix.
- Rust 1.94.0 compiled the extracted functions; Clippy reported no errors. Full repository `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` and `git diff --check` passed. No frontend files changed, so frontend typecheck and lint were not applicable.
- The full native regression command, using `/tmp/silo-codex-target` and explicit synthetic GitHub configuration, remained blocked on the shared Cargo artifact lock throughout the approximately twenty-minute loop. The first attempt also found missing generated Tauri resources, corrected by linking existing ignored runtime inputs into the isolated worktree. The owned queued Cargo process was stopped after verifying its command, working directory, and open verification log. The extracted fixture does not prove full application compilation or native-suite success. Evidence remains under the isolated worktree's ignored `app/SiloUI/src-tauri/target/verification/computer-use-native/` directory.
- The second scope scan found manual setup lacked the background convergence loop at the initial revision. Integration already fixes that path in `e5f00188`; no duplicate change was made.
- No app bundle was inspected or launched. All executed fixture data was temporary and synthetic; no live VM or production data was accessed.

## COMPUTER-USE-NATIVE-2: Settings cleanup failure is reported as success

- **Priority:** P3.
- **Location at `0b825390`:** `app/SiloUI/src-tauri/src/computer_use.rs:374`; adjacent caller `runtime/checkpoints.rs:802`.
- **Trigger:** The policy directory is readable but not writable during sandbox deletion or failed-fork cleanup.
- **Evidence and consequence:** `forget` discards the failed unlink. `forget_removed` then deletes the checkpoint record and returns success although the VM's policy file remains. The deletion result hides incomplete cleanup and discards the associated checkpoint record.
- **Fix:** Return the settings-removal error, attempt both policy and observation removal, and propagate it through checkpoint cleanup and import policy reset. Checkpoint cleanup retains its record when settings cannot be removed, so a direct retry after repairing permissions clears both.
- **Regression:** `failed_computer_use_cleanup_keeps_checkpoint_history_for_retry` covers the failure, unchanged saved Auto choice, successful retry, and idempotent repeated cleanup. The disposable Rust fixture uses the actual `forget` and `forget_removed` functions and real temporary-directory permissions. It failed before the fix with `cleanup reported success while settings remain`, then passed both this test and the previous inheritance regression. Rust 1.94.0 compilation, extracted-function Clippy, repository formatting, and whitespace checks passed. The native `cargo test ... computer_use` group is queued on the shared target; no native-suite result is claimed here. No app or live VM was used.

## COMPUTER-USE-NATIVE-3: Parallel test fixtures reuse pending-apply identities

- **Priority:** P3, internal test isolation.
- **Evidence:** The fixture factory reused numeric seeds 20, 21, and 22 across independent tests. The process-wide pending-apply registry uses the VM ID alone; distinct temporary storage roots and operation gates do not isolate that registry. A deterministic regression held a pending apply for one fixture and inspected another fixture created with the same seed. The full native harness reported `pending` instead of its recorded `applied` state before the fix.
- **Fix:** Generate a fresh UUID for every VM fixture. The regression checks the observable approval state while another fixture has a pending apply. No production behavior changed, so no changeset is needed.
- **Verification:** Compiled the complete native test harness from this worktree with Rust 1.94.0 and cached dependencies in the shared `/tmp/silo-codex-target`, using synthetic GitHub configuration. Ran the focused `computer_use` filter with the default parallel thread count: 80 passed, 4 opt-in tests ignored, zero failures. The resume rerun passed with the same counts. Native Clippy metadata compilation completed with 87 existing warnings and no errors; repository formatting and whitespace checks passed. Evidence is in the ignored verification directory. No app or live VM was used.
- **Follow-up for findings 1 and 2:** The complete native harness also passed each permission-failure regression individually: fork-policy inheritance and retryable settings cleanup. This extends the earlier extracted-function evidence. The Cargo invocation still waited on the shared artifact lock; the cached-dependency harness supplied the focused native verification, without claiming packaging or release readiness.
