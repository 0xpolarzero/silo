# Release scripts fix loop

Scope: `app/SiloUI/scripts/`, release and runtime preparation tooling. Fixes were developed in the isolated `codex/fix-release-scripts` worktree and folded into `codex/integration`. Tests use synthetic package inputs and temporary directories. No app, real VM, credentials, runtime build, or release publication was used.

- **RELEASE-SCRIPTS-1, P2:** Fixed in `a3bd0fc9`, integrated with streamed archive inputs in `e44f18f7`. Runtime compilation extracts source and patches into a unique temporary directory and removes only that directory in a `finally` block. A two-process regression holds the first caller at Cargo fetch until the second finishes; it reproduced deleted source before the fix and passes afterward. A failed-compiler fixture also verifies source cleanup. Cargo retains its existing shared target-directory locking.
- **RELEASE-SCRIPTS-2, P2:** Fixed in `1dd80608`. Signing uses Tauri's password environment input and reports a fixed exit-code diagnostic. File-key and inline-key tests reject passwords in argv; a failed-signer regression reproduced the password-bearing exception and passes afterward. The installed CLI's `signer sign --help` confirms the supported environment input; the release guide records the primary documentation link.

## RELEASE-SCRIPTS-3 — P2: Failed verification leaks complete temporary executables

- **File:line at discovery:** `app/SiloUI/scripts/microsandbox-runtime.mjs:258–291`.
- **Trigger:** Runtime staging writes a compiled candidate, then its version/help verification fails or throws. Each preparation process uses a different PID suffix.
- **Evidence:** The temporary sidecar and `.staging-PID/verify-home` have no failure cleanup. A fixture executable reporting an unsupported version reproduced an extra `msb-aarch64-apple-darwin.tmp-PID` after rejection, while the prior executable and manifest remained present.
- **Consequence:** Repeated failed preparations accumulate full executable copies and staging directories until manually removed, consuming build disk space.
- **Fix:** Clean the owned temporary executable and staging directory in `finally`, including failures during download, verification, and resource staging. Keep validated input caches and published resources.
- **Regression:** Stage an invalid capability fixture alongside a prior executable/manifest. Assert rejection preserves both prior files and leaves no temporary executable or staging directory. This test failed on the leftover executable before the fix.

Verification so far: all 11 macOS release tests, all 13 existing runtime staging tests, the two-process concurrency/failed-compiler regressions, typecheck, touched JavaScript lint, and Rust formatting passed. The release suite passed 86 tests with 12 opt-in cases skipped before stream-input integration; afterward, 14 stream/guest tests and seven runtime-transfer tests also passed. These fixtures establish script behavior, not packaged app or live VM readiness.
