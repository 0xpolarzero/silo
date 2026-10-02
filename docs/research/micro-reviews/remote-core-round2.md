# Remote core second fix loop

Scope: `app/SiloUI/src-tauri/src/remote.rs` and adjacent remote modules.

## REMOTE-CORE-5: SSH key authorization bypasses remote-change admission

- **Severity:** P2.
- **Location:** `remote.rs`, `METHODS` entry for `ssh.access.connection`; owner dispatch `handle`. Adjacent evidence: `ssh_access.rs::remote_dispatch` takes the computer operation gate, and `remote_with` calls `authorize_controller`, which persists a controller key and reconciles SSH listeners.
- **Trigger:** Key authorization waits behind another owner operation, then remote-management access is revoked or the request is retried after losing its connection.
- **Consequence:** Classification as a read bypasses the remote registry's admission condition, deadline, controller-disconnect checks and replay record. A key authorization can execute after access is revoked, and the same operation ID can execute twice.
- **Regression:** Dispatch-level behavior tests with a false permission probe and with repeated operation identity both failed before the fix: revoked work executed, and replay executed twice. These tests run against the actual owner registry and synchronous operation gate in a disposable harness; authorization execution is a counted seam, without live VMs.
- **Fix:** Classify key authorization as a change. Preserve older controllers' identity-free request shape by generating an owner-side identity and bounded admission deadline specifically for this legacy method. Old controllers receive admission protection; replay deduplication requires the identity supplied by updated controllers. Other change methods still require an explicit valid operation identity and deadline.
