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
