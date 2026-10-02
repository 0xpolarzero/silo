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

## NATIVE-ENTRY-3: Linux tray drops initial health updates

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/tray.rs`, Linux `install` and `update`; UI sender in `src/desktop/status-panel.tsx`.
- **Trigger:** The status-panel health effect invokes `update_tray` before asynchronous `ksni::TrayServiceBuilder::spawn` finishes.
- **Evidence:** The handle was initially `None`; `update` skipped it and returned success. The UI effect only resends when tone or label changes. The tray therefore retained its neutral startup icon and product-name tooltip even after a health update. The readiness regression failed when the extracted production seam retained the original immediate-success behavior.
- **Fix:** Publish tray startup completion through Tokio's existing watch channel and await it before updating the handle. Propagate startup failure, abandoned startup, and a terminated tray service instead of reporting successful delivery. The maintained `ksni` 0.3.6 source documents `Handle::update` returning `None` after service shutdown.
- **Validation:** Five extracted-source tray tests pass, including pending startup, startup failure, abandoned startup, existing watcher grace, and panel anchoring. Tests poll the actual readiness future deterministically without a desktop or D-Bus service. Full native Cargo tests use the shared target; their result is recorded separately. No application was launched.

## NATIVE-ENTRY-4: Unsupported remote logs overwrite a complete export

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/log_export.rs::write_requests`, with the structured compatibility response in `runtime_logs.rs::remote_page`.
- **Trigger:** Save logs while at least one selected computer runs an older Silo that does not implement `runtime.logs`. The history model retains unsupported pages, and `logs-page.tsx` forwards all their requests to the export command.
- **Evidence:** The runtime maps an unsupported remote operation to an empty page with `unsupported: true`. The export writer ignored that flag, wrote zero-match coverage, and returned success. The regression exported a supported page followed by an unsupported page and returned `Ok(true)` before the fix.
- **Consequence:** A selected destination containing a previous complete export is replaced by an incomplete artifact that describes unavailable remote records as zero matches, followed by a "Logs saved" toast.
- **Fix:** Reject an unsupported page with an update instruction before writing its coverage. Existing atomic export cleanup preserves the destination and removes partial output.
- **Regression:** `unsupported_remote_logs_do_not_replace_an_existing_export` checks a mixed supported/unsupported export, the returned update instruction, the existing file contents, and removal of the temporary output. All 12 extracted-source export tests pass against actual request/page types and production writer/file-publication functions. Fixtures use temporary files only.

## NATIVE-ENTRY-5: Single-instance PATH lookup selects a non-executable file

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/single_instance.rs::resolve_program`.
- **Trigger:** A PATH directory contains a non-executable `silo-ui` file before the directory containing the launched executable.
- **Evidence:** The resolver selected the first regular file without checking execute bits. A fixture launches a temporary shell script through the same PATH: the operating system skips the non-executable decoy and runs the later script, while the original resolver returns the decoy. The regression failed with those two different paths.
- **Consequence:** The second-instance dialog can incorrectly claim a different build is running and display a path that was not launched.
- **Fix:** Require a regular file with execute bits for PATH candidates, matching Silo's existing executable-discovery checks. Update the old PATH fixture to use executable permissions.
- **Validation:** Four extracted-source tests pass, including the process-boundary regression, absolute/relative/PATH resolution, build-byte comparison, and plugin ordering. The child process is a temporary fixture script; no Silo application is launched.
