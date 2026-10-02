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
