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
