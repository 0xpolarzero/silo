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

## CHATGPT-APP-5: Nonregular computer-use records block status and policy operations

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/computer_use.rs`, `read_settings_bytes`.
- **Trigger:** The policy or observation JSON filename is a FIFO without a writer. `File::open` waits for a writer before the size check or JSON parsing can reject the record.
- **Consequence:** A settings read never finishes. Policy read-modify-write operations hold `POLICY_LOCK` while reading, so one such policy also prevents changes to other VMs' approval settings.
- **Regression:** `a_fifo_computer_use_record_is_refused_without_waiting_for_a_writer` timed out before the fix. The fixture releases and joins its reader before failing. The actual reader and regression were compiled together in a disposable harness, using only temporary files.
- **Fix:** Open nonblocking, require a regular file through descriptor metadata, then retain the existing 1 MiB read limit. Existing callers treat the error as unreadable policy or absent observation.
- **Verification:** Red output is preserved under `/tmp/silo-codex-target/verification/chatgpt-app/policy-fifo-red.log`. The actual reader/regression harness and its Clippy check passed after the fix; formatting, Node 24 typecheck, and lint passed. The broader native tests are queued against the shared Cargo target with synthetic GitHub configuration; no app or VM is launched.
