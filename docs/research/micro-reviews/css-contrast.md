# CSS contrast and text visibility

## Pending toast steps

The pending step label painted `--muted-foreground` at 70% opacity on
`--popover`. The token-derived sRGB contrast test reproduced 2.89:1 in light
mode and 4.02:1 in dark mode. Remove the text opacity modifier; the step icon
and accessible status still distinguish pending work.

[WCAG 2.2 SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
requires 4.5:1 for this normal-sized text. The test derives luminance from
achromatic OKLCH tokens, composites encoded sRGB channels, then computes the
contrast ratio. See [CSS Color 4 conversion code](https://www.w3.org/TR/css-color-4/#color-conversion-code).

Regression: `src/components/theme-contrast.test.ts` reads the rendered pending
row's token and opacity and checks both theme surfaces against 4.5:1.

## Truncated file browser labels

The file tree truncated folder, file, symlink and sandbox labels without a title
or tooltip. The menu bar folder picker did the same for folders and its sandbox
heading. Add native titles to those labels, using `visibleText` for guest names
so titles preserve the existing hidden-character disclosure.

Regression: file-tree and status-folder-picker tests supply long names and
bidirectional control characters, then require complete sanitized titles.
Existing navigation and path tests continue to check the original guest paths.
