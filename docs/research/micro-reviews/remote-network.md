# Remote network micro-review

Scope: `app/SiloUI/src-tauri/src/remote_network.rs`.

Evidence: source inspection only. No builds, tests, app launches, live connections, or production data access. Checked the two earlier review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md`; excluded the existing listener-readiness and controller-crash lifetime findings (R-09/R-10).

## REMOTE-NETWORK-1 — P2 — An in-flight save restores a removed port's connection intent

- **File:line:** `app/SiloUI/src-tauri/src/remote_network.rs:381–395`, removal at `:466–479`.
- **Trigger:** A save publishes a port and starts opening its SSH tunnel. Before that open finishes, a remove for the same key successfully unpublishes the owner port and clears the controller's intent and live tunnel. The older save then finishes opening and unconditionally reinserts its intent and tunnel.
- **Evidence:** Both commands use independent `spawn_blocking` jobs. `save_tunnel` releases its lock during `open` and checks only shutdown admission before committing, without checking whether port removal invalidated the operation. Removal clears only the current entries. The later read does not necessarily undo this: a still-listening guest service remains a port row after unpublication (`network.rs:521–535`), and `project_ports` preserves a live tunnel with a missing owner endpoint (`remote_network.rs:200–216`). The key is still observed, so the intent survives deletion cleanup.
- **Consequence:** A completed Remove can be undone by an earlier save: the UI again reports the port configured locally, its local SSH listener remains open, and a later owner publication reconnects it through the restored intent without another controller save.
- **Suggested fix:** Capture a per-key generation before opening, invalidate it on port removal, and verify it under the tunnels lock before committing. Drop an obsolete opened tunnel instead of inserting it.
- **Test that would catch it:** Barrier a save inside its existing open seam; complete removal for the same key; return a successful fixture tunnel from the older save. Project a still-listening, unpublished owner row. Assert that neither the live tunnel nor intent returns, and that the fixture child is closed.

## REMOTE-NETWORK-2 — P2 — An older poll deletes a newly saved connection intent

- **File:line:** `app/SiloUI/src-tauri/src/remote_network.rs:130–142`, `:240–250`.
- **Trigger:** A `network.state` request captures a snapshot without a particular port. While its response is delayed, a save publishes that port and commits a tunnel and intent. The earlier response then reaches `project_ports`, which treats the missing key as authoritative deletion.
- **Evidence:** The remote call runs before taking the tunnels lock (`:130`, `:142`). Projection gathers keys from the current live/intent maps and removes every key absent from that response (`:241–250`). Neither the request nor the saved entry carries an ordering token. This is a valid owner snapshot: `network.rs:401–407` returns only desired ports for a stopped VM, so a snapshot preceding the first publication lacks the later saved key.
- **Consequence:** A read closes the newly opened tunnel and permanently forgets its local port and scheme. A later fresh poll cannot repair it automatically because reconnect requires an intent; the user must save again. This changes backend connection ownership, beyond the earlier frontend response-publication findings.
- **Suggested fix:** Record a per-host mutation generation when starting each read and prevent older snapshots from deleting or replacing entries created by later mutations. Schedule a fresh read when an obsolete snapshot would otherwise reconcile current tunnels.
- **Test that would catch it:** Barrier a read after capturing a snapshot with no port; complete a save for that port; release the old read. Assert that the live tunnel and intent survive, then deliver a genuinely newer deletion snapshot and assert cleanup still occurs.

## REMOTE-NETWORK-3 — P2 — Tunnel admission does not enforce its 128-connection limit

- **File:line:** `app/SiloUI/src-tauri/src/remote_network.rs:351–352`, `:387–395`, reconnect at `:306–325`.
- **Trigger:** With 127 live tunnels, two saves for distinct keys both pass admission before either finishes opening. Both later commit. Separately, disconnecting hosts retains their intents while freeing live slots; new saves can fill those slots, and returning hosts reconnect all retained intents without checking the limit.
- **Evidence:** Admission counts only `live.len()` before releasing the lock and opening. No slot is reserved, and the commit has no capacity check. `disconnect_host` retains intents (`:530–545`); `project_ports` schedules each eligible intent (`:223–227`); reconnect inserts successful tunnels without any limit check (`:321–325`).
- **Consequence:** The stated 128-tunnel bound is bypassed, permitting excess SSH children, sockets, and background opens. Repeated disconnect/save/reconnect cycles can accumulate more intended connections than the admission limit.
- **Suggested fix:** Account for admitted opens and retained reconnect obligations under the same lock. Reserve capacity before launching SSH and release it on failure or removal; make background reconnect use the same admission policy.
- **Test that would catch it:** Use barriers to admit two distinct saves at 127 live entries and assert no more than 128 total connections commit. Retain 128 intents across a fixture disconnect, attempt another save, and reconnect the original keys; assert the chosen capacity policy remains bounded.
