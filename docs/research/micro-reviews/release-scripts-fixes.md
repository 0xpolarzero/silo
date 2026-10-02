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


## Compiled-cache execution recovery

A checksum-valid cached MicroSandbox executable with missing execute permissions
aborted runtime preparation at its version probe with `EACCES`. An unsuccessful
capability command likewise aborted instead of rebuilding the disposable cache.
The real child-process regression reproduced the permission failure before the
fix. Cache probe failures now fall through to the existing pinned-source build;
fresh-build failures still propagate. Regressions cover lost permissions and a
cached probe exiting 17, then require a runnable replacement and matching digest.
Tests use temporary sources and synthetic compiler executables, with no runtime
preparation, app launch, VM or network operation.


## Guest lock architecture validation

Guest staging accepted an x86_64 manifest from an `arm64` lock entry and an
aarch64 manifest from `amd64`, because it checked schema, size and checksum but
not the manifest architecture. Three rejecting target regressions failed before
the correction. Staging now rejects this mismatch before fetching or replacing
any artifact; approved ARM64 and x86_64 downloads and warm-cache reuse still
pass. These synthetic archives establish the preparation policy, not the
architecture of bytes supplied by an incorrectly authored trusted lock.

## RELEASE-SCRIPTS-5 — P2: Missing Linux inputs destroy the previous package tools

- **Trigger and evidence:** `stageLinuxPackageTools` removes the published directory before copying its inputs. A temporary-directory fixture supplies the first new executable and omits the second; it reproduced a directory containing only the replacement `msb`, with all six prior tools lost. Failing output is preserved in ignored `target/verification/release-scripts/linux-package-before.log`.
- **Fix:** Converged with integration commit `a173affb`. Copy and set modes in an operation-owned staging directory, then publish only after every input succeeds. Always clean that staging directory. This preserves the previous tools on input or copy failures; final directory replacement is not crash-atomic.
- **Verification:** All four Linux package-tool tests passed, including exact bytes/modes and the packaging overlay contract. Typecheck, touched-file oxlint, Rust formatting, CI-coverage tests (two), and whitespace checks passed. Internal tooling only; no changeset required.

## RELEASE-SCRIPTS-6 — P2: Local macOS overlays redirect the build while signing an old app

- **Trigger and evidence:** An optimized local build receives a `--config` overlay changing `productName` or `identifier`. Tauri builds the overlaid product, but `build_desktop.py` signs and verifies the production path. The failing fixture creates a previous production bundle and a new redirected bundle; the signing callback receives the previous build. Evidence is preserved in ignored `target/verification/release-scripts/desktop-identity-before.log`.
- **Fix:** The final wrapper configuration includes the production identifier and product name from the native channel API. This keeps the generated bundle and finalization path aligned with the required production channel. Debug routing retains the existing development configuration.
- **Primary evidence:** The installed Tauri CLI's `build --help` and [Tauri CLI documentation](https://v2.tauri.app/reference/cli/) confirm that later configurations override earlier conflicting keys. The test models that documented merge at the process boundary, writes the selected fixture bundle, and asserts signing receives this build's marker.
- **Verification:** Desktop routing, native channel-name, release-workflow and CI-coverage regressions passed; typecheck, Rust formatting and whitespace checks passed. No real build or signing command ran. This is an internal build-tool correction.
