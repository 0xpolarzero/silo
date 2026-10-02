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
