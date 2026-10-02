# Sandbox accessibility fixes

Scope: `app/SiloUI/src/features/sandboxes/`. Verification uses deterministic frontend fixtures; no app or VM was launched.

## Add menu keyboard navigation

- Trigger: focus Add and press ArrowDown, or try to navigate its items with arrow keys.
- Evidence: the regression `opens the Add menu with the keyboard and navigates its items` failed because ArrowDown did not open the menu. The component used Popover with plain buttons declaring menu roles.
- Consequence: the announced menu did not provide the keyboard interactions its role promises.
- Fix: use the existing Radix DropdownMenu primitive. Suppress trigger focus restoration only when a selection opens an editor or another dialog.
- Coverage: ArrowDown opens and navigates, Home/End move to the first/last item, Escape restores Add focus, and Enter opens the editor with focus on Sandbox name.
- Primary source: [Radix Dropdown Menu keyboard interactions and focus management](https://www.radix-ui.com/primitives/docs/components/dropdown-menu#keyboard-interactions).
