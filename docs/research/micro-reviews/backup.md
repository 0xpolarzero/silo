# Backup micro-review

Scope: `app/SiloUI/src-tauri/src/backup.rs` and `app/SiloUI/src-tauri/src/pre_upgrade_backup.rs`.

Read-only source review. No builds, tests, app launches, or source changes. Checked the two prior review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` for duplicates.

## BACKUP-1: Publication fallback can overwrite a competing file

- **Severity:** P2.
- **Location:** `app/SiloUI/src-tauri/src/backup.rs:3169–3175` (`rename_without_replacing_with`).
- **Trigger:** The destination volume rejects exclusive rename and hard links, reaching the placeholder fallback. After `create_new` creates the empty destination, another writer atomically replaces that path with its own file before Silo calls `fs::rename(source, destination)`.
- **Evidence:** Lines 3169–3172 create and immediately drop the placeholder handle. Line 3173 then performs an ordinary replacing rename against the path, without an exclusive flag or any mechanism preventing another writer from replacing the placeholder. This interleaving therefore replaces the competing file and returns success. If the rename instead fails, lines 3173–3175 unconditionally unlink that same path, which can also remove the competing replacement. The existing test at lines 6139–6182 checks a destination occupied before the helper runs; it does not cover replacement after placeholder creation. This is source-derived evidence, not an executed race reproduction.
- **Consequence:** Export can destroy another writer's file in a shared export directory despite the helper's explicit promise never to replace an existing file. The fallback is intentionally used for volumes such as exFAT/FAT that lack hard links.
- **Suggested fix:** Preserve the no-replacement contract. Keep the exclusive-rename and hard-link paths; fail with an actionable filesystem error when neither is supported until a supported publication primitive can guarantee the contract. A path-based ownership check followed by ordinary rename retains the race. Never unconditionally unlink a destination that another writer can replace.
- **Test that would catch it:** Add a deterministic seam immediately after placeholder creation. Force exclusive rename and hard links to return their supported fallback errors, replace the placeholder with a sentinel file through the seam, and assert publication refuses to overwrite or unlink the sentinel. Exercise both successful and failed ordinary-rename outcomes of the current implementation.

No additional concrete defects found in `pre_upgrade_backup.rs` during this review.
