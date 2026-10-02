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
