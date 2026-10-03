# ChatGPT app fix loop

Scope: `app/SiloUI/src-tauri/src/chatgpt_app.rs` and `chatgpt_app/`. The original review remains uncommitted in the shared micro-review worktree. Fixes use the isolated `codex/fix-chatgpt-app` branch and are folded individually into `codex/integration`.

| Finding | Fix | Regression evidence |
| --- | --- | --- |
| CHATGPT-APP-1 | `92d3c186`: open publication records nonblocking before checking descriptor type | A FIFO without a writer timed out before the fix; afterward status returns Idle and preparation replaces the invalid record. |
| CHATGPT-APP-2 | `4a57e417`: clean abandoned deletion directories in `published/` under the existing storage lock | Both preparation and collection retained interrupted deletion fixtures before the fix; both now remove them. Pinned and in-use versions survive, and external symlink targets remain intact. |
| CHATGPT-APP-3 | `a326a233`: serialize retry requests and worker release through the same slot lock | A Retry between failure publication and worker exit returned the terminal failure before the fix. The two-thread regression now performs exactly two attempts. Separate checks preserve terminal stopping without Retry and a single ready hook after backoff consumes Retry. |

Each fix includes a patch changeset. No version bump or release action was performed.

## Verification

The shared Cargo cache was busy. Disposable harnesses under `/tmp/silo-codex-target/verification/chatgpt-app/` compiled the actual filesystem implementation and existing synthetic-package tests, and included the worker module directly. They established failing behavior before implementation, then passed all 21 filesystem hardening tests, 11 HTTP download tests, and 11 worker tests. These component harnesses do not prove Tauri integration or packaging.

The FIFO regression also passed through `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked a_fifo_record_is_refused_without_waiting_for_a_writer` with the documented synthetic GitHub configuration and `CARGO_TARGET_DIR=/tmp/silo-codex-target`.

The broader `chatgpt_app::` native test run remained queued for the shared Cargo lock and was cancelled at the end of the approximately 20-minute fix window. It did not execute, so full native integration remains unverified. Formatting, Node 24 typecheck, and frontend lint passed. Worker Clippy passed with `-D clippy::all`. Filesystem Clippy reported three existing warnings on unchanged lines: redundant `write(true)` with append and platform-dependent integer casts; no new warning was introduced.

All data was temporary fixture data. No app bundle, production data, Keychain, live VM, or live download was inspected or launched. Exact regression failures and subsequent outputs remain in the ignored shared target directory.

## Follow-up review

Rechecked download resume, extraction bounds, publication digests, garbage collection, and worker ownership. The tar-producer leak on consumer-spawn failure was already fixed by another integration commit, `300b5d50`; its fix was retained. No additional unresolved defect was established in this pass.
