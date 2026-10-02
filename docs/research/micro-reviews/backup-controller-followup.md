# Backup controller follow-up review

Scope: `app/SiloUI/src-tauri/src/backup_controller.rs` and `backup_controller/`.

## BACKUP-CONTROLLER-3: State reads pair an old successful export with a new operation id

- **Priority:** P2.
- **Location before correction:** `app/SiloUI/src-tauri/src/backup_controller.rs:448`–`473` at `c76d22db`; journal/view handoff in `claim_export` and `recovery::begin`.
- **Trigger:** The next export writes its journal while the view still contains the previous successful export. `backup_state` clones the view and reads the journal token separately, returning the previous success under the next export's id. A read can also cross these writes after releasing the view lock.
- **Consequence:** `waitForExport` in `app/SiloUI/src/desktop/production-source.ts` accepts a successful export whose operation id matches its waiter. A delayed state read carrying this pair can return the earlier archive for the new export.
- **Suggested fix:** Hold the view lock across one journal snapshot, and use that snapshot for the operation id, unseen marker, pending status, and any result published during a journal/view handoff. Preserve a failed recovery view when its journal remains pending and no worker is running.
- **Regression:** Save the next journal while retaining the previous success view. The state must show the next operation running. Complete the next journal before publishing the view and assert that its archive is reported. Separately retain a pending recovery journal with a failed view and assert that its failure remains visible.
- **Evidence:** A disposable Rust reproduction extracted the exact production `backup_state` function with synthetic view/journal fixtures. Before correction it failed with `new export inherited previous successful result: Some(Result { success: true })`; after correction all three handoff/recovery cases passed. Native regression tests were added alongside the controller tests. Native Cargo execution remains queued on the mandated shared target lock as of this commit; no app or VM was launched.

## BACKUP-CONTROLLER-4: Failed metadata readback discards a possibly committed import

- **Priority:** P2.
- **Location before correction:** `backup_controller.rs`, `commit_import` at `94de915b`, and its enclosing `unpack_and_save`/`restore_at_paths` cleanup.
- **Trigger:** The atomic settings replacement succeeds, its later directory sync reports failure, and the readback reports an I/O error. `read_metadata(...).is_ok_and(...)` treated the failed read as proof that the sandbox was absent. It removed the pending checkpoint record and native import group; the enclosing guard and failure handler also discarded the group.
- **Consequence:** Settings can retain the new sandbox while its imported disks and recovery ownership have been deleted. The original export remains unchanged, but the saved import cannot start from its removed checkpoint.
- **Correction:** Distinguish verified absence from an uncertain readback. Preserve the group at both cleanup boundaries, retain the recovery identity, and report that Silo could not verify the commit. Relaunch recovery can finish or discard the import after settings become readable.
- **Regression:** Write actual fixture metadata, inject a late write error and readback failure, and require preservation. Cover a readable successful commit, verified absence, and the guard plus outer cleanup boundaries. The existing unreadable-directory fixture now requires retained ownership rather than deletion.
- **Verification:** The exact metadata decision function failed the fault reproduction before correction. Four source-extracted Rust cases pass after correction. Three native regressions were added; no app, real sandbox, or credential was used. Native Cargo verification uses synthetic GitHub values and a supported `TAURI_CONFIG` override excluding bundle inputs, and is queued on the shared target.

## BACKUP-CONTROLLER-5: Archive metadata is allocated before scanner limits apply

- **Priority:** P2, unresolved.
- **Adjacent scope:** `backup.rs`, `scan_snapshot_archive`, at `9b1a1243`.
- **Trigger:** Supply a zstd tar containing a large GNU longname header followed by an ordinary file. The normal tar iterator consumes the header internally before yielding the file. GNU longlink and local PAX headers use the same allocation path, even though Silo rejects them afterward.
- **Consequence:** The entry limit does not count these metadata headers. The disk-derived decompression budget permits a header far larger than a useful path; the parser builds a `Vec` of its entire body before Silo can reject it. A sufficiently large compressed header can exhaust application memory during archive review. The reproduction demonstrates acceptance and pre-validation allocation, not an actual out-of-memory termination.
- **Primary source:** The pinned `tar` 0.4.46 implementation calls `EntryFields::read_all` for these headers in [`archive.rs`](https://docs.rs/crate/tar/0.4.46/source/src/archive.rs). [`entry.rs`](https://docs.rs/crate/tar/0.4.46/source/src/entry.rs) limits initial capacity to 128 KiB but then calls `read_to_end` without a metadata bound. Raw iteration bypasses both header preprocessing and sparse map parsing, so changing the scanner to `raw(true)` alone would regress supported sparse archives.
- **Deterministic reproduction:** Extract the production scanner, limits, counting reader and cancellation type; link the existing tar/zstd rlibs with Rust 1.94.0. Build a GNU longname entry with a 1 MiB body of `a` bytes, then an empty regular `disk` entry. Compress it with zstd. Scan with a 2 MiB byte budget and `max_entries: 1`. The rejection assertion fails: `accepted hidden 1 MiB header; reported entries=1, unpacked=1050112`. No native loader, app, real data, or large allocation was used.
- **Evidence:** Disposable runner `/tmp/silo-backup-controller-header-tracer.py`; extracted harness and failing output under `/tmp/silo-codex-target/verification/backup-controller/header-tracer.rs` and `header-tracer.log`.
- **Skipped correction:** A safe change needs bounded upstream metadata preprocessing or a preflight that preserves GNU sparse framing. That requires a separate parser compatibility investigation; a raw-iterator shortcut is not a correct small fix. Require oversized GNU longname/longlink/PAX rejection before allocation, entry accounting, and the existing valid extended-sparse regressions when implementing it.
