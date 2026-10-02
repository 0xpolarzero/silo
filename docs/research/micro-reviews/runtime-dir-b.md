# Runtime directory micro-review: runtime-dir-b

Scope: the middle third of the 14 recursively listed runtime files, sorted alphabetically, using boundaries `floor(n/3)` and `floor(2n/3)`: `contract_tests.rs`, `crash_acknowledgement.rs`, `image_cache.rs`, `lifecycle_recovery.rs`, and `operation_gate.rs`, under `app/SiloUI/src-tauri/src/runtime/`. Supporting callers were read to establish consequences. Read-only source review; no builds, tests, app launches, or production data access. Prior review reports were searched for these files and related findings. Only this report was written.

## RUNTIME-DIR-B-1: Backup dependency checks miss extent paths through aliases

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/runtime/image_cache.rs:109` (dependency predicate, lines 109–115).
- **Trigger:** A converted cache descriptor points through a symlink outside the previous runtime to an existing extent inside that runtime, and the converted cache lacks a regular local copy. This is a supported repair input: `rebind` explicitly retains an existing external extent when `cached_copy` returns `None` (lines 32–37). For example, `alias -> previous/microsandbox`, with an extent at `alias/cache/layers/sha256_<64 hex characters>.erofs`.
- **Evidence:** `reads_from` canonicalizes only `runtime`, then checks the unresolved extent against the original and canonical runtime prefixes. Neither comparison matches the alias path, although resolving that extent puts it inside the runtime. Silo itself maintains runtime-home aliases: `runtime_migration.rs:1081` derives the previous generation alias, and `pre_upgrade_backup.rs:324` removes it after backup removal.
- **Consequence:** `pre_upgrade_backup.rs:311` accepts `Ok(false)` as independence; its deletion path calls this check at line 375, then removes the previous runtime at line 378. The still-used extent is deleted and the VM loses its boot image dependency. This is a source-confirmed deletion path, not a live VM reproduction.
- **Suggested fix:** Compare each extent's resolved path against the resolved previous runtime as well as checking lexical paths. Fail closed when an extent cannot be resolved sufficiently to establish independence. Preserve the backup whenever a resolved dependency remains.
- **Test that would catch it:** Use temporary previous/converted runtime directories and an external symlink into the previous runtime. Put an extent only in the previous cache and a descriptor naming its alias in the converted cache. Run repair, assert `reads_from` returns true, and assert the backup deletion seam refuses removal. A descriptor rebound to the converted cache must allow deletion.

## RUNTIME-DIR-B-2: Partial image repair suppresses remaining errors

- **Priority:** P3
- **Location:** `app/SiloUI/src-tauri/src/runtime/image_cache.rs:154` (result selection, lines 154–156); unreadable-descriptor branch at line 142.
- **Trigger:** The cache contains one repairable descriptor and another descriptor with a missing extent. Separately, a regular descriptor that cannot be decoded as UTF-8 is silently skipped even when nothing is repaired.
- **Evidence:** A missing extent makes `rebind` return an error at line 39, recorded in `failure` at line 151. The final match returns that error only when `repaired == 0`; any successful descriptor rewrite turns the aggregate result into `Ok(repaired)`. The comment at lines 123–125 promises that missing files are reported. Read errors bypass `failure` entirely at lines 142–143. Startup (`startup.rs:185`) and conversion (`runtime_migration.rs:769`) log repair failures only on `Err`.
- **Consequence:** A broken image remains untouched while the caller receives success and loses the diagnostic explaining why that VM cannot boot. Repairing an unrelated image changes whether the same defect is reported.
- **Suggested fix:** Continue repairing independent descriptors, but retain and report every failure regardless of the success count. At minimum return the recorded error after the pass even when other descriptors were repaired, and record descriptor read errors instead of silently skipping them.
- **Test that would catch it:** Place a repairable descriptor and a missing-extent descriptor in one temporary cache. Assert the first is rewritten and repair still reports the second failure, independent of directory iteration order. Add an invalid-UTF-8 descriptor and assert repair reports an unreadable descriptor.
