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

## runtime-dir-c-4 — P1 — Failed restore falsely completes secret revocation

- **Location:** `app/SiloUI/src-tauri/src/runtime.rs`, `observe_vm()` and `revoke_secret_with()`.
- **Trigger:** A failed checkpoint restore leaves a running VM and its `pending_checkpoint_restore` record. Remove an assigned secret while that VM still exposes its binding.
- **Evidence:** `observe_vm()` returned `Absent` solely because the pending selector existed. `revoke_secret_with()` interprets `Absent` as successful revocation and never calls the removal callback; the retry ledger can then retire while the running VM retains access. The pending-view rules already distinguish an unattempted selector from a restore attempt that created a VM.
- **Consequence:** Secret removal reports success without revoking the preserved running VM. Terminal, file, and network observation also incorrectly treat that VM as absent.
- **Fix:** Use pending-view rules to bypass runtime inspection only for an unattempted restore. After a restore attempt, inspect actual state and propagate errors; a genuinely missing runtime VM remains absent. Keep the original pending selector for explicit recovery.
- **Regression test:** A pending attempted restore that still exposes a revoked binding must execute the removal callback and retain the pending revocation if post-removal inspection still exposes the binding. Extend the observation/terminal regression to cover a running attempted restore and a missing attempt. An unattempted restore still performs no runtime command.
- **Focused reproduction:** The exact production observation function and pending-view predicate, extracted into a disposable Rust harness, failed the attempted-restore assertion before the fix while its unattempted no-query check passed. Both checks pass afterward. Full-crate native verification remains subject to the shared Cargo lock.

## runtime-dir-c-5 — P2 — Launch accepts a running replacement by name

- **Location:** `app/SiloUI/src-tauri/src/runtime.rs`, `start_at_launch_with()`.
- **Trigger:** A launch-selected metadata VM has a managed runtime VM under the same name but a different immutable ID. The replacement is already Running.
- **Evidence:** Launch inspected the name and checked only the managed label before returning `LaunchStart::Done`. The desired-state path never entered lifecycle recovery, where identity normally gets checked. The extracted production function returned `Ok(Done)` for a replacement ID in the failing regression.
- **Consequence:** Startup reports the selected sandbox as ready and omits the replacement warning even though that exact sandbox is absent. The running replacement is not started or stopped by this branch.
- **Fix:** Reuse `ensure_machine_identity()` before accepting any launch observation, including Running.
- **Regression test:** Both a changed runtime ID under the selected name and an unexpected observed name must report an identity error without mutation. Existing matching-ID Running behavior remains successful and mutation-free. The extracted launch-function checks fail before and pass after the fix; native integration validation remains queued behind the shared Cargo lock.

## runtime-dir-c-6 — P2 — A completed uncommitted stop still fails Quit

- **Location:** `app/SiloUI/src-tauri/src/runtime/shutdown.rs`, `stop_uncommitted_vm()`.
- **Trigger:** A VM created before metadata publication stops, but the runtime command client reports a timeout or other error after applying the stop.
- **Evidence:** The Stop branch propagated the command error immediately with `?`, without another inspection. Committed lifecycle shutdown already verifies desired state after command failures. The extracted production helper returned the timeout in a fixture whose exact VM was Stopped after the command.
- **Consequence:** Quit reports a shutdown failure and leaves the app open even though its owned VM stopped. A second Quit succeeds after inspecting the already-stopped VM.
- **Fix:** After a command error, re-inspect the exact journal-owned identity. Accept only Stopped, Created, or Crashed; otherwise retain the command error. An unreadable or replaced VM still blocks Quit.
- **Regression test:** The full uncommitted shutdown transaction must succeed when fake Stop commands set their VMs Stopped before returning timeout errors, and preserve the unfinished configuration journal. The same fixture must fail if the commands leave the VMs Running. Both extracted helper checks pass after the fix; the completed-stop assertion failed before it.

## runtime-dir-c-7 — P2 — Reusing a removed VM's name blocks Quit

- **Location:** `app/SiloUI/src-tauri/src/runtime/shutdown.rs`, `stop_local_vms_with()`.
- **Trigger:** An unfinished configuration transaction removes a VM and creates another under the same name with a different immutable ID. Its journal retains both identities, whether the replacement metadata has been published or not.
- **Evidence:** Shutdown selected both identities by name. The removed identity failed verification against the present replacement, so Quit failed even after stopping the replacement. The extracted shutdown function failed with an identity error for both metadata-publication cases.
- **Consequence:** A successfully stopped replacement leaves the app unable to Quit until configuration recovery clears the journal.
- **Fix:** Skip an absent journal identity only when an exact-name, managed runtime inspection matches a different known identity under that name. The present identity still follows normal shutdown verification; unknown identities remain errors.
- **Regression test:** Both committed and uncommitted replacements stop successfully without discarding their recovery journal. The extracted production shutdown function failed before and passes after the fix. Native regressions were added; full-crate execution remains blocked by the shared Cargo lock. Rust formatting, frontend typecheck, lint, and diff checks passed for the fixes in this loop.

## Final native verification result

The queued native test command eventually acquired the shared Cargo lock, then exited 101 before compiling the application tests: Tauri's build script could not find `binaries/msb-aarch64-apple-darwin` in this worktree. The preserved output is `/tmp/runtime-dir-c-4-native.log`. No runtime preparation or app launch was performed. The native regressions require a prepared test environment; their full-crate compilation and execution remain unverified. The failing-before/passing-after source-extracted reproductions and formatting/typecheck/lint checks passed, including the final name-reuse reproduction after merging integration.
