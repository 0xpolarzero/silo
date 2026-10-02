# Timeout follow-up review

## Desktop HTTP response deadline

Fixed: `desktop_proxy.rs` retried socket read timeouts indefinitely while a guest held an HTTP connection open without replying. The existing upload deadline only closed the request's write side. A guest that also ignored that EOF kept the response worker and one of the proxy's 32 connection slots alive until the viewer closed.

HTTP upload and response workers now share a two-minute deadline. Closing the response ends the upload worker and releases both connections. WebSocket sessions retain their existing viewer-lifetime behavior.

The synthetic Unix-socket regression failed before the fix with `stalled HTTP request exceeded its deadline`. Regression tests cover a silent guest and a missing POST body, assert handler completion and connection closure, and use a short injected deadline. After integrating the concurrent idle-response fix, all eleven proxy tests pass, including a continuing response that cannot reset the absolute deadline, successful HTTP requests, and bidirectional WebSocket traffic. The module was compiled directly with Rust 1.94.0 against the shared target's cached dependencies while the full Cargo test waited on its shared build lock. No app or VM was launched.

## macOS browser launcher deadline

Fixed: `applications/macos.rs::open_browser` waited indefinitely for `/usr/bin/open` through `Command::status`. A stalled launch helper prevented the browser action from settling. Browser launches now reuse the terminal launcher's existing bounded subprocess runner, with a ten-second deadline and an explicit timeout error. The runner kills and reaps only the helper it spawned.

`browser_launcher_reports_timeout_failure_and_success` failed before the change because a synthetic sleeper succeeded after its injected deadline. It passes after the fix and also checks nonzero and successful helper exits. An isolated harness compiles the actual browser launcher and bounded runner functions with Rust 1.94.0; focused Clippy, formatting, and whitespace checks pass. No browser or app was launched. This verifies subprocess behavior, not live Launch Services health.

## SSH public-key extraction deadline

Fixed: `editor.rs::public_key` used unbounded `ssh-keygen -y` output collection while connection preparation could hold the SSH-files mutex. The existing bounded editor subprocess runner now supports captured stdout; key extraction uses a temporary file and a five-second deadline. A timeout rejects any partial key, kills and reaps the owned helper, and returns the existing preparation error.

The regression prints a valid-looking key before stalling and failed before the fix because the unbounded helper eventually succeeded. Both new helper tests pass after the fix. The isolated source harness also passes the existing disposable-key generation/validation test and all thirteen included launcher-policy tests (sixteen total). Formatting and whitespace checks pass. Focused Clippy reports one pre-existing `nonminimal_bool` warning in the unchanged `applications/launch.rs`; the changed code has no warnings. Fixtures use temporary files and synthetic subprocesses, with no app, VM, or real SSH key access.

## Remote bridge IPC write timeout

Fixed: `remote.rs::run_bridge` configured a request-specific read timeout but left its Unix-socket request write unbounded. A large request to an owner that stopped reading blocked before controller-disconnect monitoring began. Request writes now use a thirty-second socket write timeout. Successful guest SSH handshakes clear that timeout before starting the existing session stream.

`bridge_request_write_times_out_when_owner_stops_reading` constrains the synthetic socket's send buffer, sends a one-MiB request to a non-reading peer, and requires the writer to settle with an error. It failed without the timeout and passes with a short injected timeout. The corrected fixture drops its peer before assertions so failure cleanup cannot wait on an unbounded writer. The source-extracted regression and focused Clippy pass; formatting and whitespace checks pass. No running app, remote host, or VM was accessed.

## Remote IPC frame read deadline

Fixed: socket frame reads used a fresh timeout for each read. A peer sending partial bytes within that interval could retain an incomplete request or reply indefinitely. `read_socket_frame` now gives the existing frame parser a reader that sets each socket read timeout to the remaining whole-frame budget. Owner requests retain their fifteen-second budget; bridge replies retain their existing operation-specific budget. Incomplete requests fail before authorization or dispatch, and successful SSH handshakes still clear the timeout for streaming.

`slow_socket_frames_cannot_reset_read_deadline` failed against the per-read timeout because the complete slow frame was accepted. It passes with the whole-frame deadline. `socket_frame_completed_before_deadline_still_round_trips` preserves the successful case. The isolated source harness, focused Clippy, formatting, and whitespace checks pass. Tests use synthetic Unix socket pairs and never contact the app or a remote host.
