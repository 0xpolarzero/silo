# System integrations and shutdown micro-review

Scope: `app/SiloUI/src-tauri/src/system_integrations/` and `app/SiloUI/src-tauri/src/system_shutdown/`. Read the parent modules and notification/shutdown callers to establish reachability. Source review only; no builds, tests, application launches, or live data access. Checked the two existing review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md`; the findings below are not already reported there.

## SYSTEM-INTEGRATIONS-1: Concurrent deliveries create untracked duplicate notifications

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/system_integrations/linux.rs:329`, `:354`, `:364`.
- **Trigger:** Two notifications with the same previously unseen key arrive while the first `Notify` request is in flight. This is reachable because `notifications.rs:129–131` spawns an independent blocking task for each notice, without serializing delivery.
- **Evidence:** The replacement-ID lookup releases `SERVER_IDS` before the D-Bus call. Both workers can read zero, then send `Notify(replaces_id=0)`, obtaining distinct IDs. Each subsequently inserts its ID under the same key; the last insert overwrites the first. The [Desktop Notifications protocol](https://specifications.freedesktop.org/notification/latest/protocol.html#command-notify) defines zero as creating a notification without replacing an existing one.
- **Consequence:** Both notices remain visible despite the same-key replacement contract. Only one ID remains in the map, so `clear_notifications` at lines 375–389 can close only one of them after sandbox deletion. An older failure can remain visible alongside a newer result.
- **Suggested fix:** Serialize lookup, server mutation, and ID publication through one delivery owner, including clearing. Preserve ordering for each key; locking only the map accesses does not make this transaction atomic.
- **Test that would catch it:** Use a fake notification server and barriers to hold the first reply while starting a second delivery for the same key. Assert one live notification remains and clearing the key leaves none. Assert the second delivery replaces the first server ID instead of using zero. Run this through the delivery seam, not a standalone map test.

## SYSTEM-INTEGRATIONS-2: Notification IDs survive a change of server identity

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/system_integrations/linux.rs:304`, `:307`, `:329`, `:380`.
- **Trigger:** Silo delivers a notice for sandbox A, the desktop notification service restarts, then Silo delivers a notice for sandbox B. The new service allocates an ID equal to A's old ID. A later replacement or deletion of A uses that stale ID against the new service.
- **Evidence:** `SERVER_IDS` stores only `key -> u32`. Every delivery/clear creates a proxy to the current well-known bus name, checks only whether an owner exists, and uses cached IDs without comparing the owner's unique D-Bus identity. There is no owner-change invalidation. Concrete sequence: old server assigns A ID 1; new server assigns B ID 1; clearing A sends `CloseNotification(1)` to the new server and removes B. Both servers can independently allocate IDs starting at 1. The [Desktop Notifications protocol](https://specifications.freedesktop.org/notification/latest/protocol.html) addresses replacement and closing solely by numeric server-assigned ID; it also invalidates IDs on `NotificationClosed`, which this implementation does not consume.
- **Consequence:** Deleting one sandbox can withdraw another sandbox's notice, or updating one key can replace another key's notice. The cached integer does not identify the server that issued it.
- **Suggested fix:** Associate cached IDs with the service's unique owner, invalidate them when that owner changes, and target calls to that same owner so a restart between validation and the call cannot reuse stale IDs. Remove closed IDs when processing `NotificationClosed`.
- **Test that would catch it:** In an isolated session bus, have fake server owner A allocate ID 1, replace it with owner B which allocates ID 1 to a different key, then clear/update the old key. Assert B's notice survives and the old key is delivered with `replaces_id=0`. Include an owner change between lookup and the method call.
