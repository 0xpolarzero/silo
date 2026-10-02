# Runtime migration micro-review

Scope: `app/SiloUI/src-tauri/src/runtime_migration.rs` and `app/SiloUI/src-tauri/src/runtime_migration/`.

Read-only source review. No builds or tests were run, as required by `/tmp/silo-micro.md`. Existing review findings were checked; the previously reported late Retry response is excluded.

## RUNTIME-MIGRATION-1: Retry deletes a committed converted generation

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/runtime_migration.rs:737–748`, with commit at `808–809` and retry admission at `968–980`.
- **Trigger:** Conversion selects `runtime-checkpoints-converted`, then quarantine fails. The existing `launch_finishes_a_conversion_that_stopped_between_commit_and_quarantine` test constructs this exact failure using an occupied quarantine destination. The worker records `failed`, exposing Retry. Retry resets the verified count and calls `convert_with` again; it does not check the generation marker before deleting the staged directory.
- **Consequence:** The selected, verified runtime is deleted and recopied unnecessarily. If that retry fails before all machines are verified, the marker still selects the converted generation but its persisted verified count is incomplete. On relaunch, `initial` rejects it at lines 185–191 and `install` sets `writable=false`, disabling both recovery commands. Original data remains in `runtime/`, but recovery now requires manual repair. Continue also cannot select CLEAN while the CONVERTED marker exists.
- **Suggested fix:** Treat an existing generation marker as a committed migration. Resume quarantine and restart without resetting verified progress or deleting the selected generation. Restrict destructive staging cleanup to unselected generations.
- **Test that would catch it:** Extend the existing commit/quarantine-failure fixture with an in-session Retry. Fail the retry at its Copying callback, which currently occurs after deletion. Assert the committed tree and verified count remain unchanged, no adoption runs again, and fixing the quarantine obstruction permits recovery without manual edits.

## RUNTIME-MIGRATION-2: Missing selected metadata is accepted as a valid empty runtime

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/runtime_migration.rs:170–193`.
- **Trigger:** A generation marker and completed migration record exist, but the selected generation's `machines.json` or entire directory is missing. `runtime::read_metadata` (`runtime.rs:5925`) deliberately returns a successful empty configuration for NotFound. `initial` uses that permissive reader to verify selected storage and skips all count checks when the record is already complete.
- **Consequence:** Startup rewrites the migration record as complete and opens the runtime gate despite missing committed storage. Existing sandboxes disappear from the configured machine list instead of producing a storage-recovery error. `previous_generation_is_backup` also continues to classify the original generation as a removable backup based only on the marker and completed record.
- **Suggested fix:** Require the selected generation directory and its metadata file to exist and be readable before admitting it. Preserve legitimate empty metadata and post-migration additions/deletions; existence validation does not require comparing current VM counts to historic migration counts.
- **Test that would catch it:** Create a valid completed converted generation, remove its metadata, then call `initial`. Assert an error, unchanged migration record, and a closed runtime gate. Repeat with the whole selected directory absent, and include an explicitly empty metadata file as a valid control.
