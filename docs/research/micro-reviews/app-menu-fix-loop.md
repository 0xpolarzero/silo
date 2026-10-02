# App menu and notifications micro-review

Scope: `app/SiloUI/src-tauri/src/app_menu.rs` and `app/SiloUI/src-tauri/src/notifications.rs`.

Original read-only audit, before the fix loop: no builds, tests, native app launches, or live notification checks were run. Original finding line numbers refer to the audited version. Checked the two earlier review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md`; the previously reported remote notification identity defect is excluded. No additional concrete defect found in `app_menu.rs`.

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

## APP-MENU-3 — P3 — Frontend mirrors bypass system notification body bounds

- **File:line:** `app/SiloUI/src-tauri/src/notifications.rs:308–309` (`deliver_notice`), and the native preparation path at line 188.
- **Trigger:** A frontend operation supplies a multiline or long description. `operation-toast.ts:127–129` copies it into a deserialized `Notice` without calling the backend `failure()` helper.
- **Consequence:** The OS receives multiline bodies longer than the router's documented 200-character limit, instead of keeping full detail in the app.
- **Suggested fix:** Apply the existing `bounded_body` formatter to every notice prepared for native delivery, preserving the separate in-app event payload.
- **Test that catches it:** Submit a frontend-shaped notice containing newlines, tabs, and 500 characters. Assert that the adapter receives one line with exactly 200 characters and a trailing ellipsis. This test failed before the formatter was applied at preparation.

## Fix loop

- APP-MENU-1: fixed and folded in `527ae7a4`; regressions cover queued cancellation, deletion during OS delivery, and a delayed withdrawal following a newer submission.
- APP-MENU-2: fixed and folded in `4d3e17cb`; regressions force reverse task execution and exercise delivery of a different key while another key's adapter is running.
- APP-MENU-3: fixed and folded in `17600b26` by bounding every prepared system notice; its regression reproduces the frontend mirror path.
- The shared worktree report remains the original read-only audit. Implementation and this expanded report live in the isolated `codex/fix-app-menu` worktree.
- Before each fix, the new behavior regression failed in a standalone Rust harness extracting the production synchronization code and the exact test bodies. All six new regressions pass after the fixes. The harness uses minimal notice structs and fake OS callbacks; it does not prove Tauri integration or live notification behavior.
- Rust formatting, frontend typecheck, and frontend lint pass. The native Cargo test command uses `/tmp/silo-codex-target` and explicit synthetic GitHub configuration; at this point it is still waiting on the shared artifact-directory lock. No app was launched and no real user data was accessed.

### Scoped native verification

Compiled the actual `notifications.rs`, `app_menu.rs`, and supporting `channel.rs` modules with `rustc +1.94.0 --test`, using matching cached Tauri, Serde, and serde_json artifacts from `/tmp/silo-codex-target/debug/deps`. A temporary root module supplied fake settings, notification, launch, and status-panel boundaries. `/tmp/silo-app-menu-module --nocapture` passed all 31 tests, including all 18 notification tests and the six new regressions. This also compiled the real Tauri command macros and checked the real notice wire serialization. The first standalone-module setup lacked Cargo package metadata and chose incompatible Serde artifact variants; correcting the harness metadata and matching Tauri's dependency fingerprints resolved those setup errors. Neither setup error was a product defect.

The temporary harness, build logs, failing regression outputs, and test logs are under `/tmp/silo-app-menu-*`; they are not committed or distributed. No packaged bundle was built or inspected, no app was launched, and no live OS notifications, VM state, or user settings were accessed. Full application compilation and live OS delivery remain unverified. No additional concrete defect was found in the remaining scoped review.

At the end of the approximately 20-minute loop, the full Cargo test still had not acquired the shared artifact-directory lock. Its waiting process was terminated after verifying its Cargo executable and this worktree's cwd. The scoped native harness passed; the full application Cargo test did not run.
