# Sandbox accessibility fixes

Scope: `app/SiloUI/src/features/sandboxes/`. Verification uses deterministic frontend fixtures; no app or VM was launched.

## Add menu keyboard navigation

- Trigger: focus Add and press ArrowDown, or try to navigate its items with arrow keys.
- Evidence: the regression `opens the Add menu with the keyboard and navigates its items` failed because ArrowDown did not open the menu. The component used Popover with plain buttons declaring menu roles.
- Consequence: the announced menu did not provide the keyboard interactions its role promises.
- Fix: use the existing Radix DropdownMenu primitive. Suppress trigger focus restoration only when a selection opens an editor or another dialog.
- Coverage: ArrowDown opens and navigates, Home/End move to the first/last item, Escape restores Add focus, and Enter opens the editor with focus on Sandbox name.
- Primary source: [Radix Dropdown Menu keyboard interactions and focus management](https://www.radix-ui.com/primitives/docs/components/dropdown-menu#keyboard-interactions).

The native import picker can return no archive (`computer-transfer.tsx`); that path opens no review. The cancellation regression caught focus remaining on the body after an Import menu selection. Suppress the menu's normal focus return only for inline editors. External actions retain Add as the return target, while their form popovers manage subsequent field focus.

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

The broader onboarding adapter test caught a regression from deferring all initial focus: direct Edit did not focus Sandbox name immediately. Preserve synchronous focus and use the next frame only to recover focus left on the body or a menu trigger by menu dismissal. The existing onboarding regression and row-menu regressions verify both paths.

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

## Focusable context uses roles that prohibit names

- Trigger: Tab to a computer badge or the read-only disk wrapper in an existing sandbox editor.
- Evidence: both semantic regressions failed to find the intended named note/group. Each tab stop was a generic span with aria-label, which the generic role prohibits. The disk wrapper also lacked a focus indicator.
- Consequence: the attempted names have no supported semantic mapping for assistive technology, and keyboard focus on read-only disk information is not visibly indicated.
- Fix: expose the computer badge as an ancillary note, matching SecretChangesLabel; use a named group for each disk value and a focus-visible ring.
- Coverage: keyboard access to the offline computer note and its tooltip; normal tab order through resource controls to the two named read-only groups with disabled selects.
- Primary sources: WAI-ARIA [generic role](https://www.w3.org/TR/wai-aria-1.2/#generic) and [note role](https://www.w3.org/TR/wai-aria-1.2/#note).

## Reorder handle omits its keyboard instructions

- Trigger: focus a sandbox's Reorder control with assistive technology.
- Evidence: the regression failed because its accessible description was empty. The handle only responds to Up/Down, with no visible text or associated instructions explaining that interaction.
- Consequence: a keyboard user encounters a button without knowing how to change the order.
- Fix: associate each handle with shared offscreen arrow-key instructions using a per-list id.
- Coverage: the described handle submits the expected reordered configuration, retains focus when the source publishes the new order, and updates the existing polite live announcement.

## List and row-control labels use unnamed generic containers

- Trigger: inspect a sandbox list or its grouped management/runtime actions with assistive technology.
- Evidence: both regressions failed to find the intended named groups. The list's aria-labelledby and the action containers' aria-label were applied to generic divs, which prohibit names.
- Consequence: existing contextual labels have no supported semantic mapping, so row controls are not exposed as the intended named collections.
- Fix: use the group role for the existing containers and a per-instance heading id for each list.
- Coverage: management and runtime buttons belong to the expected named groups; two list instances each associate their group with their own heading and retain their labeled ordered list.
- Primary source: [WAI-ARIA generic role](https://www.w3.org/TR/wai-aria-1.2/#generic) recommends group for named containers.

## Final verification

Node 24.11.1 was selected explicitly from its installed NVM directory. The final run passed 308 tests in 24 suites: all sandboxes tests, onboarding machine configuration, overview row navigation/menus/deletion, sandbox transfer, ActionsMenu, sandbox details, and computer use. The earlier default-shell runs used Node 26; the final supported-runtime run supersedes them.

- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm run lint -- src/features/sandboxes src/components/actions-menu.tsx` from `app/SiloUI`: passed.
- `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`: passed.
- `git diff --check`: passed.

Failing and passing logs are retained in the ignored `app/SiloUI/src-tauri/target/verification/` directory. These tests establish DOM semantics and focus against fixture data. No packaged bundle, live VM, production data, or manual screen-reader session was inspected.
