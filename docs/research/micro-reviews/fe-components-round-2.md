# Frontend component second fix loop

Scope: `app/SiloUI/src/components/` and adjacent frontend modules. Findings use deterministic fixtures in the isolated `codex/fix-fe-components` worktree. Node 24.11.1; no native application or VM launches.

## FE-COMPONENTS-9 — P2 — Outside dismissal steals focus from the clicked control

- **File:line at discovery:** `app/SiloUI/src/components/confirm-popover.tsx:96–104` and `app/SiloUI/src/components/actions-menu.tsx:75`.
- **Trigger:** Open an externally anchored form or an actions-menu confirmation, then click another page button.
- **Evidence:** Both close-autofocus overrides restore the opener unconditionally. The two new regressions dismiss the popover through an outside button and fail because focus moves to Add or More actions instead of remaining on the clicked button.
- **Consequence:** The next keyboard action targets the opener instead of the control the user just selected.
- **Fix:** Track outside interaction with Radix's supported `onInteractOutside` callback, restoring the opener only for dismissal within the popover. Reset that tracking when the content opens.
- **Tests:** `confirm-popover.test.tsx` and `actions-menu.test.tsx` verify outside focus; existing Escape and Cancel tests retain opener restoration.
- **Primary evidence:** Installed Radix `PopoverContentNonModal` restores its trigger only when `hasInteractedOutsideRef` is false, in `node_modules/@radix-ui/react-popover/dist/index.js:224–233`. Silo's custom external-anchor overrides now follow that policy.
