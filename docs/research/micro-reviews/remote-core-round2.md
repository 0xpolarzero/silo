# Remote core second fix loop

Scope: `app/SiloUI/src-tauri/src/remote.rs` and adjacent remote modules.

## REMOTE-CORE-5: SSH key authorization bypasses remote-change admission

- **Severity:** P2.
- **Location:** `remote.rs`, `METHODS` entry for `ssh.access.connection`; owner dispatch `handle`. Adjacent evidence: `ssh_access.rs::remote_dispatch` takes the computer operation gate, and `remote_with` calls `authorize_controller`, which persists a controller key and reconciles SSH listeners.
- **Trigger:** Key authorization waits behind another owner operation, then remote-management access is revoked or the request is retried after losing its connection.
- **Consequence:** Classification as a read bypasses the remote registry's admission condition, deadline, controller-disconnect checks and replay record. A key authorization can execute after access is revoked, and the same operation ID can execute twice.
- **Regression:** Dispatch-level behavior tests with a false permission probe and with repeated operation identity both failed before the fix: revoked work executed, and replay executed twice. These tests run against the actual owner registry and synchronous operation gate in a disposable harness; authorization execution is a counted seam, without live VMs.
- **Fix:** Classify key authorization as a change. Preserve older controllers' identity-free request shape by generating an owner-side identity and bounded admission deadline specifically for this legacy method. Old controllers receive admission protection; replay deduplication requires the identity supplied by updated controllers. Other change methods still require an explicit valid operation identity and deadline.

## REMOTE-CORE-6: Special operation markers block the registry or permit replay

- **Severity:** P2.
- **Location:** `remote/operations.rs::read_marker`; `Registry::accept` reads the marker while holding the shared registry mutex.
- **Trigger:** An existing operation marker path is a FIFO with no writer, or a symlink whose target disappears.
- **Consequence:** A FIFO blocks marker opening before the byte limit applies and holds the registry mutex indefinitely, preventing all other remote changes. A dangling symlink was treated as an absent marker, allowing an already-recorded identity to be accepted again. A symlink to a regular file also borrowed that unrelated file's status.
- **Regression:** A child-process fixture reading a FIFO did not finish within two seconds before the fix. A symlink fixture returned `finished` from an external target instead of conservative uncertainty. Both leave live SSH and VMs untouched; only the owned blocked test child is terminated.
- **Fix:** Open markers without following symlinks and without blocking on special files; accept only a regular file's contents. Existing unexpected entries remain uncertain and are preserved. Missing paths remain absent, and the 16 MiB legacy-record bound remains unchanged.

## REMOTE-CORE-7: A special settings file blocks remote-management reads

- **Severity:** P2.
- **Location:** `remote.rs::read_config_in`; settings commands and authorization read this file while holding `CONFIG_LOCK`.
- **Trigger:** The existing `config.json` path is a FIFO without a writer.
- **Consequence:** File opening blocks before the 1 MiB read limit applies. The caller retains the configuration mutex, preventing other settings and authorization reads from completing.
- **Regression:** A child-process fixture takes the settings lock and opens a temporary FIFO. Before the fix it did not return within two seconds. The parent terminated only that owned child with SIGTERM; the FIFO remains intact. After the fix the reader returns the explicit regular-file error promptly.
- **Fix:** Open configuration nonblockingly and require a regular file before reading. Preserve regular files, the existing size bound, and the existing missing-file initialization.

## Verification

Disposable Rust harnesses compile exact source slices and the actual adjacent registry module against cached dependencies, without app or VM launches. The registry uses the production synchronous operation gate; the dispatch harness supplies a fixture shutdown-admission function. These are deterministic behavior checks, not a complete native build or live remote qualification. The final harness run passed 22 tests, including all three findings and existing settings size/publication tests. Each commit passed Rust formatting, frontend typecheck, frontend lint, and diff checks. Full native `cargo test --locked remote::` remained queued on the shared artifact lock; no native application-test result is claimed.
