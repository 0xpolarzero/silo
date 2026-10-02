# Runtime directory fix loop: runtime-dir-c

Scope: `remote_ops.rs`, `shutdown.rs`, `storage.rs`, `storage/tests.rs`, and `update_recovery.rs` under `app/SiloUI/src-tauri/src/runtime/`. The original audit remains in the shared review worktree's `docs/research/micro-reviews/runtime-dir-c.md`. All fixes were made in `codex-fix-runtime-dir-c`; no app, real VM, or production data was used.

- `runtime-dir-c-1`: fixed and folded in `2c213d28`. The update inventory refuses journal-owned runtime VMs missing from committed metadata. Added tests cover absent metadata, another committed VM, and an unfinished configuration with no runtime VM.
- `runtime-dir-c-2`: fixed and folded in `d5b80095`. Storage uses pending-view runtime presence, measures preserved disks, retains errors, and requires restore recovery before reclamation. Added command-level tests cover Running and Stopped attempts and an unstarted pending restore.

## runtime-dir-c-3 — P2 — Concurrent qcow2 growth falsely fails reclamation

- **Location:** `app/SiloUI/src-tauri/src/runtime/storage.rs:500`, `preserve_length()` and its call from `trim_triggered()`.
- **Trigger:** A workspace has a writable qcow2 head after a checkpoint or restore. Concurrent guest writes allocate additional host clusters during reclamation, increasing that file's length.
- **Evidence:** The guard compares each host file's length before and after the guest command and rejects every increase. A disposable reproduction of the exact production guard grew a file from 8 KiB to 12 KiB while preserving its prefix; it returned “The workspace disk size changed during reclamation.” The [QEMU image documentation](https://www.qemu.org/docs/master/system/images) explains that qcow2 images grow as storage is allocated. The [qcow2 format specification](https://www.qemu.org/docs/master/interop/qcow2.html) distinguishes host clusters from the virtual disk size stored in the header. Silo's reclamation documentation already permits concurrent guest writes, and its runtime gate does not pause the guest.
- **Consequence:** A successful guest trim is reported and journaled as a failure; its successful maintenance timestamp is discarded. The guard confuses host image length with guest disk capacity.
- **Fix:** Permit qcow2 host-file growth. Retain raw-file growth rejection and shortened-file restoration/error reporting for every format. Never truncate the grown file.
- **Regression test:** Append guest-write bytes during the fake runtime's trim of a writable qcow2 head. Assert successful maintenance, a zero reclaimed-byte result when total allocation increases, and preservation of both old and new bytes. Repeat with raw-file growth and require failure without truncating its bytes.

## Verification

Disposable Rust harnesses extract the unchanged production decision functions directly from source. The update-inventory and Storage-command harnesses stub their surrounding dependencies; the file-length harness uses the production guard and real temporary files. Each failed before its fix and passed afterward. These reproductions establish the reviewed decisions, not full application integration or live VM behavior.

Full-crate Cargo regressions were queued with the shared `/tmp/silo-codex-target` and synthetic GitHub test configuration. Shared Cargo-lock contention delayed those runs; their results must be checked separately. Rust formatting, frontend typecheck, and lint passed before the first two commits. Failure outputs and disposable harnesses remain local in ignored verification storage or `/tmp/runtime-dir-c-*` files.
