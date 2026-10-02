# Backup fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/backup.rs` and `app/SiloUI/src-tauri/src/pre_upgrade_backup.rs`.

## BACKUP-2: A parseable retention record can panic backup reads and scheduled cleanup

- **Severity:** P3.
- **Location:** `app/SiloUI/src-tauri/src/pre_upgrade_backup.rs:95` (record validation) and the unchecked addition in `delete_at`.
- **Trigger:** A damaged or edited version-1 record contains `startedAt: "9999-12-31T23:59:59Z"`. It parses as RFC 3339 but adding 14 days exceeds the date range. A negative-offset start can also place the resulting UTC deletion date beyond that range.
- **Consequence:** Status reads panic instead of showing the retained backup, and the scheduled cleanup thread terminates. The record is accepted on every subsequent launch.
- **Evidence:** A standalone Rust test using the exact production `Record`, `Saved`, `load`, and `delete_at` code reproduced `resulting value is out of range` with the synthetic record. No app or real backup was accessed.
- **Fix:** Validate both retention addition and UTC conversion with checked operations before treating a loaded record as valid. Keep invalid records unchanged and use the existing manual-deletion behavior.
- **Regression:** Extend the existing unreadable-record behavior test with arithmetic-overflow and UTC-conversion-overflow dates. It asserts status remains readable, automatic deletion stays disabled, acknowledgment preserves the record, and manual deletion succeeds.
