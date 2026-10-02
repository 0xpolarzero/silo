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

## Destructive text and button tints

The destructive button uses the destructive token as text over a translucent
fill of the same token. Its light default state on the page background measured
3.99:1 and its dark hover state measured 4.36:1. On the muted surface, the old
token also measured only 4.37:1 without a tint in light mode, and 3.28:1 over
the dark hover tint.

Darken the light destructive token and lighten the dark token, with lower
chroma to stay within sRGB. Use 10%/20% fills in both themes. The regression
reads the button variant's actual default and hover alpha values and checks
error text and both button states on every neutral surface. The worst resulting
pair is 4.65:1 in light mode and 4.81:1 in dark mode.

The chromatic test uses the public-domain inverse transform from
[OKLab's author](https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab)
and WCAG's sRGB luminance weights. This is a deterministic token check, not a
packaged-app visual audit.
