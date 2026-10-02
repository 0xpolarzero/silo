# Cancellation follow-up

## Export start reply after source disposal

- Trigger: dispose the production source while `start_backup` is pending, then deliver its operation ID.
- Cause: disposal drains existing export waiters; the late reply registered a new waiter after cleanup.
- Consequence: `exportAndVerify` never settled.
- Correction: a waiter created after disposal rejects immediately with the existing unavailable result.
- Evidence: `production-source-transfer.test.ts` failed with no rejection before the fix; all seven tests passed afterward. Typecheck, focused lint, and whitespace checks passed.

## Log export cancellation before worker startup

- Trigger: cancel an export after its command is accepted but before its blocking worker starts.
- Cause: the worker reset the shared cancellation flag, losing the pending request.
- Consequence: the cancelled export opened its picker and could replace an existing file.
- Correction: capture a cancellation generation before queueing; check it before selecting and writing. New exports capture the latest generation without clearing earlier cancellations.
- Evidence: the extracted production worker and regression test failed because the cancelled export saved its file. All nine log-export tests passed after the fix, including preservation of an existing destination and successful subsequent export. The extraction retains the production worker, writer, atomic save, models, and tests; it omits Tauri window/dialog adapters and uses a local test isolation mutex. Evidence is in `/tmp/silo-codex-target/verification/cancellation/`.
- Boundary: fixture paths and query results only. No app, native picker, or VM was launched.

## Archive inspection with an aborted signal

- Trigger: pass an already aborted signal to `inspectArchive`, or abort from the file-selection callback before inspection starts.
- Cause: registering an abort listener does not deliver an abort that already happened.
- Consequence: native archive inspection starts and has no cancellation listener that can stop it.
- Correction: reject the aborted signal before starting native work.
- Evidence: both regressions in `production-source-transfer.test.ts` returned successful inspections before the fix. They now reject with `AbortError` without invoking inspection; ordinary in-flight cancellation remains covered.
- Verification: the transfer source and component suites passed all 37 tests; typecheck, focused lint, and whitespace checks passed.

## Log export query failure after cancellation

- Trigger: cancel while a log page is pending, then receive a query error.
- Cause: the page query propagated its error before checking cancellation.
- Consequence: the export shows a failure notification after the user cancelled it.
- Correction: check cancellation after the query completes, then propagate uncancelled errors.
- Evidence: the production writer regression failed with the remote query error for the cancelled request. It also checks that an uncancelled query retains the same error and neither path writes page data.
- Verification: all ten extracted log-export tests, Rust formatting, and whitespace checks passed.
