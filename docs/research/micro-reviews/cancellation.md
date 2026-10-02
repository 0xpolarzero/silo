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

## Log export cancellation before publication

- Trigger: cancel after all pages have been written, before the atomic save publishes the temporary file.
- Cause: the last cancellation check preceded the file synchronization; publication did not recheck it.
- Consequence: an export could replace the existing destination after cancellation during this interval.
- Correction: check cancellation after synchronizing the temporary file and before its rename.
- Evidence: a fixture cancelled immediately after the production writer completed. The regression failed because the existing file was replaced; after correction it returns the cancelled result and retains only the previous file.
- Boundary: publication itself is the commit step; cancellation after its final check can still complete successfully.
- Verification: all eleven extracted log-export tests, Rust formatting, and whitespace checks passed. Full Cargo verification remains queued on the shared artifact lock; the harness does not establish whole-application compilation.

## Final verification

The transfer source, transfer component, and source-cleanup suites passed all 40 tests after integration synchronization. Frontend typecheck, touched-file lint, Rust formatting, and whitespace checks passed; the worktree was clean.

A second harness compiled the complete, unchanged `log_export.rs`, including its command macros and dialog adapters, against the shared cache's Tauri and dialog dependencies. All eleven tests passed. Only the unrelated runtime query and process-wide test isolation support are fixture replacements; native dialogs and runtime queries are not exercised. Sources, scripts, and failing/passing logs remain under `/tmp/silo-codex-target/verification/cancellation/`.

The full Cargo test command used the prescribed shared target and synthetic GitHub configuration. It produced no test result while waiting on the artifact lock and was stopped with SIGINT after its exact command and worktree were reverified. These results establish the changed module's compilation and fixture behavior, not whole-application compilation or live cancellation. No bundle was inspected, no app was launched, and no live VM or production data was used.
