# GitHub HTTP fix-loop follow-up

Scope: `app/SiloUI/src-tauri/src/github_http.rs`.

## GITHUB-HTTP-2 — P2: Explicit Retry discards a service outage's server deadline

- **File:line:** `app/SiloUI/src-tauri/src/github_http.rs:157` (before this fix).
- **Trigger:** A safe request receives HTTP 503 with `Retry-After: 600`, then the user retries explicitly or relaunches before that deadline.
- **Evidence:** `retry_after` parses the deadline, but `Gates::fail` retains it only in the request failure because `is_rate_limit` returns false for 503. Only rate-limit responses previously populated the persisted class floors. `reset_retries` clears request failures, and `retry_floors` omits the 503 deadline. A local wire-response regression failed at the assertion that preflight still refuses the request after `reset_retries`.
- **Consequence:** Explicit Retry and relaunch bypass the service's waiting period. [RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) defines Retry-After as the expected unavailability period when sent with HTTP 503. This is a synthetic response reproduction, not a live GitHub incident.
- **Suggested fix:** Retain future server deadlines in the existing class-floor map even when the response is not a rate limit. Keep the distinction between permission to replay a request and its earliest allowed time.
- **Regression:** A wire test returns HTTP 503 with a ten-minute wait, clears per-request retries, checks that preflight remains blocked, and restores exported floors into fresh gate state. It verifies blocking before the deadline, admission at the deadline, and admission for another credential class.

The original GITHUB-HTTP-1 audit remains in the shared review worktree. Its interrupted-body regression failed before the fix and passed afterward. Verification uses local HTTP fixtures and the actual source module; no app, VM, or live credential was used.

## GITHUB-HTTP-3 — P2: Separate tokens bypass a known shared-account primary limit

