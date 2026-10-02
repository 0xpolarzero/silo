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
