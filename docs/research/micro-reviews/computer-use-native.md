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
