# Remote network fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/remote_network.rs`.

## REMOTE-NETWORK-4 — P2 — Rejected snapshots leave reconnect state partially committed

- **File:line at discovery:** `remote_network.rs:256–270, 281–282, 304–306` and the fallible row/port parsing later in the same projection loop.
- **Trigger:** The first row has an intended port whose tunnel needs reconnecting; a later row lacks a VM identity or has an invalid port. Projection records the first key in `connecting`, then returns an error for the later row. The caller never receives the queued reconnect and never starts its worker.
- **Consequence:** Later valid polls cannot enqueue that reconnect because the key remains marked in progress. If the first row changed the endpoint of an existing tunnel, that working tunnel is also removed and dropped despite rejection of the snapshot.
- **Evidence:** Both extracted production behavior regressions failed before the correction: `an_invalid_snapshot_cannot_strand_a_reconnect` and `an_invalid_snapshot_keeps_the_existing_tunnel`. The former rejects a missing identity after an eligible port; the latter rejects an out-of-range port after an endpoint change. No live SSH connection or app launch was used.
- **Suggested fix / implemented correction:** Validate every row identity, port array, and guest-port integer before changing any tunnel map or reconnect state.
- **Tests that catch it:** A rejected snapshot must leave `connecting` clear so the next valid snapshot queues reconnect; a rejected snapshot must retain its existing live fixture tunnel.

The initial audit remains in the shared review worktree at `docs/research/micro-reviews/remote-network.md`. The three initial fixes each have separate changesets and commits. Native Cargo validation uses the prescribed shared target and synthetic GitHub configuration; the single-threaded extracted tests stub unrelated shutdown admission, app-free host naming, unused temporary-directory ownership, and the native isolation guard. They compile the actual changed functions and actual regression test bodies against the shared target's serde_json and UUID libraries.

## Fixes and validation

- REMOTE-NETWORK-1: `7a80db83`, folded. Pending saves are invalidated by successful port removal; the publication and opening windows have regressions.
- REMOTE-NETWORK-2: `0e96253d`, folded. Per-computer revisions reject older observations; pending saves block only their own computer's reconciliation.
- REMOTE-NETWORK-3: `79020961`, folded. Admission reserves slots for pending saves and retained intents; failures release their slot and configured connections remain editable at capacity.
- REMOTE-NETWORK-4: Validate the complete snapshot before reconciling tunnels; two failing regressions now pass.

`cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`, `npm --prefix app/SiloUI run typecheck`, and `npm --prefix app/SiloUI run lint` pass. The extracted behavior suite passes 11 tests, including nine new regression tests, one existing save behavior test, and the first minimal removal reproduction. Each defect's extracted regression failed before its implementation. Exact logs are local `/tmp/remote-network-*-seam-red.log` / `*-green.log` and `/tmp/remote-network-4-all-seams.log`.

The prescribed full-module command, `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked remote_network::tests`, remains queued behind the shared Cargo target lock at this report's writing. This is not a native-suite pass. No packaged bundle was inspected; all exercised processes are disposable fixture children.

## REMOTE-NETWORK-5 — P2 — Superseded reconnect workers restore tunnels and consume newer work

- **File:line at discovery:** `app/SiloUI/src-tauri/src/remote_network.rs:438–465` and `:675–714`.
- **Trigger:** Cleanup runs while a background SSH open is pending, or the user removes/recreates the same port while the old attempt is pending. The old worker checks only equal intent values and absence of a live tunnel, then removes the shared connecting marker without verifying ownership. An endpoint change during an open also cannot schedule its replacement because the original marker suppresses it.
- **Consequence:** A late worker restores a tunnel after cleanup or installs an obsolete endpoint while consuming a newer worker's marker.
- **Fix:** Store each reconnect as an identity-bearing request shared by projection and its worker. Only that request can remove its marker and commit. Cleanup and new saves invalidate requests; endpoint changes replace them. Completion also checks shutdown admission.
- **Regression evidence:** `a_reconnect_cannot_restore_a_tunnel_after_close_all`, `an_older_reconnect_cannot_clear_a_newer_attempt`, and `an_endpoint_change_replaces_the_pending_reconnect` all failed before the fix and pass afterward. All 14 extracted behavior tests pass, including the 11 previous checks. Formatting, typecheck, lint, and whitespace checks pass. Native Cargo testing remains queued on the shared target lock. No app or live VM was launched.

