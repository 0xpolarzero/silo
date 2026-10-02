# ChatGPT app follow-up fix loop

Scope: the native ChatGPT app implementation and adjacent computer-use state integration. Work stays in `codex-fix-chatgpt-app`; each fix is folded individually into `codex/integration`.

## CHATGPT-APP-4: Remote status depends on an unrelated local listener

- **Priority:** P2
- **Location:** `app/SiloUI/src/desktop/computer-use-bridge.ts`, `createChatGptAppStore.start`.
- **Trigger:** Subscribe to remote status while registration of the local `chatgpt-app-status` listener is pending. Remote stores ignore that listener's events, but their first read and polling schedule were started only after registration settled.
- **Consequence:** The remote download status remains unread, despite the remote status command being available. Every remote store also registers an unused local event listener.
- **Regression:** `reads remote download status without waiting for local event registration` failed with zero status calls before the fix. It now verifies an immediate remote read, the next poll, no local event registration, and cancellation on unsubscribe.
- **Fix:** Start remote reads directly; retain registration-before-read ordering for the local store, which consumes events.
- **Verification:** Deterministic frontend fixtures only. Both computer-use frontend files passed, 125 tests total; Node 24 typecheck and lint passed. No app, live VM, or production data is used. Red output is preserved under `/tmp/silo-codex-target/verification/chatgpt-app/remote-registration-red.log`.
