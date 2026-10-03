# Remote core fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/remote.rs`.

## REMOTE-CORE-3: Valid replies exceed the transport spool limit

- **Severity:** P2.
- **File:line:** `app/SiloUI/src-tauri/src/remote.rs:978` at parent commit `e87d3c62`; `write_reply` and `read_reply` define the framing and shell-output allowance.
- **Trigger:** A valid JSON reply near the 4 MiB frame limit follows a permitted SSH shell banner, while the SSH child remains alive long enough for the spool-size check.
- **Consequence:** The transport kills the child and reports an unknown-outcome timeout despite receiving a valid bounded reply. The former limit counted only the frame body and four-byte header; it omitted the reply preamble and the 64 KiB permitted shell output.
- **Suggested fix:** Include the preamble and permitted shell output in the transport bound; preserve the existing frame and shell-output parser limits.
- **Test:** `exchange_accepts_a_near_limit_reply_after_shell_output` sends a JSON frame below the limit after a 1 KiB banner and delays child exit by 200 ms. The source-extracted Rust harness rejected it before the fix. After the fix it must return the complete expected value. This uses temporary files and a bounded fixture child, not live SSH or VMs.

## REMOTE-CORE-4: Enabling management overwrites an unrelated AppImage link

- **Severity:** P3.
- **File:line:** `app/SiloUI/src-tauri/src/remote.rs:292` at parent commit `9fe3a1fe` (`link_bridge`).
- **Trigger:** The account's bridge path already links to an existing unrelated executable such as `other-tool.AppImage`, then management is enabled.
- **Consequence:** The extension-only fallback declares that link Silo-owned and replaces it, losing the user's previous link configuration. The existing test covers an unrelated executable without this extension and misses this case.
- **Suggested fix:** Limit the AppImage fallback to the channel-derived Silo package basename and its versioned package names. Preserve the existing same-target and executable-name rules and existing stale-link handling.
- **Test:** `unrelated_appimage_bridge_link_is_preserved` creates both executable targets in temporary directories and requires the original link to remain intact after rejection. It failed against the original source. Existing bridge-link tests still cover upgrades from an older versioned Silo AppImage. Filename matching remains a compatibility heuristic, not executable authentication.

## Verification

Six regressions were added across the four fixes. Before each fix, its behavior test failed in a disposable Rust harness assembled from the current source functions and tests. The final harness uses the real channel module and passes 19 tests, including existing key, reply, channel, and bridge-link coverage. It is stored locally under `/tmp/silo-codex-target/remote-core-verification/`; it replaces only the test-isolation guard and mutex-recovery helper with equivalent local implementations and does not compile the complete Tauri application.

`cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`, `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`, and `git diff --check` passed before each commit. Focused native Cargo tests were also requested with the shared target and explicit synthetic GitHub configuration; they were still queued on the shared artifact lock when these results were recorded. These harness results do not replace native integration verification. All executions used temporary fixtures; no app or VM was launched, and no bundle was inspected. The key-migration mutex serializes the running owner's writers; unrelated external editors do not participate in that mutex.
