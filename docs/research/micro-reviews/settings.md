# Settings micro-review

Scope: `app/SiloUI/src-tauri/src/settings.rs`.

Read-only source review. Checked the specified first, second, and third pass reports for duplicates. No builds, tests, app launches, or live data access were performed.

## SETTINGS-1: Native validation rejects the supported empty onboarding draft

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/settings.rs:432` (also `:125–127`).
- **Trigger:** Delete the last sandbox during onboarding, then save the recovery draft with `machines: []`.
- **Evidence:** `valid_draft` requires `(1..=64).contains(&machines.len())`, so `update_draft` returns `Invalid onboarding draft`. The frontend contract at `src/contracts/silo.ts:77` allows zero machines. `src/features/onboarding/onboarding-recovery.test.tsx:42–61` explicitly exercises deleting the last sandbox, restoring an empty draft, and completing setup, but uses a memory backend that bypasses native validation. `onboarding-app.tsx:282–287` sends draft changes to the settings store.
- **Consequence:** The desktop cannot persist that supported recovery state. Restart restores the previous saved sandbox list instead of the deletion. The rejected draft also produces a save error despite being valid under the frontend contract.
- **Suggested fix:** Allow zero through 64 machines in recovery drafts, matching the frontend contract. Keep validation of each present machine and duplicate identities/names.
- **Test that would catch it:** Save a valid one-machine draft through `SettingsStore`, update it to `machines: []`, reload from the same temporary file, and assert the empty list survives with no save error. Include an unfinished editor with zero saved machines.

## SETTINGS-2: Session shutdown cannot impose a deadline on an already finishing Quit

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/settings.rs:877` (also `:604–617`, `:979–987`).
- **Trigger:** A user Quit enters `FINISHING` and starts waiting for startup or VM work; logout, shutdown, or SIGTERM arrives before that work finishes.
- **Evidence:** `finish_exit` passes the current deadline by value to `stop_local_vms`. For an ordinary Quit it passes `None`, which selects the direct waiting path at `:846–848`. A later `end_session` records a deadline, but `begin_exit` cannot start another generation because the phase is already active. Its fallback calls `finish_exit`, whose `claim_exit_for` accepts only `REQUESTED` or `FLUSHING`, never `FINISHING`. The original worker does not reread session state until after the blocking stop returns (`:878–879`). The runtime stop timeout is 45 seconds (`src/runtime.rs:47`), exceeding the default session budget of 20 seconds (`src/system_shutdown.rs:23`); waiting for the operation gate can add more time.
- **Consequence:** Logout/SIGTERM loses the promised bounded exit when it overlaps an ordinary Quit. Silo can remain waiting past the session deadline, delaying logout or being terminated externally before completing cleanup.
- **Suggested fix:** Make session escalation bound the existing shutdown worker as well as frontend flushing. Preserve one VM-stop owner, but let the exit coordinator stop waiting at the earliest session deadline even when the phase is already `FINISHING`.
- **Test that would catch it:** Use a controllable VM-stop seam: begin ordinary Quit, block its stop worker, then signal session end with a short budget. Assert the coordinator exits by that deadline without requiring the stop seam to resolve and without starting a second stop transaction. The existing session fallback test covers `FLUSHING` only.

## SETTINGS-4: An in-flight Quit status read reopens a session-end prompt

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/settings.rs`, `QuitConfirmation::close` and `request_quit`.
- **Trigger:** A user Quit passes the initial admission check and waits in `running_names`; session shutdown closes the pending prompt before that status read returns.
- **Evidence:** `close` cleared only the pending request ID. The delayed worker then called `ask`, which allocated another request ID and emitted another prompt. The regression `a_late_quit_status_read_cannot_reopen_the_session_end_prompt` failed with `Some(QuitRequest)` after closing session confirmation.
- **Consequence:** Logout or shutdown displays a fresh cancel-capable Quit prompt; its negative answer invokes operating-system cancellation even though session shutdown must proceed without confirmation.
- **Fix:** Close confirmation admission permanently for this session, under the same mutex that allocates prompt IDs.
- **Regression:** Close confirmation before a delayed status result is submitted and require no prompt for either running sandboxes or a failed status read. Continue rejecting answers to the invalidated prompt.

## SETTINGS-5: A pending AppKit Quit suppresses session escalation

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/system_shutdown/macos.rs`, `should_terminate`.
- **Trigger:** A terminate callback carrying Logout or Shutdown arrives while `PENDING` remains true for an earlier user Quit.
- **Evidence:** The hook returned `TERMINATE_LATER` before parsing the new event reason, so the session request never reached `system_shutdown::route` or `settings::end_session`. Extracting this exact dispatch gate into `begin_terminate` reproduced the missing route: the failing test observed only UserQuit rather than UserQuit followed by Logout/Shutdown.
- **Consequence:** An already pending confirmation or frontend flush keeps the ordinary unbounded Quit policy instead of receiving the session deadline and bypassing confirmation.
- **Fix:** Continue suppressing repeated user Quit requests, but route session-ending reasons even while AppKit awaits a reply.
- **Regression:** Route UserQuit followed by each session-ending reason, require both routes, and retain one route for repeated UserQuit. This proves the dispatch policy; no AppKit event or live VM was exercised.

## SETTINGS-6: Short session deadlines expire before native shutdown starts

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/settings.rs`, `end_session` frontend fallback.
- **Trigger:** The frontend does not answer its settings-flush request and the session budget is less than two seconds. `system_shutdown::logind_budget` explicitly supports a one-second budget.
- **Evidence:** The fallback waited a fixed two seconds while the session deadline independently approved exit. Native `finish_exit` therefore had no opportunity to claim shutdown, and the approved state bypassed the exit backstop. The scheduling regression failed for the supported one-second budget; an elapsed-deadline regression also reproduced the unnecessary wait.
- **Consequence:** Short Linux shutdown budgets can end Silo without even starting its local-VM stop transaction.
- **Fix:** Cap frontend waiting at half the remaining session budget, retaining the existing two-second ceiling. Schedule immediately when the deadline has elapsed.
- **Regression:** Require native fallback admission to be scheduled strictly before a one-second deadline, preserve the two-second wait for the ordinary twenty-second session budget, and require zero wait for elapsed deadlines. No live shutdown or VM was exercised.
