# Desktop viewer fix follow-up

Scope: `app/SiloUI/src-tauri/src/desktop_viewer.rs` and the frontend attachment lifecycle needed to repair its recovery behavior.

## DESKTOP-VIEWER-1: Retired viewer transport recovery

Fixed and folded in `801fc06d`. The existing visible-window health poll now rechecks attachment even when guest state remains unchanged. A healthy backend connection retains its proxy/tunnel; a disconnected entry uses the existing reconnect path. Explicit Retry retains its detach/attach ordering. The new frontend regression failed before the fix and passed afterward. Both viewer test files passed all 27 tests; typecheck, touched-file lint, Rust formatting, and diff whitespace checks passed. Tests used mocked IPC and guest state, without launching an app or a VM.

## DESKTOP-VIEWER-2: Watchdog exit bypasses forced descendant cleanup

- **Priority:** P2.
- **Location before fix:** `app/SiloUI/src-tauri/src/desktop_viewer.rs:26–33,75–93`.
- **Trigger:** A tunnel forward or its descendant ignores SIGTERM. Close the viewer, or close the watchdog stdin pipe to simulate a controller crash.
- **Evidence:** The original watchdog sends TERM to its entire process group, including itself, and exits. `Tunnel::drop` returns once `running()` reaps that leader, bypassing its SIGKILL fallback while other group members remain alive. A disposable process fixture confirmed the forward survived pipe EOF. The new regression against the extracted production `Tunnel` implementation failed with “the TERM-ignoring forward outlived its tunnel.” Its failure cleanup verified the recorded fixture's process group before sending KILL.
- **Consequence:** An unresponsive SSH forward or ProxyCommand can retain its process and descriptors after viewer closure or controller exit. The registry no longer owns that connection.
- **Fix:** The watchdog cleanup process ignores TERM while sending TERM to the group, waits 500 ms, then sends KILL. Its group membership reserves the group identity until escalation, even if the original leader exits. `Tunnel::drop` allows that cleanup to run instead of immediately killing the watchdog; its existing bounded KILL fallback remains for a stuck leader.
- **Regression:** Exercise both normal Drop and crash-style pipe closure with a TERM-ignoring direct forward and with a TERM-ignoring descendant. Assert that the recorded processes end. Retain existing tests for normal close, crash cleanup, and an independently exiting forward.

Native verification uses a disposable Rust harness extracting the production watchdog, `Tunnel`, and process tests verbatim, with the shared Cargo dependency artifacts. The only stub is the AppImage child-environment sanitizer, which does not change commands on this macOS fixture host. The four scoped process tests passed after the fix. The full Cargo regression waited for the shared artifact lock and was stopped after identifying its exact worktree and test command; this harness does not establish whole-application compilation or live VM behavior. Failing and passing evidence remains in the worktree's ignored `app/SiloUI/src-tauri/target/verification/desktop-viewer/` directory. No app was launched and no live VM data was used.

## DESKTOP-VIEWER-3: Abandoned WebSocket clients retain proxy handlers

- **Priority:** P2.
- **Location before fix:** `app/SiloUI/src-tauri/src/desktop_proxy.rs:323–339`.
- **Trigger:** An authenticated WebSocket client closes while the guest keeps its response direction open without sending data.
- **Evidence:** The client-to-guest relay returns on EOF but does not set the shared `ended` flag. The guest-to-client relay has no WebSocket deadline and keeps polling the silent guest. `serve` cannot return and the proxy cannot decrement its active connection count. The real-socket regression failed with “closed WebSocket client retained its handler” while keeping the guest open; its cleanup explicitly stopped and joined the worker.
- **Consequence:** Every abandoned WebSocket retains sockets, a thread, and a connection slot until the guest closes or the entire proxy is dropped. Repeated abandoned connections can exhaust the proxy's 48 slots.
- **Fix:** Notify the other WebSocket relay when the client direction ends. Preserve the existing HTTP upload behavior, which allows a client to half-close a request and still receive its response.
- **Regression:** `a_closed_websocket_client_releases_its_handler_without_guest_eof` waits for a successful protocol upgrade before closing the TCP client, leaves the guest response direction open, and requires handler completion and upstream EOF within one second. Existing bidirectional WebSocket and HTTP half-close tests cover the distinction.
- **Protocol evidence:** [RFC 6455 section 7.1.4](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.4) ties WebSocket closure to closing its underlying TCP connection; [section 7.2.1](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.2.1) requires failure when the transport is unexpectedly lost. This proxy propagates transport termination without interpreting WebSocket frames.

All 15 proxy module tests passed after the fix, compiled directly from the production module with Rust 1.94.0 and shared cached dependencies, without stubs. Scoped Clippy with warnings denied, frontend typecheck/lint, Rust formatting, and whitespace checks passed. Synthetic TCP/Unix sockets and credentials were used; no app or VM was launched. The direct module run does not establish whole-application compilation.

## DESKTOP-VIEWER-4: Obsolete attachment errors remain on stopped sandboxes

- **Priority:** P3.
- **Location before fix:** `app/SiloUI/src/desktop/linux-desktop-viewer.tsx`, native viewer error projection.
- **Trigger:** Native attachment fails, then a subsequent successful health read reports `vm-stopped`.
- **Evidence:** Connection errors have a separate lifetime from health-read errors. Successful health reads clear only the latter, and a stopped display cannot attach to clear the former. The mocked-IPC regression failed because the stopped sandbox retained the old attachment alert and Reconnect button alongside Start sandbox.
- **Consequence:** The viewer presents a transport recovery action when the current state instead requires starting the sandbox. The same stale alert can obscure display-recovery controls while the stream is stopped or failed.
- **Fix:** Show attachment errors only while the current guest state permits attachment. Keep health-read and action errors visible independently, and retain connection errors during healthy running-state reads until attachment succeeds.
- **Regression:** Start with a running guest whose attachment fails, poll a stopped sandbox, require Start sandbox and no obsolete attachment alert or Reconnect control, and verify no desktop action is invoked automatically. Existing tests retain connection errors while a running guest's attachment continues failing.

Both viewer test files passed all 29 tests. Frontend typecheck, lint, Rust formatting, and whitespace checks passed. Tests used mocked IPC and fake timers; no application or VM was launched.

## DESKTOP-VIEWER-5: Development viewer titles use the production name

- **Priority:** P3.
- **Location before fix:** `app/SiloUI/src-tauri/src/desktop_viewer.rs`, `open_desktop` window title.
- **Trigger:** Open a desktop viewer from Silo Dev while distinguishing its windows from production Silo.
- **Evidence:** The native title hard-coded `Silo`; the shared build-channel policy names development `Silo Dev`. The extracted title regression passed the production expectation and failed the development expectation with `dev · Office — Silo` instead of `dev · Office — Silo Dev`.
- **Consequence:** A development viewer's native title identifies the production product, removing the build distinction during window selection and inspection. This does not indicate shared VM or application state.
- **Fix:** Derive the title suffix from `Channel::product_name`, using the current channel at window creation.
- **Regression:** Assert exact production and development viewer titles while preserving the machine/computer name.

The title regression and all five channel tests passed in a disposable harness using the production channel module and extracted title function/tests verbatim. Frontend typecheck/lint, Rust formatting, and whitespace checks passed. This proves title construction and channel configuration consistency, without launching or inspecting a packaged application.
