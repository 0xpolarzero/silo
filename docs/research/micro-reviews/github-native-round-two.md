# GitHub native second fix loop

Scope: `app/SiloUI/src-tauri/src/github.rs` and adjacent GitHub modules.

## R-19: Failed personal-token replacement changes the active identity

The previously reported R-19 remained open in `save_github_personal_token`: it used the same keep-on-failure write operation required for rotated OAuth credentials. A validated replacement B was published in the cache even when secure storage rejected the write, while the caller returned before publishing B's account or reconciling guests.

Explicit personal-token replacement now publishes its cache value only after storage succeeds. Failed replacement leaves the old cached/stored identity intact and does not queue the new token for background activation. Successful retry publishes the replacement. OAuth rotation and token-ledger writes retain their existing keep-on-failure contract; token removal retains its separate fail-closed behavior.

Regression: `failed_personal_token_replacement_preserves_cached_and_stored_identity` failed at the old-account cache assertion before the fix, then passed. Five existing cache tests also passed, covering retained OAuth rotations, failed writes and flush, explicit denial retry, concurrent reads, and nonblocking observation. Verification used Rust 1.94.0 with the exact production cache implementation extracted into a synthetic source harness under `/tmp/silo-codex-target/verification/github-native-round2/`; no real credential store or application was used. Rust formatting and whitespace checks passed. Full native GitHub tests were queued on the shared target lock.

The integration branch received the same R-19 production fix concurrently. The merge retains its mocked credential-store command seam and both regression tests; the additional cache test rejects a failed replacement silently reappearing on a later flush.

## OAuth reconnect preserves the old account when storage fails

A reconnect previously called the rotation-oriented `store` after detaching guests and clearing active grants. Its failed write replaced the in-memory credential, but returned before `record_connection`, leaving the old account and catalog alongside the new credential. This is a new code exchange, not a consumed refresh token.

Explicit reconnect now uses transactional `SessionSecret::replace` before any workspace detachment or grant-cache mutation. Failed writes preserve the old credential and observation and do not queue the rejected connection for a later flush; the existing `Unstored` guard discards the unused exchange. Successful writes proceed with the existing replacement flow. Rotation continues to use `store` and retains newly rotated credentials after write failures.

The production cache and reconnect seam regression failed at the old-credential assertion before the fix, then passed with six existing cache tests. Synthetic fixtures only; no real OAuth exchange, Keychain, app or VM was used.

## Oversized writes cannot replace readable GitHub state

The reader rejects documents larger than 16 MiB, while the writer previously replaced the saved file without checking its encoded size. A 99,900-entry catalog with supported owner/repository name lengths exceeded that limit and was accepted by the writer, making subsequent reads fail.

`save_at` now shares the reader's size limit and checks serialized bytes before creating or replacing files. The temporary-directory regression failed before the fix because the oversized save succeeded; after the fix it verifies byte-for-byte preservation, reload of the old account, and a successful smaller retry. The harness includes the production `Document`, `load_at`, and `save_at`, with only rate-floor collection stubbed. No application data was used.

## Bound oversized configuration reads

The old `fs::read` allocated and read the entire file before checking the 16 MiB limit. The production read seam now uses `Read::take` at the limit plus one sentinel byte, rejecting oversized inputs without consuming their remaining content. The counting-reader regression consumed all 32 MiB before the fix and exactly 16 MiB plus one byte after it; valid document parsing and malformed JSON rejection remain covered. Focused Rust tests, Clippy, formatting, and whitespace checks passed.

## Repository Refresh preserves stopped writes

After the integration fixes to personal-token and workspace retries, Repository Refresh remained a caller of the global HTTP reset. It reopened stopped OAuth refreshes, token mints, and unrelated credentials. The transport now records the existing safe-request flag on failures and resets only safe, account-level failures for the selected bearer credential. Workspace-owned requests, unsafe writes, other credentials, and server floors remain intact. Reset occurs inside the serialized Refresh operation.

The new transport regression failed under the old global reset because the ambiguous write became admissible. The real transport module is compiled directly in the synthetic test harness, with only the test-isolation mutex substituted; no external GitHub requests are used.

The integration branch added the safe-request metadata and a safe-only Refresh reset concurrently. The resolved implementation keeps both regressions and additionally scopes Refresh to the active account and excludes workspace-owned reads, replacing the broader helper.

## Verification and remaining boundary

- Fixed and folded this round: personal-token replacement (`6c98045c`, reconciled with the concurrent integration fix in `14af1e3f`), OAuth reconnect (`21301b89`), readable writes (`9f2a8c4d`), bounded reads (`9df50d3a`), and scoped repository Refresh (`028f603a`, resolved in `89fa3aad`). The duplicate personal-token changeset was removed; the integrated `fix-personal-token-replacement.md` remains.
- Full native `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked github::`, using the shared target and synthetic GitHub configuration: **84 passed**, including both personal-token regressions, failed reconnect, oversized save preservation, and bounded reads. Output: `/tmp/silo-github-native-round2-native.log`.
- After the final Refresh merge, direct compilation of the real `github_http.rs` and `github_tokens.rs` modules: **38 passed**. Focused Clippy passed with the existing 10-argument warning in `Gates::fail`. Cache/reconnect harness: **7 passed**; persistence harness: **2 passed**. All red/green evidence remains under `/tmp/silo-codex-target/verification/github-native-round2/`.
- Rust formatting and diff whitespace checks passed. No frontend source changed. No application bundle, live VM, real OAuth flow, or real credential store was inspected or exercised. Tests use synthetic secrets, mock credential stores, loopback HTTP fixtures, and temporary files.
- GITHUB-NATIVE-4 remains skipped: moving narrowing outside the global policy lock requires a coordinated cache-publication and revision-ordering refactor. The micro fixes do not establish live GitHub or VM behavior.

The final `cargo ... test --locked github` rerun remained at the shared artifact lock and was stopped with SIGTERM after verifying its Cargo executable and this worktree's cwd. Its output remains at `/tmp/silo-github-native-round2-final-native.log`; no completed native result is claimed for that rerun. Temporary links to existing bundled runtime inputs were removed after native jobs ended.
