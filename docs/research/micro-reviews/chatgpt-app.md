# ChatGPT app micro-review

Scope: `app/SiloUI/src-tauri/src/chatgpt_app.rs` and `app/SiloUI/src-tauri/src/chatgpt_app/`.

Read-only source review. Checked the three specified earlier review sets for overlapping findings. No builds, tests, application launches, or live data access were performed; the findings below are source-traced.

## CHATGPT-APP-1: A FIFO publication record blocks verification indefinitely

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/chatgpt_app.rs:469` (`read_small`), called by `verify_published` at line 1449.
- **Trigger:** The expected `<version>-<arch>.published.json` name is a FIFO with no writer. `read_small` calls `open_file` with `O_RDONLY`; the helper adds `O_NOFOLLOW | O_CLOEXEC`, but not `O_NONBLOCK`. Opening a FIFO for reading blocks before `file.metadata()` can reject its type.
- **Consequence:** `current_status`, local status commands, startup preparation, and Retry cannot finish this verification. The automatic worker cannot remove the invalid record because `ensure_inner` performs verification before taking the storage lock and removing invalid entries. This defeats the intended refusal and recovery for nonregular records.
- **Suggested fix:** Open publication records with `O_NONBLOCK | O_NOFOLLOW`, then require a regular file through descriptor metadata before reading. Keep the size and ownership checks.
- **Test that would catch it:** In a child process with a temporary storage root, create the expected record with `mkfifo` and no writer. Assert `current_status` returns Idle within a short deadline and `ensure` replaces the invalid record using the existing good-package fixture. Use a parent deadline so the regression cannot hang the test suite.

## CHATGPT-APP-2: Interrupted deletion leaves permanent trees inside the mounted directory

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/chatgpt_app.rs:439` (`Dir::remove_entry`), cleanup at line 1488 and collection at line 1878.
- **Trigger:** A published version is renamed to `.rejected-<suffix>` inside `published/`, then the process exits before `remove_dir_all` finishes, or deletion returns an error. `remove_entry` leaves that renamed directory in its original parent. Both preparation and garbage collection call `clean_staging` only on the storage root; the `published/` collection loop skips every name that fails `is_version_dir`, including `.rejected-*`.
- **Consequence:** Subsequent preparation and collection never revisit the abandoned tree. Its remaining bytes persist indefinitely, and the tree remains in the directory mounted into every VM and walked by MicroSandbox. Repeated interrupted deletions accumulate storage despite successful later collections.
- **Suggested fix:** Under the existing storage lock, clean `.rejected-*` entries in `published/` as well as leftovers in the root, using the appropriate directory handle. Keep deletion failures eligible for a later cleanup pass.
- **Test that would catch it:** Place a populated `published/.rejected-interrupted` directory in a temporary root to model termination after the rename. Run garbage collection and preparation; assert the abandoned directory is removed while pinned and in-use versions survive. The existing root-level leftover test does not cover this parent directory.

## CHATGPT-APP-3: Retry requests can be lost during terminal worker shutdown

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/chatgpt_app.rs:2157` (`ensure_in_background`) and `app/SiloUI/src-tauri/src/chatgpt_app/auto.rs:47` (`settle`).
- **Trigger:** `run_prepare` publishes a nonretryable Failed status while its worker still owns `auto::WORKER`. A concurrent `retry_now` reads that failure and calls `ensure_in_background`; claiming the slot fails, so it only sets `auto::RETRY.woken`. The original worker then returns the terminal failure from `settle`, without calling `Wake::wait`, and drops its claim.
- **Consequence:** The explicitly requested Retry starts no attempt. No worker remains to consume the wake, and terminal failures have no automatic retry. A second user action or restart is required.
- **Suggested fix:** Coordinate pending manual retries with worker termination and slot release so a request either restarts the current worker or starts its successor. Preserve the single-worker rule and keep unrequested terminal failures stopped.
- **Test that would catch it:** Use local `Slot` and `Wake` instances plus barriers to pause an attempt after its fatal status becomes observable. Issue Retry while the claim is held, then allow `settle` to return. Assert exactly one subsequent attempt runs without another Retry, and separately assert fatal failure without a request remains terminal.
