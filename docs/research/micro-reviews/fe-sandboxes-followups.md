# Sandbox frontend fix-loop follow-ups

Scope: `app/SiloUI/src/features/sandboxes/`. These findings were reproduced with deterministic frontend tests in the isolated `codex/fix-fe-sandboxes` worktree. No application, VM, production data, or credential store was used.

The original shared-worktree review remains its audit trail. Its two findings were fixed and folded separately: FE-SANDBOXES-1 in `bc8813dc`; FE-SANDBOXES-2 in `f5b8179f`, with the restored-save effect callback corrected in `687e9b26`.

## FE-SANDBOXES-3: Open deletion confirmations bypass new eligibility restrictions

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/sandboxes/model/use-machine-editing.ts:287`.
- **Trigger:** Open Delete, then publish a configuration lock or an offline owning computer before confirming.
- **Consequence:** The confirmation invokes the deletion callback despite the restriction that disables newly opened menu actions.
- **Evidence:** Both added cases in `machine-deletion.test.tsx` failed before the guard; the deletion callback was invoked once in each case. `deleteWithNotice` checked running/busy state but `deleteMachineNow` checked neither the interaction lock nor `validateOperation`.
- **Fix:** Recheck the lock and operation eligibility, including computer identity, immediately before invoking deletion.
- **Regression:** Open the confirmation with eligibility enabled, rerender with each restriction, confirm, and assert no deletion callback runs.
- **Commit:** `fa2a2eeb`, folded into `codex/integration`.

## FE-SANDBOXES-4: Switching computers displays stale custom resource text

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/sandboxes/components/machine-editor.tsx:59`.
- **Trigger:** Start a new sandbox on a four-CPU computer, switch Run on to another computer, select a 12-CPU ceiling, then switch back.
- **Consequence:** The custom input displays 4 while the draft contains 12. Saving rejects the apparently valid displayed value, and the displayed resource setting no longer describes the submitted draft.
- **Evidence:** The added resource test expected the current selection, 12, but received the old input text, 4. Preset selection updated the draft without updating `customText`; removing that preset by changing capacity then exposed the stale text.
- **Fix:** Keep the custom text synchronized when the user selects a preset, preserving raw custom input for correction.
- **Regression:** Exercise the two-computer selection sequence, verify the displayed 12, correct it to 4, and assert that Save submits a four-CPU ceiling to this computer.
- **Commit:** `21a8d80c`, folded into `codex/integration`.

## FE-SANDBOXES-5: A no-op reorder overwrites an open editor's concurrency baseline

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/sandboxes/components/machine-list.tsx:227`.
- **Trigger:** Edit sandbox A, receive a concurrent update to A's memory ceiling, focus sandbox B's reorder handle at the end of the list, press ArrowDown, then save A.
- **Consequence:** Although no reorder occurs, the keyboard handler captures a new baseline. Save sends the old draft against the latest configuration as its expected state, authorizing replacement of the concurrent memory change instead of triggering a stale-state rejection.
- **Evidence:** The new conflict test failed because the callback's original configuration and baseline contained `maxMemoryGiB: 64`, while the submitted draft still contained the originally opened `maxMemoryGiB: 48`.
- **Fix:** Disable both keyboard and drag reordering while an editor is open. Guard the handlers before baseline capture and announce disabled handles through their semantic attributes.
- **Regression:** Assert that the no-op keyboard attempt retains A's original expected configuration and list baseline, submits no reorder, and keeps reorder handles disabled while editing.
- **Commit:** `aeb26b92`, folded into `codex/integration`.

## FE-SANDBOXES-6: Deleting another sandbox replaces an open editor's baseline

- **Priority:** P2.
- **File:line:** `app/SiloUI/src/features/sandboxes/model/use-machine-editing.ts:287`.
- **Trigger:** Edit sandbox A, receive a concurrent update to A's memory ceiling, confirm deletion of sandbox B, then save the still-open editor for A.
- **Consequence:** Deletion calls `captureBaseline` on the editor's shared ref. Save then sends A's old draft against the concurrent configuration as its expected state, allowing the concurrent memory change to be overwritten.
- **Evidence:** The new conflict regression failed with the same 48-to-64 mismatch as FE-SANDBOXES-5 after confirming B's deletion. B's deletion correctly used current state; A's save incorrectly inherited that snapshot.
- **Fix:** Capture a separate snapshot for deletion and scope its expected configuration to the computer of the deleted machine. Leave the open editor's baseline untouched.
- **Regression:** Confirm B's deletion against the latest list, publish its removal, and assert A's subsequent save still carries A's originally opened configuration and baseline.
- **Commit:** `6278da4d`, folded into `codex/integration`.

## FE-SANDBOXES-7: Host-derived presets exceed the runtime CPU limit

- **Priority:** P3.
- **File:line:** `app/SiloUI/src/features/sandboxes/components/machine-editor.tsx:197`.
- **Trigger:** Open a new sandbox editor with a host capacity report of 512 logical CPUs.
- **Consequence:** The CPU menus offer 512 as a preset even though resource validation limits sandbox CPU counts to 255. The menu recommends a value Save must reject.
- **Evidence:** The new resource test failed because its menu options included `512`. The custom input already uses `resourceMaximums`, which clamps the host capacity to `runtimeLimits.cpus`; the presets used the raw host capacity instead.
- **Fix:** Derive CPU and memory presets from the same clamped maximums used by custom input fields.
- **Regression:** With a deterministic 512-CPU capacity report, assert that 512 is absent, 255 is offered, and selecting 255 produces a valid save.
- **Commit:** `8012439c`, folded into `codex/integration`.

## Verification

Every defect fix followed a failing behavior test, minimal implementation, focused passing tests, typecheck, touched-file lint, Rust formatting check, and a separate commit folded into `codex/integration`. User-visible fixes include patch changesets.

Final merged-code checks passed:

- `npm --prefix app/SiloUI test -- src/features/sandboxes src/features/application/pages/sandbox-detail.test.tsx src/features/application/pages/overview-delete.test.tsx src/features/application/pages/overview-sandbox-order.test.tsx --maxWorkers=1 --testTimeout=20000`: 124 tests in 18 files.
- After adding an additional regression for a stale save rejected while its surface is unmounted, `machine-editor-drafts.test.tsx` passed all 8 cases. The failure notification remains visible and the edited draft can be restored.
- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm --prefix app/SiloUI run lint -- src/features/sandboxes`: passed without warnings.
- `CARGO_TARGET_DIR=/tmp/silo-codex-target cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`: passed.
- `git diff --check`: passed.

One intermediate concurrent test run timed out in an existing five-second conflict test and produced a following React act warning. A rerun with one worker and a 20-second test deadline passed all 23 conflict/deletion cases; the final broader run used those same CLI settings. No repository timeout settings were changed. These fixture tests establish frontend behavior, not live VM or release readiness.
