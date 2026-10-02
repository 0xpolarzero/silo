# GitHub HTTP micro-review

Scope: `app/SiloUI/src-tauri/src/github_http.rs`.

Read-only source review. Checked the two earlier review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` for existing findings. No builds, tests, app launches, or live GitHub requests were performed.

## GITHUB-HTTP-1 — P2: Interrupted successful response permanently stops safe reads

- **File:line:** `app/SiloUI/src-tauri/src/github_http.rs:313`.
- **Trigger:** A safe GET receives HTTP 200 headers, then the connection closes before the declared response body finishes, or the body read times out. `read_to_end` fails at lines 306–319.
- **Evidence:** That error branch calls `retryable_response(200, headers, Null, true)`. Lines 272–273 return false because 200 is neither a rate-limit response nor a server error. Passing `safe` as the persistence flag does not override this: line 162 requires `retryable` to be true. The failure therefore stores `until: None` at line 172, and `Gates::check` rejects the same request indefinitely at line 127. This differs from the invalid-JSON HTTP 200 branch at lines 348–356, which correctly makes safe requests retryable.
- **Consequence:** A single interrupted body stops automatic recovery for that credential and API path despite a restored connection. This affects `/user` token validation and installation/repository catalog reads. The catalog worker schedules another attempt after failure (`github.rs:2586`), but the preflight gate prevents that attempt from reaching GitHub. Recovery requires an explicit retry that clears request failures, a changed request key, or relaunch.
- **Suggested fix:** Classify response-body transport failures as retryable whenever `safe` is true, while preserving rate-limit floors and the refusal to replay ambiguous unsafe operations.
- **Test that would catch it:** Extend the local wire-response test seam to accept `safe` and a stable request key. Return HTTP 200 with a Content-Length larger than the bytes sent, then close the connection. For a safe request, assert that a retry deadline exists, advance beyond it, and verify that a complete second response succeeds without resetting gates. Repeat with an unsafe token-mint request and assert that it remains blocked. Test proposed, not executed under the review-only rules.
