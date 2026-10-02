# Desktop micro-review

Scope: `app/SiloUI/src-tauri/src/desktop.rs`.

Read-only source review. Checked the first and second review reports in the main checkout and all `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` reports for prior findings. No builds, tests, app launches, or production data access.

## DESKTOP-1: Queued desktop actions can target a replacement VM

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/desktop.rs:607`, `:619`; remote identity is discarded at `:578`.
- **Trigger:** A computer-wide configuration operation replaces VM A with VM B using the same name. While that operation holds the computer gate and metadata still contains A, a desktop action resolves the name to A's ID and waits in `OPERATIONS.vm`. Once replacement completes, the waiting action acquires A's gate but `machine(app, workspace)` resolves the name again and returns B. A remote request has the same problem: `dispatch` converts its explicit `vmId` to a name before entering `local`.
- **Evidence:** `local` captures `vm_id` at line 607 only for gate acquisition, then drops it before resolving the machine at line 619. `machine_at` at lines 325–342 verifies the inspected runtime against the newly read metadata, so B's correct labels pass; it never compares B's ID with A's captured ID. `runtime::apply_whole_configuration_with_progress` explicitly supports removing and creating machines with the same name in one batch (`runtime.rs:5135–5183`). The operation gate blocks VM turns during a computer turn, keys VM turns solely on their supplied ID, and does not invalidate waiting entries when metadata changes (`runtime/operation_gate.rs:206`, `:609`, `:666–706`). This is a source-confirmed interleaving, not an executed reproduction.
- **Consequence:** A queued Start, Stop, Restart, streamer update, or computer-use setup for A can execute against B. It also holds A's gate while mutating B, so B's own per-VM operations can overlap it. Remote callers' explicit VM identity does not prevent this retargeting.
- **Suggested fix:** Preserve the expected stable VM ID through dispatch and local execution. After acquiring the VM gate, resolve fresh metadata and reject a missing or changed identity before inspecting or executing guest commands. Keep the existing runtime-label check as a separate verification.
- **Test that would catch it:** Hold a computer gate, queue a desktop action for A, replace metadata and runtime fixtures with B under A's former name, then release the computer gate. Assert the action returns an identity/missing-VM error and sends no guest or Start command to B. Repeat with a remote request containing A's `vmId`; verify no turn for A can perform work on B.