- **File:line:** `app/SiloUI/src-tauri/src/github_http.rs:74`.
- **Trigger:** OAuth and a personal access token belong to the same GitHub account. One receives a primary-limit response with `x-ratelimit-remaining: 0` and a future reset time; the other makes an API request before that reset.
- **Evidence:** `rate_class` hashes each bearer token independently. `Gates::check` consults only the supplied token's class, so the first token's floor does not block the second. The existing `one_credentials_rate_limit_never_delays_another_credential` test explicitly confirms this independence. [GitHub's primary rate-limit contract](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-authenticated-users) combines a user's personal-token requests with requests made on that user's behalf by OAuth and GitHub Apps. The transport accepts no account identity. This is a source-and-protocol finding; no live account was exercised.
- **Consequence:** Silo can send another request against an account budget whose reset deadline it already knows. Token rotation also changes the class for the same account.
- **Suggested fix:** Associate authenticated-user primary floors with a verified stable account identity and rate-limit resource. Keep distinct accounts independent and retain separate treatment for App authentication and secondary limits. Do not replace the current classes with a global floor that blocks unrelated accounts.
- **Test that would catch it:** Give two synthetic tokens the same verified account ID, impose a primary floor through one, and assert that the other is blocked until reset. Give a third token another account ID and assert it remains admissible. Include token rotation for the first account.
- **Status:** Skipped. Correct identity and resource plumbing crosses `github.rs`, `github_personal_token.rs`, and `github_tokens.rs`, beyond the assigned file scope. A transport-only global gate would reintroduce cross-account interference.

## GITHUB-HTTP-4 — P2: Unrelated explicit retries reopen ambiguous writes

- **File:line:** `app/SiloUI/src-tauri/src/github_http.rs:201`.
- **Trigger:** A token-mint request has an unknown outcome and is stopped with `until: None`. The user then saves a personal token or retries another workspace's GitHub configuration.
- **Evidence:** `reset_retries` clears the entire request map. `save_github_personal_token` calls it before validating its token, and `retry_github_configuration` calls it even when a specific workspace is supplied. Neither supplies the failed mint's identity. A disposable probe using an unchanged copy of the transport source records a non-retryable mint, confirms that its key is blocked, performs the public reset, and fails the assertion that the unrelated mint stays blocked. In `github.rs`, `access_update_due` permits another attempt for a failed workspace when its refresh deadline arrives.
- **Consequence:** The worker can automatically repeat an ambiguous write that the user did not explicitly retry. Saving a personal token affects the OAuth/App transport's stopped requests as well as personal-token validation.
- **Suggested fix:** Make reset operations accept the intended credential/request scope, and carry workspace or operation ownership where required. Personal-token save should reset its validation failures only. Preserve unrelated ambiguous-write refusals and server floors.
- **Test that would catch it:** Stop distinct mint requests for workspaces A and B. Explicitly retry A and verify that only A becomes admissible. Save a personal token and verify that neither mint is reopened. Exercise the worker after the next refresh deadline and assert the outbound request count for B stays unchanged.
- **Status:** Personal-token save and workspace-specific Retry are fixed after the scope expanded to adjacent modules. Personal-token save resets only its bearer credential's failures. Workspace policy requests carry ownership through `github_tokens` into the HTTP gate, and identical mint bodies for different workspaces get distinct failure keys. Workspace Retry clears only that workspace's failures after its intent ticket and update guard are acquired. Regressions failed under global resets and now prove unrelated personal credentials, other workspaces, and account operations remain blocked while the selected intent can retry without bypassing server floors. All 34 transport/token-operation tests passed, as did formatting and focused Clippy. Repository Refresh now resets only the active bearer credential after acquiring it; its behavior regression also failed with the global reset and passes with the scoped reset. The disposable failing probe and output remain under `/tmp/silo-codex-target/verification/github-http/`; no failing test was committed.

## GITHUB-HTTP-5 — P2: An HTTP request timeout permanently blocks safe reads

- **File:line:** `app/SiloUI/src-tauri/src/github_http.rs:295` (before this fix).
- **Trigger:** GitHub or its HTTP frontend returns HTTP 408 to a safe token-validation or repository-list request.
- **Evidence:** `retryable_response` treated only rate limits and safe server errors as retryable. HTTP 408 therefore stored `until: None` and subsequent preflight checks refused the same request indefinitely. A local wire regression failed with `safe read stopped after HTTP 408`. [RFC 9110 section 15.5.9](https://www.rfc-editor.org/rfc/rfc9110.html#name-408-request-timeout) describes an incomplete request and permits another attempt. This finding uses a synthetic HTTP response, not a live GitHub outage.
- **Consequence:** A transient request timeout requires manual recovery despite the safe-read retry policy.
- **Fix:** Classify HTTP 408 as retryable for safe operations. Unsafe writes still stop, and permission/resource errors remain terminal.
- **Regression:** Local HTTP 408 responses exercise safe and unsafe requests, pre-deadline blocking, admission at the retry deadline, and permanent unsafe refusal. Additional assertions keep HTTP 401 and 404 terminal. The test failed before the fix; all 35 transport/token-operation tests passed afterward, as did formatting and focused Clippy.

## Fix-loop verification

- GITHUB-HTTP-1: fixed and folded as `f9f4363a`; the local interrupted-body regression failed before the fix.
- GITHUB-HTTP-2: fixed and folded as `64afd708`; the local service-wait regression failed before the fix.
- After both fixes, all 17 tests in the actual `github_http.rs` passed in a temporary Rust harness using cached dependencies. The harness supplies only a test-isolation mutex in place of the application's test-support module. Exact red/green output is retained under `/tmp/silo-codex-target/verification/github-http/`.
- Rust formatting and diff whitespace checks passed. Focused Clippy passed with the existing argument-count warning and harness-only dead-code warnings. Frontend typecheck/lint do not apply to this Rust-only change.
- The first native Cargo regression run reached the build script but failed because this worktree lacked the bundled `msb` sidecar. Prepared runtime resources were then linked into ignored directories in this worktree. The subsequent `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked github_http::tests::` run, with synthetic GitHub configuration and `CARGO_TARGET_DIR=/tmp/silo-codex-target`, stayed queued behind the shared artifact lock. Its verified Cargo process was stopped with SIGTERM at the review time limit. The full native check did not complete; its output is retained as `native-green.log` in the verification directory despite the unsuccessful run.

The extended loop passed 37 transport, token-operation, and catalog-retry tests in the cached-dependency harness, plus formatting and focused Clippy. The catalog check extracts the production retry helper and its regression unchanged into the harness; it does not compile the full Tauri caller. After waiting for the shared Cargo artifact lock, the full native test run failed in `settings.rs:1604–1608`: tests reference `tauri::test` without enabling its dependency feature, followed by a closure type-inference error. No errors were reported in the changed transport or GitHub modules. Native execution did not complete; exact output is retained in `native-loop-two.log`.
