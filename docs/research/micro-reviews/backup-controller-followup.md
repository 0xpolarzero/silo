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
