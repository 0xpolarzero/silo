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

## Unbroken tooltip text

Compile the shared tooltip's class string with the installed Tailwind compiler,
then render a 400-character unbroken name in a browser fixture. Before the fix,
the tooltip had a 224 px client width and a 2,527 px scroll width at an 800 px
viewport. The page grew to 2,567 px. This reproduces long file paths and names
extending past the tooltip background.

Use `overflow-wrap: anywhere` on the shared tooltip, and allow its label to
shrink in the shortcut flex row. The
[CSS Text specification](https://www.w3.org/TR/css-text-3/#overflow-wrap-property)
defines emergency breaks and their contribution to intrinsic sizing for this
value. After compiling the changed classes, both plain and shortcut tooltip
fixtures have 224 px client and scroll widths; all 400 characters remain visible.

Verification used static HTML fixtures in Chromium through Playwright, not a
native bundle or live sandbox. Local evidence: `/tmp/silo-css-tooltip-before.html`
and `/tmp/silo-css-tooltip-after.html`. No class-string unit assertion was added:
the browser's measured text overflow is the relevant check.

## Shared truncated string labels

`ListRow`, `DisclosureHeader`, and `StatusBadge` truncate text but did not expose
complete string labels on hover. Add native titles at the shared rendering seam
for string details, headings, captions, and badge labels. React element content
retains its existing rendering and caller-owned tooltip behavior.

Regression: long string fixtures in `list-row.test.tsx`,
`disclosure-header.test.tsx`, and `status-badge.test.tsx` failed for missing titles
before the fix. Existing row action and disclosure keyboard tests still pass.

## Secret restart notice

The 10 px "Restart to apply" text used `amber-600` in light mode. The regression
renders `SecretsPage` with a restart-required secret, reads the actual notice
class and installed Tailwind palette, and reproduces 3.19:1 on white. Change the
light class to the existing warning-text shade `amber-700`; retain `amber-400`
in dark mode. Both shades now pass AA on every neutral theme surface.

## Operation checklist labels

The current-step line already exposed its full text through a title, but the
checklist below it truncated each label without one. Add titles to checklist
labels in all four states. The regression renders long completed, current,
pending, and failed steps through the real toast and requires each full title.

## Computer settings row overflow

The connection row's `min-w-0` content container could shrink, but its address
paragraph did not break an unbroken SSH account or hostname. A static Chromium
fixture compiled from the row's actual Tailwind classes reproduced 1,352 px
of scroll width in a 280 px row (158 px text column) using a 200-character
account name. Add inherited `overflow-wrap: anywhere` to connection and
download-status text containers. The same fixture now measures 280 px for
both row client and scroll widths, and 158 px for both text-column widths.

Both settings lists also truncate computer names without titles. Add complete
name titles; two DOM tests failed before the change and now require the names
to remain discoverable. The download-status test awaits its asynchronous read
before checking the name, so it does not leave a pending React update.

Browser evidence is in `/tmp/silo-css-computer-before.html` and
`/tmp/silo-css-computer-after.html`. These are deterministic static fixtures;
no remote connections, native app, or real sandbox data were used.

## Selected filter labels

Selected sandbox filter chips use `truncate` but did not expose the full label
after closing the option list. Add a title to the shared chip label. The
regression selects a long name with Enter and requires the complete title while
retaining the independently named Remove button. Existing Tab and arrow-key
navigation tests still pass.

## Closing verification

Node 24.21.0: 105 tests passed across the ten affected suites (theme contrast,
operation toast, file tree, status folder picker, disclosure header, list row,
status badge, secrets page, computer settings, and filter combobox).
`tsc -b --pretty false`, focused `oxlint` on all touched TypeScript files, and
`git diff --check` passed. The tooltip's existing reduced-motion and breadcrumb
suites also passed (six tests). Each user-visible fix includes a patch changeset.

No native bundle was built or inspected. All UI data was deterministic fixture
data; browser geometry checks used compiled static HTML.
