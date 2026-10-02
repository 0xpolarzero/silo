# Desktop proxy micro-review

Scope: `app/SiloUI/src-tauri/src/desktop_proxy.rs`.

Read-only source review. Checked the first, second, and local third-pass review reports for prior desktop-proxy findings. No builds, tests, or application launches were performed.

## DESKTOP-PROXY-1 · P2 · Abandoned HTTP requests retain connection slots indefinitely

- **Location:** `app/SiloUI/src-tauri/src/desktop_proxy.rs:195–218`, `299–308`, and `348–365`.
- **Trigger:** An authenticated ordinary HTTP request reaches an upstream that keeps the connection open without returning bytes. The browser then closes the client connection while the proxy remains alive.
- **Evidence:** For a zero-body GET, the writer calls `forward_body` with `remaining == 0` and returns immediately, without monitoring client EOF or setting `ended` (`158–188`, `299–305`). The response direction calls `relay(server, client, ...)`. Its 250 ms read timeout always retries; it has no overall or idle deadline (`195–215`). It cannot discover the closed client through a write because the upstream sends nothing. Only the response direction sets `ended`, after that relay returns (`306–307`). The connection count is decremented only after `serve` returns (`362–365`). The 120-second request-body deadline does not bound this response wait.
- **Consequence:** Each abandoned request retains its handler, both sockets, and an active connection slot until the upstream closes or the entire proxy is dropped. With 48 such requests, the listener discards every new connection (`348–350`), including requests to otherwise responsive upstream routes. Closing or retrying the browser request does not release its slot.
- **Suggested fix:** Bound ordinary HTTP response waits with a response/idle deadline and cancel abandoned client requests. Keep long-lived WebSocket handling separate so its intended idle lifetime is preserved. Ensure cancellation closes the upstream and lets the handler decrement the active count.
- **Test that would catch it:** Use a synthetic Unix upstream that consumes a valid authenticated GET and holds its socket open without responding. Close the TCP client and assert that the upstream observes EOF and the handler completes within the cancellation bound while `Proxy` remains alive. Also hold 48 such abandoned requests, release none from the upstream side, and verify that a fresh request to a responding route is admitted after cleanup. Synchronize request consumption with barriers rather than sleeps.
