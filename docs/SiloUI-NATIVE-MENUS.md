# Native macOS menus

Silo's native menus dispatch `silo://menu-command` to the main window. React
routes each request through existing navigation, forms and update controls.
Only the main window can publish command availability. Actions start disabled
until the listener is ready; installation disables navigation and mutation
commands. Individual busy states disable update checks and backup operations.
The status panel and Linux menus are unchanged.

Native macOS owns Command-B for the sidebar and Command-K for the command palette,
avoiding a second DOM shortcut
handler. Repeated creation requests preserve unfinished forms. Consumed sandbox
requests are cleared by their owner so returning to a remounted overview cannot
open another form. Sidebar text follows the existing collapse state.

Category shortcuts follow sidebar order: Command-1 Overview, 2 Files, 3 Logs,
4 Network, 5 Activity, 6 GitHub, 7 Secrets, 8 Backup. Linux desktop builds use
Control instead of Command and dispatch through the same guarded app actions.
The shared shortcut badge displays these bindings at the right of expanded
sidebar rows on hover/focus, or inside tooltips when collapsed. Existing toolbar
tooltips include their actual bindings; controls without a shortcut have no badge.

Documentation opens the bundled `docs/silo-help.html`, which covers the current
app rather than the legacy root README. Issues and release notes use fixed
project URLs. Standard Edit, Window and application commands use Tauri's native
predefined items. About reports the built app version.

## Verification

- Full frontend suite: 648 tests passed before the final draft-preservation
  refinements; the final 18 menu-request and 26 backup tests passed afterward.
- Two native action-availability tests passed. TypeScript and lint passed.
- Rebuilt using `npm run desktop:build:debug -- --config
  /private/tmp/silo-local-update-test-version.json`; the version-only override
  leaves the local app at 0.1.0 for the owner's update test. Production updater
  endpoint/key remain unchanged.
- Actual macOS menu clicks: Settings opened General; Check for Updates displayed
  progress then version 0.1.1 available; Create Backup opened sandbox selection;
  Restore Backup opened the archive picker, which was cancelled without restoring.
- Command-N opened the existing VM form, cancelled without creating a VM.
  Command-K opened and closed one palette. Hide Sidebar collapsed the existing
  sidebar and became Show Sidebar; the sidebar was restored.
- Command-comma is configured natively; the UI driver's comma chord did not
  activate it, so that particular physical-key interaction is not claimed tested.
- Documentation opened the bundled guide in the browser with its current-app
  content. Final bundle build and deep/strict signature verification passed.
- The normal app remains open. No release was installed during these menu tests.

Build logs: `/private/tmp/silo-native-menu-rebuild.log`.
Frontend log: `/private/tmp/silo-menu-frontend-tests.log`.
Native log: `/private/tmp/silo-app-menu-native-tests.log`.

## Primary references

- [Tauri native menus](https://v2.tauri.app/learn/window-menu/)
- [Apple menu conventions](https://developer.apple.com/design/human-interface-guidelines/menus)
- [Apple Settings menu](https://developer.apple.com/documentation/foundation/adding-a-settings-interface-to-your-app)

Shortcut badge verification (2026-09-11): the rebuilt macOS app showed the
GitHub badge at the right of its hovered expanded row and the Secrets badge
inside its collapsed tooltip. Command-6 opened GitHub; Command-B collapsed and
expanded the sidebar. Type checking, lint, focused navigation tests, and bundle
signature verification passed. Linux keyboard dispatch is covered by hook tests;
this check did not run a Linux desktop session.
