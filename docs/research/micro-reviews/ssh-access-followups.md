# SSH access fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/ssh_access.rs`.

The original read-only review remains in the shared micro-review worktree.
SSH-ACCESS-1 was fixed and folded as `cd372275`; SSH-ACCESS-2 was fixed and
folded as `53b71a44`. Each has a regression that failed against the preceding
production implementation in an extracted Rust harness before its fix.

## SSH-ACCESS-3: Initial port selection ignores the network binding

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/ssh_access.rs`, initial port selection in `save_with` (lines 849–855 of the original reviewed file), now `available_port`.
- **Trigger:** First enable with a specific network address and default port 2222 when the first free loopback port is occupied on that network address.
- **Evidence:** The original selector checks saved port reservations and binds only `127.0.0.1`. `spawn` subsequently binds both loopback and the configured network address. The policy regression supplies an occupied network port and a free loopback port; the unchanged selector returned 2222 instead of 2223.
- **Consequence:** Initial enable chooses an unusable endpoint and rolls back its loopback listener when the network bind fails, although the next port is available.
- **Suggested fix:** Check both required bindings before choosing the initial port, retaining saved reservations.
- **Test that catches it:** `initial_port_skips_an_occupied_network_binding` injects bind availability at the port-selection seam. It requires skipping occupied network ports and enabled sandbox reservations. The original selector failed the first assertion; the corrected selector passes both.

## Verification boundaries

SSH-ACCESS-4: `remote.rs` classified `ssh.access.connection` as `Access::Read`
after the method began registering controller keys. Repeating one request ran
the handler twice and wrote no operation marker. The new
`ssh_key_registration_is_recorded_once_per_request` handler regression failed
with two executions, then passed after classifying registration as a change.
The existing all-method replay/read regression also passed. The dispatcher
harness uses the production request handler, configuration readers/writer,
operation journal, and gate; only host-directory selection and shutdown
admission use fixture adapters.

The disposable Rust harness extracts production save, controller-registration,
configuration, validation, and editor key helpers directly from this worktree.
Runtime metadata and operation admission use fixture adapters; reconciliation
and state reporting are stubbed. It exercises real temporary files and system
`ssh-keygen`, and does not launch an app or VM. Harness files and logs remain at
`/tmp/silo-codex-target/verification/ssh-access` and `/tmp/silo-ssh-access-*.log`.

Formatting, frontend typecheck, and frontend lint passed. The harness also passed
Clippy with existing/helper-fixture warnings. A full native Cargo invocation was
queued on the shared artifact lock; harness results do not establish native
module compilation, listener integration, packaged-app behavior, or live VM health.

For legacy enabled settings with no recorded managed identity and neither key
file, disabling now reports a recovery error and leaves settings unchanged.
Restoring the managed `.pub` file makes revocation succeed without deleting user
keys. Newly saved settings retain the public identity independently of key files.
