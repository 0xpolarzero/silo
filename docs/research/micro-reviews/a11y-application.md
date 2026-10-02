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
