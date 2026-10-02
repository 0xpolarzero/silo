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

## BACKUP-3: A failed directory sync deletes the published path without checking ownership

- **Severity:** P2.
- **Location:** `app/SiloUI/src-tauri/src/backup.rs`, publication at the end of `write_immutable_package`.
- **Trigger:** The verified export is published, another writer replaces that path, and syncing the destination directory fails.
- **Consequence:** Error cleanup deletes the other writer's file. Without a replacement, it also deletes the already-verified export when the filesystem cannot confirm directory durability.
- **Evidence:** The exact production publication seam and a temporary-file regression reproduced a missing replacement file after an injected `EIO` from directory syncing. No live runtime or real export was used.
- **Fix:** Keep the committed path after publication. Return the sync error without unlinking a path whose ownership can already have changed.
- **Regression:** Exercise real exclusive publication with an injected sync failure, both with and without another writer's atomic replacement. Assert the error remains reported and the expected file bytes remain. The extracted production seam and three publication tests pass; this does not substitute for the complete native suite.

## BACKUP-4: Retention records can block readers or allocate without a bound

- **Severity:** P2.
- **Location:** `app/SiloUI/src-tauri/src/pre_upgrade_backup.rs`, `load`.
- **Trigger:** `pre-upgrade-backup.json` is a FIFO with no writer, or is an oversized file. The old `fs::read` opens the FIFO in blocking mode and reads files without a byte limit.
- **Consequence:** The FIFO stalls status and acknowledgment while holding the shared record mutex, and scheduled cleanup cannot continue. Oversized files can consume memory proportional to their contents. Symlinks also allow an unrelated record to drive automatic deletion.
- **Evidence:** The exact production loader failed a one-second FIFO regression; fixture cleanup released and joined its blocked reader. A padded valid record beyond 64 KiB was accepted by the old loader.
- **Fix:** Reuse the export module's no-follow, nonblocking regular-file opener and cap retention reads at 64 KiB, including a growth check on the opened handle. Unverifiable records use the existing unreadable-record policy, keeping automatic deletion disabled.
- **Regression:** FIFO reads finish promptly without removing the FIFO; records at the limit remain valid, larger records and symlinks remain unreadable and untouched. Fixture tests also verify normal retention, unreadable-record manual deletion, and converted-runtime preservation.
