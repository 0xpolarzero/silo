# Keyboard focus fixes

## Log date editor restores its opener

Confirmed on 2026-10-02 with deterministic React fixtures. Opening an existing
date filter and pressing Escape removed the dialog but left focus on `body`.
`log-filters.test.tsx` failed its final `toHaveFocus()` assertion before the fix.
The date editor uses a `Popover.Anchor` around several controls, without a
`Popover.Trigger`, so Radix cannot restore a trigger automatically.

[Radix Popover documentation](https://www.radix-ui.com/primitives/docs/components/popover)
distinguishes the positioning anchor from the trigger and exposes
`onOpenAutoFocus`, `onCloseAutoFocus`, and `onInteractOutside`. The installed
`@radix-ui/react-popover` implementation restores `context.triggerRef` only
when no outside interaction occurred. The editor now records its opener and
uses these supported callbacks to follow the same rule. Returning to the
filter input uses Silo's existing focus-restoration marker to avoid opening a
new suggestions popup.

Regression fixtures cover Escape, Cancel, preset application, cancelling a new
date filter selected with Enter, and clicking a separate outside control.
These tests establish DOM focus behavior against fixture data; no packaged app,
live VM, or screen-reader session was exercised.

Checks: all five new fixtures and both existing combobox tests passed; frontend
typecheck, touched-file oxlint, and Rust formatting checks passed. The broader
logs-page suite passed 24 of 25 tests. Its export-retry toast assertion also
failed with both production files restored to HEAD, establishing an unrelated
baseline failure. Baseline output is kept in the ignored
`app/SiloUI/src-tauri/target/verification/focus-keyboard/logs-baseline.log`.

An initial combobox Tab-navigation hypothesis was rejected: forward and
backward Tab already dismiss the popup and reach adjacent page controls.
[WAI-ARIA's combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
keeps DOM focus in the input during arrow navigation; the existing implementation
and regression suite already preserve that behavior.
