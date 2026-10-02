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
