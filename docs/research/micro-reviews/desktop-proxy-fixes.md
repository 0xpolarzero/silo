# Desktop proxy fix follow-up

Scope: `app/SiloUI/src-tauri/src/desktop_proxy.rs`.

## DESKTOP-PROXY-1 · P2 · Idle HTTP responses retain abandoned handlers

Fixed and folded in `e0bfb0df`: ordinary HTTP responses have a 120-second idle deadline, reset when response data is forwarded. WebSocket streams retain their existing lifetime. TCP EOF alone cannot distinguish an abandoned client from a client that half-closes its request and still expects a response, so cleanup uses the response deadline.

The real-socket regression failed before the implementation with `silent HTTP response retained its handler: Timeout`, then passed for GET and POST. The existing completed-request test now also half-closes the client write side and verifies that both methods still receive their response. All eight module tests passed. Rust formatting, standalone module Clippy with warnings denied, frontend typecheck, and frontend lint passed. Cargo native tests were queued behind the shared target lock at fold time. Tests used only synthetic sockets and credentials; no app or VM was launched.

## DESKTOP-PROXY-2 · P2 · Bare control characters bypass header sanitization

- **Location:** `app/SiloUI/src-tauri/src/desktop_proxy.rs:74–103`, before this correction.
- **Trigger:** A caller sends a valid native authentication cookie and a field such as `X-Note: harmless\nAuthorization: Basic attacker`, with a bare LF inside the field value.
- **Evidence:** The parser splits fields only on CRLF, validates field names but not values, and forwards unknown fields verbatim. The LF-containing field therefore survives the branch that removes client Authorization headers. The failing regression confirmed acceptance of that exact input. [RFC 9112 section 2.2](https://httpwg.org/specs/rfc9112.html#message.parsing) permits recipients to recognize bare LF as a line terminator, so downstream parsing can see the embedded Authorization as a separate field. [RFC 9110 section 5.5](https://httpwg.org/specs/rfc9110.html#field.values) requires rejection or replacement of CR, LF, and NUL inside field values before forwarding.
- **Consequence:** Native header stripping does not guarantee that the guest receives only the injected Authorization field. Malformed values can also introduce Cookie or framing fields. This finding does not bypass native-cookie authentication or establish guest credential disclosure; interpretation by the live guest service was not tested.
- **Fix:** Reject ASCII control characters in the request line and reject controls other than horizontal tab in raw field values before trimming or forwarding them. Keep horizontal tabs valid in field values.
- **Regression:** `control_characters_cannot_bypass_header_sanitization` covers bare LF, CR, NUL, vertical tab, controls trimmed from Content-Length/Upgrade, controls in the request target, and a valid tab-containing field. The test failed before the fix on the injected Authorization example.

Fixed and folded in `dd7d2fe2`. All nine module tests, Rust formatting, module Clippy with warnings denied, frontend typecheck, and frontend lint passed.

## DESKTOP-PROXY-3 · P3 · Interrupted reads truncate requests and response streams

- **Location:** `app/SiloUI/src-tauri/src/desktop_proxy.rs`, error branches in `forward_body`, `relay`, and the request-header read loop.
- **Trigger:** A socket read returns `ErrorKind::Interrupted` while the connection still has readable data.
- **Evidence:** Both streaming loops retry only WouldBlock and TimedOut, treating Interrupted as a terminal error. The header loop likewise returns that error. The two regressions inject one Interrupted result through the existing Stream seam, followed by a real Unix socket containing `payload`. Both failed before the fix: zero bytes were delivered instead of all seven. This is an I/O error-handling reproduction, not an observed operating-system signal incident. Rust's [standard streaming copy contract](https://doc.rust-lang.org/std/io/fn.copy.html#errors) retries Interrupted operations.
- **Consequence:** A transient interruption ends an otherwise readable request body or response/WebSocket stream. An interrupted header read closes the request before authentication.
- **Fix:** Retry Interrupted reads while retaining the existing cancellation checks and deadlines.
- **Regression:** `interrupted_body_reads_do_not_truncate_requests` and `interrupted_response_reads_do_not_truncate_streams` require delivery of the complete payload after the injected interruption. Tests use synthetic Unix socket pairs and do not install signal handlers or touch process-wide signal state.