## REMOTE-NETWORK-6 — P2 — Failed workspace observations erase connection intents

- **File:line at discovery:** `app/SiloUI/src-tauri/src/remote_network.rs` missing-key cleanup in `project_ports`; owner producer `app/SiloUI/src-tauri/src/network.rs:434–441` and `:787–792`.
- **Trigger:** The owner cannot reread network configuration for a running VM, or a workspace observation worker panics. Its network snapshot includes that VM with an error and an empty ports array. Projection treats the missing ports as authoritative deletion.
- **Consequence:** A temporary observation failure kills working controller tunnels and forgets their chosen local ports and schemes, preventing automatic recovery after the owner can inspect the VM again.
- **Fix:** Exclude VMs with observation errors from missing-port deletion. Successfully observed VMs and genuinely absent VMs retain normal cleanup behavior.
- **Regression evidence:** `a_workspace_observation_error_does_not_forget_its_connections` and `an_observation_error_preserves_only_that_workspaces_intents` both failed before the fix. All 16 extracted behavior tests pass afterward; the tests also confirm that a later successful deletion removes the intent. Formatting, typecheck, lint, and whitespace checks pass. No live VM or app was used.

## REMOTE-NETWORK-7 — P2 — Recreated sandbox identities are assigned to older port snapshots

- **File:line at discovery:** `app/SiloUI/src-tauri/src/remote_network.rs:164–183`, `read_host_state`.
- **Trigger:** Network observation captures a sandbox's ports, then that sandbox is deleted and another sandbox with the same name is created before the metadata lookup that assigns `vmId`.
- **Consequence:** Ports captured for the old sandbox are labeled with the replacement sandbox's immutable ID, so a controller cannot distinguish the old snapshot from the new sandbox's endpoints.
- **Fix:** Capture name-to-ID mappings before and after network observation and reject any row whose identity changed. Stable rows do not fail for unrelated metadata changes.
- **Regression evidence:** `a_recreated_vm_cannot_relabel_an_older_network_snapshot` and `a_vm_created_during_observation_requires_a_fresh_identity_snapshot` failed before the identity guard and pass afterward. `stable_vm_identity_survives_unrelated_metadata_changes` verifies the guard is scoped to observed rows. All 19 extracted tests, formatting, typecheck, lint, and whitespace checks pass. No live VM or app was used.

## REMOTE-NETWORK-8 — P2 — Older polls overwrite newer observed endpoints without a mutation

- **File:line at discovery:** `app/SiloUI/src-tauri/src/remote_network.rs`, `read` and `project_observed`.
- **Trigger:** Two requests for the same computer share an unchanged mutation revision. The newer request projects the current endpoint first; the delayed earlier request then projects an older endpoint or an empty port set.
- **Consequence:** The old request replaces the newer reconnect endpoint or closes a tunnel just verified by the newer request. Mutation-only ordering does not protect observations from one another.
- **Fix:** Give each requested observation a per-computer identity and accept only the latest request at reconciliation. Cleanup invalidates outstanding observations. Other computers retain their own independent ordering.
- **Regression evidence:** `an_older_poll_cannot_replace_a_newer_reconnect_endpoint` and `an_older_poll_cannot_delete_a_tunnel_verified_by_a_newer_poll` failed before the request-identity guard and pass afterward. All 21 extracted behavior tests, formatting, typecheck, lint, and whitespace checks pass.

The second-loop native Cargo attempt acquired the shared target lock but failed in Tauri's permission build because this worktree lacked `binaries/msb-aarch64-apple-darwin`. The original failure is retained in `/tmp/remote-network-round2-native.log`. Existing prepared `binaries` and `runtime` directories from the main checkout are now linked into this worktree for a focused native retry; no runtime preparation, app launch, real VM, or production state access occurred. The retry uses the prescribed shared target and all three synthetic GitHub values. Its log is `/tmp/remote-network-round2-native-resources.log`.
