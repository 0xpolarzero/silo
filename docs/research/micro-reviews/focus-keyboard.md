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

## Command confirmation returns focus to search

Confirmed with a single command that requires confirmation. Enter opens its
question; Escape or Cancel returns to the list but leaves focus on the dialog
container, so typing no longer searches. Both dismissal regression cases failed
before the fix. The saved failing output is
`app/SiloUI/src-tauri/target/verification/focus-keyboard/command-menu-before.log`.

The search input now focuses when mounted, including when it replaces the
confirmation panel. No focus trap is reimplemented. The tests cancel through
both paths, type another search, close the palette, and verify focus returns
to its trigger without running the command.

Checks: both new dismissal tests, eight native-menu request tests, and seven
palette integration tests passed. The shared machine's load exceeded 170 during
verification; the integration tests initially timed out at five seconds and
passed with a 30-second command-line timeout. Frontend typecheck, touched-file
oxlint, Rust formatting, and diff whitespace checks passed.

## Native Quit cancellation restores the previous control

The Quit dialog opens through a native request, without an `AlertDialog.Trigger`.
Both new regressions first focus a workspace control, receive a fixture Quit
request, then dismiss with Escape or Cancel. Tab and Shift+Tab remain inside the
dialog, but dismissal left focus on `body`. Both cases failed before the fix;
output is saved in
`app/SiloUI/src-tauri/target/verification/focus-keyboard/quit-before.log`.

The [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
specifies restoring the invoking element when it still exists. The dialog now
records the focused control before moving focus inside and restores it using
Radix's close autofocus callback and Silo's existing `restoreFocus` helper.
The native request fixture verifies cancellation replies as well as focus;
no real Quit request, app shutdown, or VM operation was exercised.

Checks: all six Quit confirmation tests passed, including the existing
main-window integration fixture. Frontend typecheck, touched-file oxlint,
Rust formatting, and diff whitespace checks passed.

## Import checking and rejection focus an available action

The shared form popover always cancelled Radix's opening autofocus, even when
there was no form field to focus. Checking and invalid import reviews have no
fields, so focus stayed on the Add anchor instead of entering the popover.
Both state regressions failed before the fix; output is saved in
`app/SiloUI/src-tauri/target/verification/focus-keyboard/import-before.log`.

The shell now defers to Radix's default autofocus when no preferred field or
confirmation control exists. Checking focuses Cancel; a rejected export focuses
Choose another file. The tests use Enter to activate these controls, then verify
dismissal restores Add and no import starts. Field and confirmation autofocus
still use the existing explicit targets. This uses the supported autofocus
callbacks documented in the Radix source linked above.

Checks: all 44 import, shared-popover, and sandbox-transfer tests passed.
Frontend typecheck, touched-file oxlint, Rust formatting, and diff whitespace
checks passed.

## Escape dismisses operation cancellation questions

Integration already fixed focus restoration after Keep going, recorded in
`fe-components-fix-loop.md`; that instance was skipped. A separate missing
Escape handler remained: pressing Escape while focused in the cancellation
question left it open. The new regression failed because the Confirm cancel
group remained rendered. Output is saved in
`app/SiloUI/src-tauri/target/verification/focus-keyboard/toast-before.log`.

The question now consumes Escape locally and returns to progress through the
existing Keep going state transition and focus restoration. It respects handled
and composition events. The regression verifies Cancel regains focus, the
operation continues, and Enter can reopen the question and activate cancellation.

Checks: all 21 operation-toast body and toast integration tests passed.
Frontend typecheck, touched-file oxlint, Rust formatting, and diff whitespace
checks passed.
