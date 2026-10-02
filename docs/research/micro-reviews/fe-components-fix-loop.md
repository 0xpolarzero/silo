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
