# Release scripts fix loop

Scope: `app/SiloUI/scripts/`, release and runtime preparation tooling. Fixes were developed in the isolated `codex/fix-release-scripts` worktree and folded into `codex/integration`. Tests use synthetic package inputs and temporary directories. No app, real VM, credentials, runtime build, or release publication was used.

- **RELEASE-SCRIPTS-1, P2:** Fixed in `a3bd0fc9`, integrated with streamed archive inputs in `e44f18f7`. Runtime compilation extracts source and patches into a unique temporary directory and removes only that directory in a `finally` block. A two-process regression holds the first caller at Cargo fetch until the second finishes; it reproduced deleted source before the fix and passes afterward. A failed-compiler fixture also verifies source cleanup. Cargo retains its existing shared target-directory locking.
- **RELEASE-SCRIPTS-2, P2:** Fixed in `1dd80608`. Signing uses Tauri's password environment input and reports a fixed exit-code diagnostic. File-key and inline-key tests reject passwords in argv; a failed-signer regression reproduced the password-bearing exception and passes afterward. The installed CLI's `signer sign --help` confirms the supported environment input; the release guide records the primary documentation link.

## RELEASE-SCRIPTS-3 — P2: Failed verification leaks complete temporary executables

- **File:line at discovery:** `app/SiloUI/scripts/microsandbox-runtime.mjs:258–291`.
- **Trigger:** Runtime staging writes a compiled candidate, then its version/help verification fails or throws. Each preparation process uses a different PID suffix.
- **Evidence:** The temporary sidecar and `.staging-PID/verify-home` have no failure cleanup. A fixture executable reporting an unsupported version reproduced an extra `msb-aarch64-apple-darwin.tmp-PID` after rejection, while the prior executable and manifest remained present.
- **Consequence:** Repeated failed preparations accumulate full executable copies and staging directories until manually removed, consuming build disk space.
- **Fix:** Implemented in `8d9a6997`, integrated with deferred executable publication in `05fef809`. Clean the owned temporary executable and staging directory in `finally`, including failures during download, verification, and resource staging. Keep validated input caches and published resources.
- **Regression:** Stage an invalid capability fixture alongside a prior executable/manifest. Assert rejection preserves both prior files and leaves no temporary executable or staging directory. This test failed on the leftover executable before the fix.

## RELEASE-SCRIPTS-4 — P2: Failed guest export destroys the prior local artifact

- **File:line at discovery:** `app/SiloUI/scripts/build-guest-image.mjs:100–112` before staging was added.
- **Trigger:** Build an image for an architecture with an existing local `image.tar.gz` and manifest; `docker image save` emits bytes then exits nonzero.
- **Evidence:** The gzip pipeline writes directly to the published archive. A synthetic Docker collaborator emitted bytes and exited 19; the failing regression read gzip bytes where the prior archive sentinel had been, while its old manifest was retained. Failing output is under ignored `src-tauri/target/verification/release-scripts/guest-export-before.log`.
- **Consequence:** A failed rebuild destroys the previously usable offline guest artifact and leaves its manifest describing different bytes. Normal guest staging rejects that pair.
- **Fix:** Implemented in `45a80eb1`; integrated with a simultaneous archive-publication fix and its CLI-level regressions. Export, hash, and generate metadata in an operation-owned temporary directory. Publish the archive and manifest only after export and compression succeed; clean temporary files on success or failure. This preserves old inputs on export failure; it does not claim a crash-atomic two-file transaction at final publication.
- **Regressions:** Failed export preserves both previous files and leaves no staging directory. Successful export replaces them with matching compressed content, hashes, byte counts, architecture, and package inventory. Both use a real child process and gzip pipeline with synthetic Docker responses; Docker and real images are never invoked.

Verification so far: all 11 macOS release tests, all 13 existing runtime staging tests, the two-process concurrency/failed-compiler regressions, typecheck, touched JavaScript lint, and Rust formatting passed. The release suite passed 86 tests with 12 opt-in cases skipped before stream-input integration; afterward, 14 stream/guest tests and seven runtime-transfer tests also passed. These fixtures establish script behavior, not packaged app or live VM readiness.

The runtime staging follow-up checks passed after integration. One existing Vitest cache test exceeded its default five-second limit on the shared host; the unchanged test passed with `--testTimeout=20000` (13 tests total).

Guest export checks: 10 ordinary tests passed, 11 Docker opt-in tests skipped; 18 publication/workflow Python tests passed. Touched JavaScript lint, typecheck, Rust formatting, and whitespace checks passed. The changes are internal tooling and need no application changeset.

Merge verification retains streamed download inputs, deferred executable publication, and the CLI-level guest export tests. Guest cleanup waits for both the export process and gzip pipeline. The concurrency fixture uses generous bounded deadlines for the shared host.
