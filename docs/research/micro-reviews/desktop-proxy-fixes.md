# Desktop proxy fix follow-up

Scope: `app/SiloUI/src-tauri/src/desktop_proxy.rs`.

## DESKTOP-PROXY-1 · P2 · Idle HTTP responses retain abandoned handlers

Fixed and folded in `e0bfb0df`: ordinary HTTP responses have a 120-second idle deadline, reset when response data is forwarded. WebSocket streams retain their existing lifetime. TCP EOF alone cannot distinguish an abandoned client from a client that half-closes its request and still expects a response, so cleanup uses the response deadline.

Integration subsequently reconciled this fix with `d9936652` in `cfe608d1`: the final behavior uses a shared 120-second total deadline for HTTP request bodies and responses, including responses that keep producing data. WebSocket streams remain exempt. The deadline argument added to `forward_body` also requires the interruption regression to pass `None` for its finite synthetic transfer. Integration replaced the duplicate idle-timeout changeset with the total-deadline changeset.

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

Fixed and folded in `5d6c4346`. All 11 module tests, Rust formatting, module Clippy with warnings denied, frontend typecheck, and frontend lint passed before integrating the additional deadline tests.

## DESKTOP-PROXY-4 · P2 · Disconnected WebSocket clients retain handlers

- **Location:** `app/SiloUI/src-tauri/src/desktop_proxy.rs`, WebSocket writer branch in `serve_with_header_progress`.
- **Trigger:** A WebSocket upgrade completes, the client disconnects, and the guest keeps its socket open without sending more data.
- **Evidence:** The client-to-guest relay observes EOF and returns, but only the guest-to-client direction sets `ended`. The response relay therefore keeps retrying read timeouts forever. WebSockets intentionally have no HTTP deadline. The real-socket regression completed the upgrade, kept the guest open, dropped the client, and failed with `disconnected WebSocket retained its handler: Timeout`.
- **Consequence:** The abandoned upgraded connection retains its handler and active connection slot until the guest closes or the entire proxy is dropped; repeated disconnects can exhaust the 48-slot limit.
- **Fix:** Set the shared `ended` flag when the WebSocket writer returns so the response relay also stops. Do not do this for completed ordinary HTTP bodies, which still need their response.
- **Regression:** `websocket_client_disconnect_releases_silent_upstream` requires an idle upgraded connection to survive beyond the configured HTTP deadline, then requires handler completion and guest EOF after client disconnect without dropping Proxy or closing the guest socket.

## DESKTOP-PROXY-5 · P3 · Unicode trimming changes the meaning of forwarded framing fields

- **Location:** `app/SiloUI/src-tauri/src/desktop_proxy.rs`, `request_header` field-value and cookie-part trimming.
- **Trigger:** An authenticated request contains `Content-Length: \u{00a0}1`, where the prefix is a UTF-8 nonbreaking space, or a typed field ends in another Unicode whitespace character.
- **Evidence:** `str::trim` removes Unicode whitespace, so the proxy accepts the field as a body length of one, but `kept.push(line)` forwards the original bytes. The regression failed on that exact Content-Length input. A disposable Python standard-library `http.client.parse_headers` diagnostic interpreted those bytes as `Â\u{00a0}1`; integer parsing rejected them. This proves a parser mismatch, not an observed failure in the live guest. [RFC 9110 section 5.6.3](https://httpwg.org/specs/rfc9110.html#whitespace) defines HTTP optional whitespace as space or horizontal tab.
- **Consequence:** Proxy framing validation accepts a different value from the one sent upstream. Similar trimming accepts malformed Upgrade, Host, Origin, and native cookie fields. No native-cookie bypass or request-smuggling exploit was established.
- **Fix:** Trim only space and horizontal tab when interpreting field values and native-cookie parts.
- **Regression:** `unicode_whitespace_cannot_disguise_typed_header_values` rejects nonbreaking/em/ideographic spaces around framing, upgrade, origin, host, and authentication values; valid space/tab-delimited Content-Length still forwards its declared body length.

Fixed and folded in `a37abab9`. All 17 module tests, Rust formatting, module Clippy with warnings denied, frontend typecheck, and frontend lint passed.

## DESKTOP-PROXY-6 · P3 · Header-only requests acquire undeclared trailing bytes

- **Location:** `app/SiloUI/src-tauri/src/desktop_proxy.rs`, construction of the rewritten header in `request_header`.
- **Trigger:** A valid authenticated GET contains only Host and the native cookie, with no retained client fields and no request body.
- **Evidence:** The original format string emits the Connection line's CRLF, an empty retained-field string, and another two CRLFs. The upstream therefore receives an extra CRLF after the header terminator despite a body length of zero. Extending the existing real-socket regression to omit Content-Length failed with `unexpected bytes after the declared request body`. [RFC 9112 section 2.2](https://httpwg.org/specs/rfc9112.html#message.parsing) forbids following an HTTP/1.1 request with an extra CRLF.
- **Consequence:** A bodyless client request gains bytes the client did not send. A strict upstream rejecting bytes after the declared request body closes without returning its response in the regression. No live guest failure was established.
- **Fix:** Terminate each retained field once, then emit exactly one blank line whether or not retained fields exist.
- **Regression:** `completed_http_requests_keep_write_side_open_for_response` now checks GET without Content-Length, GET with Content-Length zero, and POST with a body. The synthetic upstream rejects unexpected trailing bytes; all cases must still receive their response after client write-half-close.
