# Compact app rows

Use `ListCard`, `ListRow`, and `ListRowIcon` from `src/components/list-row.tsx`
for records and settings with a left icon, title, caption, and right action or
metadata. Use `ListRowDetails` for expanded review, progress, or result content.

Let titles and captions inherit their type size from `ListRow`: 13px medium
titles and 11px captions, both with 16px line height. The icon tile is 28px;
text buttons use `size="xs"`. Keep semantic headings, list roles, status
announcements, and useful truncation or wrapping at the call site. Badges,
timestamps, and progress percentages can use smaller metadata text.

When changing this pattern, inspect every consumer and its running, failure,
and expanded states. Avoid adding page-specific title or caption sizes.

## App surface audit

| Surface | Shared rows |
| --- | --- |
| Overview | VM and SSH records through `SandboxListRow`; configuration status uses the same icon tile. |
| Files | Repository records; push controls and feedback remain below the header. |
| Activity | Every event, including progress, success, warning, and failure. |
| GitHub | Connected, connecting, and disconnected account cards. |
| Secrets | Secret records, sandbox badges, and restart notices. |
| Backup | Create backup, restore archive, and recent archives; inline review and results use `ListRowDetails`. |
| General | Startup, polling, application preferences, and accessibility settings. |
| Notifications | Main toggle and alert categories. |
| System issue | Repair header and expanded details; ordered repair steps share the icon tile. |
| Status bar | Sandbox rows, status labels, secret-change tooltips, repair row, and inline lifecycle confirmation use the same app components. |

## Specialized layouts reviewed

Logs, Network, and GitHub repository permissions need aligned table columns.
The file tree needs hierarchy and indentation. Navigation and disclosure
headings are single-line controls. Configuration editors are forms. Empty
states are centered explanations. Inline operation feedback and temporary
repair notices remain compact status messages within their owning surface.
These do not need a two-line record card.

Onboarding uses the same compact account and application preference rows.

## Screen transitions

Keep transitions limited to their intended properties. Progress indicators animate
their transform; buttons and tabs use the standard visual transition properties.
Never include `all` or `visibility`: onboarding retains hidden panels to preserve
drafts, expanded details, and scroll positions. A descendant that animates inherited
visibility can remain painted after its panel is hidden, as described in
[MDN’s visibility interpolation](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/visibility#interpolation).

`src/test/transition-styles.test.ts` checks the compiled application CSS for this
rule, including shared components, variants, and custom styles.

## Tooltips

Use `restoreFocus` when dismissing a surface returns focus to its trigger.
The shared tooltip trigger suppresses only that synchronous focus event; later
hover and keyboard focus still open it. This uses
[Radix's focus handler](https://github.com/radix-ui/primitives/blob/main/packages/react/tooltip/src/tooltip.tsx),
which skips opening when the supplied handler prevents the event's default.

Pass the surface's reduced-motion preference to its outer `TooltipProvider`.
Nested providers inherit it, and tooltip content receives it through
[React context across portals](https://react.dev/reference/react-dom/createPortal).
Tooltips disable entry and exit animations for either the app preference or
the system's `prefers-reduced-motion` setting.

## Status bar preview

Open `?view=status-bar` or choose **status-bar** in the development View selector.
State and System fixtures use the app's existing snapshots. The Preview selector
adds stale status, an empty list, and a long list. Repair and error notices and
the footer remain visible while only the sandbox list scrolls.

Repositories with outgoing commits add one compact line under their sandbox,
with the repository name and a **Push N commits** action. Progress and the brief
success message reuse the Files page's push feedback. Failures remain pinned
above the list with Details and Retry. Push actions require a fresh, running
sandbox; the preview simulates completion and carries updated counts into Silo.

The menu bar keeps the Silo mark in every state. Loading adds a corner spinner;
errors use red and a circled alert; warnings use amber and a triangle. An empty
or stopped list uses a muted mark. Errors take precedence over warnings and
loading, and the spinner respects reduced motion.

On macOS, native tray images use template rendering in every state so AppKit
keeps them readable against the menu bar. Each image replacement uses
[Tauri’s atomic image-and-template update](https://docs.rs/tauri/2.11.5/tauri/tray/struct.TrayIcon.html#method.set_icon_with_as_template);
the plain image setter clears template rendering, and restoring it in a separate
call introduces a redraw flash.

The status panel presents aggregate health,
one runtime-repair action, sandbox shortcuts and overflow actions, folder and site
selection, Open Silo, and Quit. TypeScript components and tokens own the design.
Freshness, busy state, and repair state gate quick actions. Repair appears once
above the list. The editor picker browses sandbox folders, not host folders.

Browser fixtures simulate lifecycle progress and host handoffs. In the desktop
app, Rust commands perform terminal, editor, site, and Quit actions. Open Silo
opens the main window and carries the selected sandbox.
