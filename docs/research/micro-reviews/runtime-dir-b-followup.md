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

## RUNTIME-DIR-B-4: Running state hides a failed post-boot account setup

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/runtime/lifecycle_recovery.rs:205` (the command error is propagated only when the desired runtime state was not reached).
- **Trigger:** A Start reaches Running, then `working_account::prepare` fails, and the cleanup Stop also fails to stop the VM. An unsupported working-account record is one concrete setup failure (`working_account.rs:54`).
- **Evidence:** `ProcessRunner` routes successful raw starts through `prepare_booted` (`runtime.rs:1090`). `prepare_booted` discards the cleanup Stop result (`runtime.rs:1191–1202`) and returns the account preparation error. `advance` observes Running, bypasses `result?` at line 215, then returns success on the next loop's desired-state check. `settle` records success and deletes the lifecycle intent. Existing duplicate-start recovery intentionally accepts a command error followed by Running, so unconditionally propagating every error would regress that behavior. This finding is source-confirmed; the guest/cleanup double failure was not executed.
- **Consequence:** Start reports success and clears its retry record while the running VM lacks the supported account layout, leaving guest access unusable and losing the setup failure from lifecycle activity.
- **Suggested fix:** Distinguish post-boot preparation failure from raw runtime command failure at the runner boundary. Preserve preparation and cleanup errors even when the runtime reports Running; retain the existing recovery path for a surviving detached start. Do not discriminate by parsing display strings.
- **Test that would catch it:** A synthetic runtime reaches Running, reports an unknown account layout, and rejects cleanup Stop. The public lifecycle Start must return the preparation failure, record failed activity, and retain actionable recovery state. A duplicate raw Start that observes an already prepared Running VM must still settle successfully.
- **Fix-loop status:** Skipped. This requires revising the runner's error contract and its boot, cleanup, recovery, and error-reporting callers outside the scoped module; a one-line change to `advance` cannot distinguish the supported duplicate-start case safely. No live qualification was attempted.
