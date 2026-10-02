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
