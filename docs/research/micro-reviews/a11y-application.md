# Application accessibility fixes

## Filter suggestions entered the Tab sequence

Trigger: focus a shared filter input at the end of the page, then press Tab.
The input retained an `aria-activedescendant` model, but each option was also a
native tabbable button. Focus moved into the first option instead of leaving the
filter. Arrow-key handlers then no longer received keyboard events.

The [WAI-ARIA combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
excludes popup descendants from the Tab sequence and keeps DOM focus in the input
while navigating listbox suggestions. The fix sets option `tabIndex` to `-1`,
preserving pointer selection and input arrow/Enter navigation.

Verification: `filter-combobox.test.tsx` reproduces Tab entering the first option
before the fix and leaving the filter after it. Existing navigation and scrolling
tests remain green. This uses deterministic DOM fixtures, not a native app or
screen reader session.

## Diagnostic output had no keyboard focus target

Trigger: expand long technical details or setup activity, then Tab past Copy.
The height-limited `pre` scroll container was skipped. Browsers that do not focus
scroll containers automatically offered no keyboard target for scrolling it.

[MDN's overflow accessibility guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow#accessibility)
specifies a focusable scroll container with a role and accessible name. The fix
adds `tabIndex={0}`, a named region (defaulting to the disclosure title), and an
inset focus indicator. Native scrolling keys remain browser-managed.

Verification: both named and default-label cases in `log-disclosure.test.tsx`
failed because Tab skipped the output before the fix. They now reach the named
region after Copy. DOM fixtures verify focus access, not native scroll distances.

## Closing computer connection setup lost focus

Trigger: open Connect computer in Settings, then Cancel or connect successfully.
The focused form unmounted and its opening button remounted without receiving
focus. Both paths left focus on `document.body`, losing the keyboard position.

The fix restores focus to the remounted button after the form closes, using the
existing `restoreFocus` helper and the same post-render approach as secret editing.
This follows [WCAG's focus-order guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
to preserve a meaningful keyboard sequence as content changes.

Verification: both user-event tests in `remote-computers-settings.test.tsx`
failed before the fix, then returned focus to Connect computer afterwards.
The connection backend is a deterministic resolved mock; no SSH session is opened.

## Import validation changed the name field's label

Trigger: review an import with an invalid or already-used sandbox name. Error
text nested inside the label changed the input's accessible name to include the
whole error. Duplicate-name errors also lacked an associated description.

The fix keeps a separate explicit label and connects either error through
`aria-describedby`, following [WAI-ARIA's error-identification technique](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA21).
Import eligibility and validation messages remain unchanged.

Verification: both format-error and duplicate-name fixtures in
`import-popover.test.tsx` failed the stable-name assertion before the fix. They
now verify the exact label, error description, invalid state, and disabled Import.

## Dismissing native Quit confirmation lost keyboard position

Trigger: while an input is focused, receive a native Quit request and dismiss the
confirmation with Cancel or Escape. Radix's default restoration targets a dialog
trigger, but this native-event dialog has none. Focus ended on the page body.

The fix captures the focused element before opening and restores it through the
supported close-autofocus callback. This follows the dialog dismissal example in
[WCAG focus-order guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html).
The existing Quit decision and initial focus behavior are preserved.

Verification: both dismissal regressions in `quit-request-confirmation.test.tsx`
failed before the fix. They now restore the search field and still resolve the
mocked Quit request to false. No native Quit or VM shutdown is exercised.

## Personal-token editing did not manage keyboard position

Trigger: open Add token, then Cancel or complete a successful connection. Opening
left focus on Add token rather than the password field; closing removed the
focused form control and left focus on the page body.

The fix focuses the field on mount and restores the opening control after the
editor closes and the pending operation settles. It uses the same existing
focus helper and post-render restoration pattern as secret editing, consistent
with [WCAG focus-order guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html).
Credential clearing and retry behavior remain unchanged.

Verification: both new cases in `personal-token-connection.test.tsx` failed on
opening focus, then failed on return focus after adding field autofocus alone.
The complete fix passes both paths against synthetic token data and a mock save.

## Repository keyboard navigation did not reveal the active option

Trigger: open a repository catalog longer than its height-limited popup and
navigate down with arrow keys. The input's active descendant changed but no
scroll action revealed it, including the authorization action below the results.

The fix reveals the active button with native nearest-edge scrolling while
keeping DOM focus on the input, matching the established shared filter behavior
and [WAI-ARIA combobox keyboard guidance](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
Selection identity and callback behavior remain unchanged.

Verification: the new `github-access-editor.test.tsx` regression first failed
because no scroll call targeted repository 20. It now checks both directions,
the final authorization action, input focus, and Enter dispatch. This DOM fixture
verifies the native scrolling request, not rendered pixel distances.
