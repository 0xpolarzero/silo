# Native entry fix loop

Scope: native entry and remaining small top-level Rust modules. The original read-only review remains in the shared `codex-micro` worktree as `docs/research/micro-reviews/native-entry.md`.

## NATIVE-ENTRY-1: Directory snapshot owner

Fixed and folded in `10fd55ff`. Snapshots retain their metadata VM UUID, and pagination rejects a replacement VM with the same name. The regression failed by returning the deleted VM's entry and passes after the identity check. All nine directory tests pass in an extracted-source harness. Formatting, frontend typecheck, and lint passed. The ordinary native Cargo test was queued on the shared target lock when this entry was written.

## NATIVE-ENTRY-2: Computer removal hides SSH-key cleanup failures

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/ssh_connection.rs:99`, plus the caller at `app/SiloUI/src-tauri/src/remote.rs:346`.
- **Trigger:** A connection-key root cannot be enumerated, for example because `ssh/remote-clients` or `ssh/connections` is a regular file instead of a directory, or access is denied. An individual directory entry can also fail to read.
- **Evidence:** `forget_host` previously skipped every `read_dir` error and flattened away entry errors. `remove_remote_host` saved the computer's removal first and discarded the cleanup result. A temporary filesystem regression occupying either root with a regular file returned `Ok(())` before the fix.
- **Consequence:** Removal reports success without verifying/deleting the connection keys, and the computer disappears from the list, preventing the same removal action from being retried.
- **Suggested fix:** Treat only missing directories as successful empty roots; propagate enumeration/deletion errors. Perform the cleanup before saving removal so a failed attempt retains the computer for retry.
- **Regression:** `removing_a_computer_reports_unreadable_key_directories` verifies absent roots succeed and both malformed roots fail. Existing removal tests verify other computers' keys and local sandbox keys remain untouched.
- **Boundary:** The existing behavior when runtime paths are unavailable remains outside this finding; this correction covers cleanup failures after those paths resolve. No real SSH key, credential store, VM, or application instance is touched by these tests.
