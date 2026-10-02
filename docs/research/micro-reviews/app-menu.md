# App menu and notifications micro-review

Scope: `app/SiloUI/src-tauri/src/app_menu.rs` and `app/SiloUI/src-tauri/src/notifications.rs`.

Read-only source review. No builds, tests, native app launches, or live notification checks were run. Checked the two earlier review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md`; the previously reported remote notification identity defect is excluded. No additional concrete defect found in `app_menu.rs`.

## APP-MENU-1 — P2 — Deletion misses in-flight system notifications

- **File:line:** `app/SiloUI/src-tauri/src/notifications.rs:166–173`, with delivery at lines 129–131 and 194–195.
- **Trigger:** A sandbox notice is queued or delivering when the sandbox is deleted. `clear_sandbox` takes only keys already recorded in `DELIVERED`. If delivery has not returned yet, the key is absent, clearing returns immediately, and delivery subsequently records and leaves the notification visible.
- **Evidence:** Delivery runs in an independent `spawn_blocking` task, and the key is recorded only after `deliver_notification` returns. Clearing neither waits for delivery nor marks the sandbox as deleted. Local deletion calls this path after success (`runtime.rs:4109–4111`); remote deletion does the same (`remote.rs:1438–1440`). The macOS adapter waits for asynchronous authorization and scheduling callbacks (`system_integrations/macos.rs:85–101,272–304`), so the delivery task can remain pending after the operation that produced it has returned.
- **Consequence:** A notification survives deletion or appears afterward and routes to a sandbox that no longer exists. It remains recorded until another clear call, which successful deletion does not schedule.
- **Suggested fix:** Order delivery and withdrawal per sandbox, and invalidate pending deliveries when deletion is requested. Ensure a clear waits for or withdraws a delivery already submitted to the OS before acknowledging completion.
- **Test that would catch it:** Use a fake notification adapter with a barrier before delivery returns. Queue a sandbox notice, wait until delivery enters the adapter, clear the sandbox while its index is empty, then release delivery. Assert that no OS notification or delivered-index entry remains. Repeat with delivery blocked before submission.

## APP-MENU-2 — P2 — Concurrent deliveries can restore an older notice

- **File:line:** `app/SiloUI/src-tauri/src/notifications.rs:129–131`, with replacement identity at lines 55–56 and lifecycle keys at lines 256–259.
- **Trigger:** Two notices with the same key are issued in order, but the first blocking task reaches OS submission after the second. Every call creates an independent task; there is no sequence number, stale-delivery check, or per-key serialization.
- **Evidence:** Start, stop, and restart results deliberately share `vm:<id>:lifecycle`. `runtime.rs:3240–3253` queues a notification and returns the operation result without awaiting delivery, allowing another operation to finish while that notice is pending. The macOS adapter queries authorization before submission and uses `notice.key` as the replacement identifier (`system_integrations/macos.rs:273,289–300`). Reversed authorization completion therefore submits the older content last. On Linux, overlapping calls also read the same previous server ID before either writes the returned ID (`system_integrations/linux.rs:329–334,354–368`); two first deliveries can both submit `replaces_id = 0` and create separate notices.
- **Consequence:** An older failure or completion replaces the latest result, contradicting the documented replacement policy. Linux can also show duplicate notifications for one key and retain only one server ID for later withdrawal.
- **Suggested fix:** Preserve issuance order for each notification key through OS submission and adapter bookkeeping, or discard stale queued notices using a generation check before serialized submission. Keep different keys independent.
- **Test that would catch it:** Inject an adapter that pauses the first notice before submission. Issue older and newer content for the same lifecycle key, allow the newer task to advance, then release the first. Assert that the final visible content is the newer notice. For Linux replacement bookkeeping, assert that two concurrent first deliveries create only one active notification and that clearing closes it.
