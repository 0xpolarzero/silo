# Sandbox accessibility fixes

Scope: `app/SiloUI/src/features/sandboxes/`. Verification uses deterministic frontend fixtures; no app or VM was launched.

## Add menu keyboard navigation

- Trigger: focus Add and press ArrowDown, or try to navigate its items with arrow keys.
- Evidence: the regression `opens the Add menu with the keyboard and navigates its items` failed because ArrowDown did not open the menu. The component used Popover with plain buttons declaring menu roles.
- Consequence: the announced menu did not provide the keyboard interactions its role promises.
- Fix: use the existing Radix DropdownMenu primitive. Suppress trigger focus restoration only when a selection opens an editor or another dialog.
- Coverage: ArrowDown opens and navigates, Home/End move to the first/last item, Escape restores Add focus, and Enter opens the editor with focus on Sandbox name.
- Primary source: [Radix Dropdown Menu keyboard interactions and focus management](https://www.radix-ui.com/primitives/docs/components/dropdown-menu#keyboard-interactions).

## Closing an inline editor loses focus

- Trigger: open a new sandbox or an existing row's editor, then Cancel or finish Save.
- Evidence: three regression cases failed because removing the focused Cancel button left focus on `document.body`.
- Consequence: the next Tab starts from the document instead of the sandbox the user was editing.
- Fix: retain refs to Add and each row's edit/menu control. When an editor closes with focus lost to the body, restore focus to the recreated source row control, falling back to Add for a new or deleted sandbox.
- Coverage: cancellation from Add, Edit, the row menu, and Duplicate; successful asynchronous save; preserve focus when another control already received it.

## Duplicate menu dismissal steals editor focus

- Trigger: select Duplicate settings from a sandbox row's More actions menu.
- Evidence: the new Duplicate regression failed because focus returned to the row menu instead of Sandbox name. The paired Edit regression passed. Unlike Edit, Duplicate keeps the source row and its menu trigger mounted.
- Cause: the editor focused its first field synchronously, before Radix FocusScope's deferred unmount restoration (`@radix-ui/react-focus-scope/dist/index.mjs`, installed dependency).
- Fix: schedule the initial editor focus for the next animation frame, with cancellation on unmount, matching the existing form-popover pattern.
- Coverage: both row-menu Edit and Duplicate end with focus on Sandbox name.

## Saving progress has no live announcement

- Trigger: Save settings while the native commit remains pending.
- Evidence: the waiting-state regression failed because there was no status region. Only the disabled Save button changed its text to Saving….
- Consequence: screen readers have no live status message for the pending save while editing controls are unavailable.
- Fix: keep an initially empty polite status region mounted and update it with the sandbox name while saving.
- Coverage: the real MachineList commit path with an unresolved synthetic promise exposes Saving and locks its fields.
- Primary source: [W3C status messages guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html), including waiting states and non-displayed contextual text.

## Row-menu deletion confirmation lacks accessible context

- Trigger: open Delete from a sandbox row's More actions menu.
- Evidence: the regression failed to find the confirmation dialog by name. Fixing only its name then failed the destructive button's accessible-description assertion.
- Consequence: the dialog was unnamed, and its initially focused Delete permanently button did not programmatically describe which sandbox and data would be deleted.
- Fix: have the shared ActionsMenu host name registered popovers from the selected action's accessible label. Link both destructive choices in DeleteSandboxBody to its existing target title and loss warning using unique ids.
- Coverage: local deletion; remote computer identity and checkpoint count; both Delete permanently and Export, then delete descriptions.
- Primary source: [WAI-ARIA dialog role](https://www.w3.org/TR/wai-aria-1.2/#dialog) requires an accessible name.
