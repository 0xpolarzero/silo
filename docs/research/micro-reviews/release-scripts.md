# Release scripts micro-review

Scope: `app/SiloUI/scripts/`, release and runtime preparation tooling. Read-only source review; no tests, builds, runtime preparation, signing, or publication executed. Checked the first, second, and third-pass review reports for duplicates. Only this report was written.

## RELEASE-SCRIPTS-1 — P2: Concurrent preparations delete another build's source

- **File:line:** `app/SiloUI/scripts/microsandbox-runtime.mjs:138–144`, also `:187`.
- **Trigger:** Start two runtime preparations in the same checkout with identical pinned inputs and no valid patched executable cache. Both derive the same `buildRoot` from the input hash at lines 116–125. Process A reaches Cargo fetch/build in the extracted source; process B reaches line 141.
- **Evidence:** `workRoot` is the fixed `buildRoot/work`, not an operation-owned directory. Each caller recursively removes it before extraction, and removes it again after publishing its cached executable. No lock covers cache inspection, extraction, patching, compilation, or cleanup. The PID suffix on executable publication does not protect this shared source tree. `CARGO_TARGET_DIR` supplied to the desktop build does not separate this cache, which is rooted in the checkout at line 205.
- **Consequence:** Process B deletes the source and working directory used by process A's active Cargo command. Concurrent development/build preparation fails despite valid inputs; the successful caller's final cleanup can also remove another caller's active source.
- **Suggested fix:** Give each preparation an operation-owned extraction directory and cleanup only that directory. Serialize shared compiled-cache construction/publication with a maintained interprocess lock, rechecking cache validity after acquiring it.
- **Test that would catch it:** Run two fixture preparation child processes against one cache key. Hold the first process after extraction while its build collaborator reads the source, then advance the second through extraction and cleanup. Assert the first source stays intact, both callers succeed, and the final executable matches its digest. No real compiler or download is required.

## RELEASE-SCRIPTS-2 — P2: Signing failure prints the updater-key password

- **File:line:** `app/SiloUI/scripts/package-macos-release.py:35–36`, `:49`, `:60–61`.
- **Trigger:** Set a nonempty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and have `npx tauri signer sign` return a nonzero exit status, for example because the password is wrong or the archive cannot be signed.
- **Evidence:** The script inserts the password directly into the subprocess argument list after `-p`, then calls `subprocess.run(..., check=True)`. Its entry point invokes `main()` without catching `CalledProcessError`. That exception includes the command argument list in its string, so the uncaught traceback includes the password. `stdout=DEVNULL` suppresses child stdout, not the parent traceback. The argument list also exposes the password to process-argument inspection while signing runs.
- **Consequence:** A failed local release-packaging attempt copies the updater-key password into terminal/build logs. CI secret masking is not implemented by this script and does not protect local executions.
- **Suggested fix:** Supply the password through Tauri's supported environment input instead of an argv value. Catch signing failures and emit a fixed diagnostic with the exit code without formatting secret-bearing commands.
- **Test that would catch it:** Use a synthetic password sentinel and a recording subprocess collaborator that raises `CalledProcessError` on the signer call. Assert the signer argv excludes the sentinel and the entry point's captured error output excludes it while returning failure.
