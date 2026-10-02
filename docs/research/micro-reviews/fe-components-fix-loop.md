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
