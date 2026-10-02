# Sandbox frontend continued fix loop

Scope: `app/SiloUI/src/features/sandboxes/` and adjacent sandbox configuration and overview modules. Work uses the isolated `codex/fix-fe-sandboxes` worktree, deterministic fixtures, and the shared dependency cache. No app or VM is launched.

## FE-SANDBOXES-8: Removing a computer corrupts the scope of an open local edit

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/application/pages/overview-page.tsx:334`.
- **Trigger:** Open a local sandbox editor while another computer's sandboxes are displayed, remove that computer, then save the local edit.
- **Consequence:** The captured baseline's remote rows become part of the local request. Their encoded IDs violate the native local configuration schema, preventing the local save.
- **Evidence:** The added rendered regression failed because both the submitted list and expected baseline contained `silo-remote:office:00000000-0000-4000-8000-000000000001`. `localOnly` identified ownership using only the current displayed-row map; the removed remote row was no longer in that map. Production constructs those stable encoded IDs at `production-source.ts:678–682`.
- **Fix:** Derive computer ownership from the stable encoded target before consulting live row metadata, and use that identity consistently for local filtering and editor scoping.
- **Regression:** Edit a local VM, publish removal of the remote computer and its rows, save, and assert that both submitted and expected lists contain only the originally captured local machines.

## FE-SANDBOXES-9: Stop-and-save confirmation bypasses current validation

- **Priority:** P2.
- **Trigger:** Open Stop and save while host capacity is unknown, then receive the computer's capacity before confirming.
- **Consequence:** The confirmation submits CPU/memory ceilings above the newly reported host limits instead of presenting correctable validation errors.
- **Evidence:** The new rendered regression failed because the save callback received maxCPUs 12 and maxMemoryGiB 48 after capacity became 8 CPUs and 16 GiB.
- **Fix:** Run the same validation on confirmation, skip only the already accepted stop question, and close that question when validation fails.
- **Regression:** `machine-stop-confirmation.test.tsx` refreshes capacity with the question open and asserts no save, an accessible field error, and dismissal of the question.

## FE-SANDBOXES-10: Open editors ignore checkpoint operations

- **Priority:** P2.
- **Trigger:** Open an editor from the list or detail page, then start a checkpoint operation through another surface.
- **Consequence:** Save remains enabled while the checkpoint owns the sandbox, despite the row and lifecycle controls already blocking changes.
- **Evidence:** Both rendered regressions failed on an enabled Save button after publishing a running checkpoint operation.
- **Fix:** Include running checkpoints in the shared sandbox editing busy reason, which also rechecks menu saves and deletions.
- **Regression:** `overview-availability.test.tsx` covers both editor surfaces, accessible blocking text, and restored Save with the draft intact after completion.

## FE-SANDBOXES-11: Navigation drops conflict and review notices

- **Priority:** P2.
- **Trigger:** Receive a stale save rejection or review concurrent changes, then leave the editor's surface and return.
- **Consequence:** The draft and rebased baseline survive, but the conflict actions or explicit description of overwritten concurrent values disappear.
- **Evidence:** Both rendered regressions failed because the restored editor had no conflict alert or review status.
- **Fix:** Store and restore conflict and review state with the existing in-memory editor draft.
- **Regression:** `machine-editor-drafts.test.tsx` covers navigation before and after Review changes, including retained draft values and both sides of the CPU conflict.

## FE-SANDBOXES-12: Stale status permits an unconfirmed resource edit

- **Priority:** P2.
- **Trigger:** The sandbox's last known state is stopped, but its status becomes stale while settings are open. A remote runtime version with an unrecognized status is also mapped to stopped/stale in `desktop/production-source.ts`.
- **Consequence:** Save remains enabled and skips the stop confirmation. Native `update_machine` inspects actual state and automatically stops a running VM before applying resource settings (`src-tauri/src/runtime.rs`), so an unverified stopped state can authorize interruption without the expected question.
- **Evidence:** Both rendered editor regressions failed because Save stayed enabled after freshness changed to stale. Lifecycle controls already reject this same status.
- **Fix:** Reject VM settings mutations on stale status through the shared editing busy reason, preserving the draft until freshness recovers.
- **Regression:** `overview-availability.test.tsx` covers list/detail editors, accessible blocking text, no save, and intact drafts after recovery.
