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
