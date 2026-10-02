# GitHub native second fix loop

Scope: `app/SiloUI/src-tauri/src/github.rs` and adjacent GitHub modules.

## R-19: Failed personal-token replacement changes the active identity

The previously reported R-19 remained open in `save_github_personal_token`: it used the same keep-on-failure write operation required for rotated OAuth credentials. A validated replacement B was published in the cache even when secure storage rejected the write, while the caller returned before publishing B's account or reconciling guests.

Explicit personal-token replacement now publishes its cache value only after storage succeeds. Failed replacement leaves the old cached/stored identity intact and does not queue the new token for background activation. Successful retry publishes the replacement. OAuth rotation and token-ledger writes retain their existing keep-on-failure contract; token removal retains its separate fail-closed behavior.

Regression: `failed_personal_token_replacement_preserves_cached_and_stored_identity` failed at the old-account cache assertion before the fix, then passed. Five existing cache tests also passed, covering retained OAuth rotations, failed writes and flush, explicit denial retry, concurrent reads, and nonblocking observation. Verification used Rust 1.94.0 with the exact production cache implementation extracted into a synthetic source harness under `/tmp/silo-codex-target/verification/github-native-round2/`; no real credential store or application was used. Rust formatting and whitespace checks passed. Full native GitHub tests were queued on the shared target lock.

The integration branch received the same R-19 production fix concurrently. The merge retains its mocked credential-store command seam and both regression tests; the additional cache test rejects a failed replacement silently reappearing on a later flush.
