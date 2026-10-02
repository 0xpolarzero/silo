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

## FE-COMPONENTS-10 — P2 — IME candidate keys change filter selection

- **File:line at discovery:** `app/SiloUI/src/components/filter-combobox.tsx:113–132,145–148`.
- **Trigger:** Use Arrow keys, Enter, or Escape during an input-method composition in a sandbox, workspace, or log filter.
- **Evidence:** Four composing-key fixtures fail: Arrow and Enter events are consumed as combobox commands, and Escape removes the active descendant and closes the results.
- **Consequence:** Choosing an IME candidate can select a sandbox filter instead, clear the query, or dismiss its results.
- **Fix:** Ignore composing input key events and retain the popup during composing Escape. The Radix Escape callback still prevents its default dismissal.
- **Tests:** Four composing-key cases preserve the active option and selections, then exercise ordinary ArrowDown and Enter after composition.
- **Primary evidence:** The [UI Events specification](https://w3c.github.io/uievents/#dom-keyboardevent-iscomposing) defines `isComposing` for keyboard events during a composition session. Installed Radix `DismissableLayer` invokes `onEscapeKeyDown` before its default dismissal (`node_modules/@radix-ui/react-dismissable-layer/dist/index.js:130–140`).

## FE-COMPONENTS-11 — P2 — Checked checkbox colors never match the control

- **File:line at discovery:** `app/SiloUI/src/components/ui/checkbox.tsx:17`.
- **Trigger:** Check Apply Git identity, repository permissions, Linux desktop, or Allow any HTTPS destination.
- **Evidence:** The wrapper's `data-checked:*` utilities compile to `[data-checked]` selectors, but Radix emits `data-state="checked"`. A stylesheet-backed toggle regression fails with a transparent background instead of the primary background.
- **Consequence:** The checked background, border, and contrasting checkmark colors do not appear, weakening the visible selected state.
- **Fix:** Target Radix's `data-state="checked"` in the shared Tailwind state utilities, including dark and grouped focus variants.
- **Tests:** Compile the real control's classes with the installed Tailwind compiler; check computed background and foreground after toggling, then verify the selected background clears when unchecked.
- **Primary evidence:** Installed Radix checkbox root emits `data-state` through `getState(checked)` at `node_modules/@radix-ui/react-checkbox/dist/index.js:155`; it emits no `data-checked` attribute.

## FE-COMPONENTS-12 — P2 — Scrollbar orientation styles never match

- **File:line at discovery:** `app/SiloUI/src/components/ui/scroll-area.tsx:42`.
- **Trigger:** Overflow a sandbox list, file panel, or GitHub access editor; display its shared scrollbar.
- **Evidence:** `data-horizontal:*` and `data-vertical:*` utilities require boolean attributes absent from Radix's `data-orientation` controls. Both compiled-stylesheet fixtures fail with `auto` thickness instead of 0.625rem.
- **Consequence:** The custom scrollbar lacks its intended thickness and horizontal thumb layout while Radix hides the native scrollbar.
- **Fix:** Target `data-orientation="horizontal"` and `data-orientation="vertical"` with Tailwind arbitrary data variants.
- **Tests:** Real Radix scrollbars in both orientations, with compiled wrapper classes, require the specified thickness and horizontal column layout.
- **Primary evidence:** Installed Radix `ScrollAreaScrollbarX` and `ScrollAreaScrollbarY` emit `data-orientation` at `node_modules/@radix-ui/react-scroll-area/dist/index.js:404,454`; the viewport stylesheet hides native scrollbars at line 181.

## FE-COMPONENTS-13 — P2 — Composing Escape dismisses an inline confirmation

- **File:line at discovery:** `app/SiloUI/src/components/inline-confirmation.tsx:41`.
- **Trigger:** Press Escape during IME composition while an inline confirmation is active. Machine editor fields remain enabled while its Stop and save confirmation is shown.
- **Evidence:** The composing-Escape fixture removes the confirmation immediately instead of retaining it.
- **Consequence:** Cancelling a text candidate also cancels the pending confirmation and can restore focus away from the field being edited.
- **Fix:** Ignore composing Escape while retaining the integrated capture-phase/default-prevention behavior for ordinary Escape.
- **Tests:** Composing Escape retains the confirmation; ordinary Escape and outside presses still dismiss it. Status-panel tests preserve the two-Escape quit/panel sequence.
- **Primary evidence:** Composition follows the [UI Events keyboard contract](https://w3c.github.io/uievents/#dom-keyboardevent-iscomposing).

## Deferred — Popup and inline-confirmation Escape ordering

The integrated `d7f7da17` moved inline Escape handling to document capture so cancelling the status panel's quit confirmation does not also hide the panel. A fixture that keyboard-opens a separate Radix popup while an inline confirmation remains active now reproduces the reverse ordering problem: inline capture prevents Escape before Radix can close the popup. The red evidence is `/tmp/silo-fe-components-13-red.log`. Simply moving back to document bubble reintroduces the integrated status-panel defect; resolving ownership needs a coordinated dismissal boundary, outside this minimal fix. No skipped test was committed.
