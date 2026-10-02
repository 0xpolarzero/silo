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
