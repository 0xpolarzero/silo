# Frontend component fix-loop findings

Scope: `app/SiloUI/src/components/`, correctness and accessibility defects found after the initial `fe-components.md` micro-review. Work and verification use the isolated `codex/fix-fe-components` worktree, Node 24.11.1, and deterministic frontend fixtures. No app or VM is launched.

## FE-COMPONENTS-4 — P2 — Dismissing an external wrapper anchor loses keyboard focus

- **File:line at discovery:** `app/SiloUI/src/components/confirm-popover.tsx:91`; production wrapper at `app/SiloUI/src/features/application/components/import-popover.tsx:47`.
- **Trigger:** Open an import form whose external anchor is a span wrapping the Add button, then press Escape or click Cancel.
- **Evidence:** The close handler prevents Radix focus restoration and calls `.focus()` on the anchor span. The span is not focusable. Both new wrapper-anchor regression cases fail with focus on `document.body` after dismissal.
- **Consequence:** Keyboard position is lost when leaving import review; subsequent Tab navigation starts from the document instead of the Add control.
- **Suggested fix:** Preserve direct focusable anchors and fall back to their enabled focusable child controls. Use the existing `restoreFocus` helper to suppress restored-focus tooltips.
- **Regression:** `confirm-popover.test.tsx` opens a controlled form with a wrapper anchor, dismisses by Escape and Cancel, and asserts focus returns to its Add button.
- **Verification:** Both new cases failed before the fix; focused component tests, typecheck, touched-file lint, Rust formatting, and diff whitespace checks are run before commit.

## FE-COMPONENTS-5 — P3 — A shrinking filter result list invalidates keyboard selection

- **File:line at discovery:** `app/SiloUI/src/components/filter-combobox.tsx:46–53`, with Enter selection at lines 108–111.
- **Trigger:** Highlight a late sandbox option, then refresh the available options with a shorter list while the filter remains open.
- **Evidence:** `activeIndex` only resets on search input or selection. External option changes can leave it beyond the result array. The regression highlights index 20, replaces the list with three entries, and fails because no option is selected and no active descendant exists.
- **Consequence:** Enter stops selecting an available result until another navigation or search interaction repairs the index.
- **Suggested fix:** Clamp stored keyboard selection to the current result list before committing its render.
- **Regression:** `filter-combobox.test.tsx` shrinks an open list, checks a valid active descendant, and selects it with Enter.
- **Verification:** The new case failed before the fix; focused tests and the required checks are run before commit.

## FE-COMPONENTS-6 — P3 — Older clipboard completion overwrites newer feedback

- **File:line at discovery:** `app/SiloUI/src/components/copy-button.tsx:24–32`.
- **Trigger:** Click Copy twice before the first clipboard write completes; let the second finish, then settle the first with the opposite result.
- **Evidence:** Each completion unconditionally updates the same status and starts a reset timer. Deferred clipboard fixtures fail in both orders: late success changes the latest failure to success, and late failure changes the latest success to failure.
- **Consequence:** The button announces the result of an older attempt instead of the user's latest attempt.
- **Suggested fix:** Assign each write an attempt token; only the latest mounted attempt may change feedback or start its reset timer.
- **Regression:** `copy-button.test.tsx` controls the two clipboard promises and checks that both latest-success and latest-failure feedback survive an older opposite completion.
- **Verification:** Both new cases failed before the fix; focused tests and the required checks are run before commit.
- **Integration:** Concurrent commit `dfebec66` supplied the same attempt guard while this fix was being checked. The merge retains that implementation and its cleanup tests, adds both opposite-result regressions from this review, and drops the duplicate changeset.

## FE-COMPONENTS-7 — P2 — Keeping a transfer running loses keyboard position

- **File:line at discovery:** `app/SiloUI/src/components/operation-toast-body.tsx:76–82` and `99`.
- **Trigger:** Open an import or export toast's cancellation confirmation, then activate Keep going with Enter.
- **Evidence:** Keep going switches the conditional body back to progress, unmounting the focused button without restoring focus. The new keyboard regression fails because Cancel is rendered but focus remains on the document.
- **Consequence:** The user loses their keyboard position while the transfer continues and cannot reopen its cancellation prompt with Enter.
- **Suggested fix:** Retain the Cancel button ref and restore it after leaving the confirmation, using the existing focus helper.
- **Regression:** `operation-toast-body.test.tsx` enters the prompt, keeps going with Enter, checks Cancel focus, and reopens the prompt with Enter without invoking cancellation.
- **Verification:** The new case failed before the fix; focused tests and the required checks are run before commit.

## FE-COMPONENTS-8 — P2 — The actions-menu popover host has no accessible name

- **File:line at discovery:** `app/SiloUI/src/components/actions-menu.tsx:74`.
- **Trigger:** Open a registered confirmation, such as sandbox deletion, from an actions menu or a command-palette panel request.
- **Evidence:** This host directly renders `PopoverContent` without a name and receives bare `ConfirmBody` or `FormBody` content, bypassing the named `ConfirmPopover`/`FormPopover` shell. Both new accessible-name regressions fail with an unnamed dialog.
- **Consequence:** Screen reader users enter a dialog without receiving the selected action or its target as its name.
- **Suggested fix:** Name the host from the registered action's accessible label, then its visible label, with the menu's target-specific label as a fallback.
- **Regression:** `actions-menu.test.tsx` asserts a named deletion dialog after both menu selection and a command-palette panel request.
- **Verification:** Both new cases failed before the fix; focused tests and the required checks are run before commit.
