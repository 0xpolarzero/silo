# SiloUI settings persistence

SiloUI saves preferences and unfinished onboarding input. Layout, navigation,
and existing Save/Cancel/Finish actions stay unchanged. The approved application
menus now show installed choices, their icons, `System default`, and a native
`Choose…` action.
The integrations configured by these preferences remain outside this piece.
Swift code and Swift saved values are untouched.

## Installed application choices

The Terminal, Code editor, and Browser menus use installed applications in the
native app. Their existing layout stays the same. Each menu adds `Choose…`, which
opens a native file picker at `/Applications` on macOS or `/usr/share/applications`
on Linux. Cancel leaves the selection unchanged. Choosing an application does
not launch it or implement the sandbox handoff it will eventually configure.

On macOS, [NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace)
provides application handlers and default associations. Known terminal IDs keep
source editors out of the terminal list. Known editor IDs supplement registered
source-code handlers; other editors must declare source-editing support, so
generic viewers and media handlers are excluded. Known browser IDs exclude
chat apps, download managers, terminals, and VM helpers that also register HTTPS.
Other browsers remain available through `Choose…`. Private empty `.command`,
`.swift`, and `.rs` files supply existing URLs for the handler queries and are
deleted automatically. The newer enumeration API is guarded; older macOS uses
default handlers and known installed apps without raising the deployment target.
Every result must be an existing application bundle with
an executable. On Linux, [GIO desktop entries](https://docs.gtk.org/gio-unix/class.DesktopAppInfo.html)
provide categories, visibility, executable checks, and browser/editor defaults.
Browser suggestions require the `WebBrowser` category; handling HTTP or HTTPS
alone does not make an application a browser.
The [Desktop Entry specification](https://specifications.freedesktop.org/desktop-entry/latest/recognized-keys.html)
defines `TryExec`, `Exec`, `Categories`, `Hidden`, and `NoDisplay` behavior.

Icons appear beside application names in menu options and selected values, at
16 CSS pixels inside the existing controls. macOS reads the native
[NSWorkspace icon](https://developer.apple.com/documentation/appkit/nsworkspace/icon(forfile:))
and renders a bounded 64×64 PNG on the discovery worker. Linux resolves the
desktop entry's icon through the current
[GTK icon theme](https://docs.gtk.org/gtk3/method.IconTheme.lookup_by_gicon.html)
on the GTK main thread, then decodes and scales it to a 32px PNG with
[GdkPixbuf](https://docs.gtk.org/gdk-pixbuf/ctor.Pixbuf.new_from_stream_at_scale.html).
Missing or unreadable icons use a category symbol. Icons are decorative, never
saved in settings, and never loaded from the host for fixtures.

Lists refresh when a menu opens and when the main window regains focus. An
explicit custom choice joins its selected category while it remains available.
macOS accepts executable `.app` bundles; Linux accepts valid `.desktop` entries
and executable files, including AppImages. A removed saved application stays
saved and appears as a disabled `unavailable` selection.

Each menu starts with `System default (app name)` and the current default's icon.
The selected control shows `app name (default)` to keep the name visible in the
existing width. Application menus fit their labels within the available screen
width. If no default is reported, that option says `System default
(not set)` and is disabled. Both platforms include a valid current browser
default even when it is outside the suggested categories or curated list;
merely registering HTTPS does not add other helper apps. Linux has no standard
terminal-default association in GIO.

The existing `terminal`, `editor`, and `browser` labels remain readable. New
`terminalPath`, `editorPath`, and `browserPath` fields save the selected location
alongside its label in the same atomic settings change. Missing/null paths mean
an older label-only choice. Bundle filenames also match legacy names such as
`iTerm` versus bundle metadata `iTerm2`; loading never rewrites a saved choice.
Discovered defaults apply only when the corresponding setting is absent, and
retain exact paths so identical application names do not select another copy.
The boolean fields `terminalUseSystemDefault`, `editorUseSystemDefault`, and
`browserUseSystemDefault` record whether to follow those defaults. A saved label
or path without the flag remains an explicit choice. With neither a saved choice
nor a flag, the control follows the system. Switching to system mode saves only
the flag and retains the old label/path; resolved labels and paths follow the
current catalog in both windows. Selecting an app saves its label/path together
with a false flag. Refreshing discovery never writes settings.

Browser and explicit native fixtures use a fixed catalog and disable the native
picker. Native fixture storage is checked before consulting host applications or
opening a dialog. Both native windows can read the catalog to resolve the same
installed defaults; only the main window can open the application picker.
The picker uses the official [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/)
behind those commands; the frontend receives no general filesystem permission.

### Application-choice verification

Completed on macOS arm64, 2026-09-07. `npm test` plus focused reruns passed all
335 frontend tests; `npm run typecheck`, `npm run lint`,
`cargo test --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml` (33 tests),
and `npm run desktop:build -- --debug --bundles app` passed. The desktop build
retains Vite's existing chunk-size advisory. Focused tests cover category
filtering, available/custom paths, legacy labels, cancellation, icon conversion,
unavailable apps, default-mode persistence, and both windows following changed
defaults without writes. Linux classifier checks passed using an extracted
Rust test harness; full Linux GIO/GTK compilation, icon tests, and GUI checks
remain unverified on this Mac.

Native checks used the bundled `Silo Preview.app` with an isolated
`SILO_SETTINGS_DIR`, without an explicit fixture selector. Accessibility and
screenshots confirmed:

- Terminal choices: `System default (Terminal)`, Ghostty, iTerm2, Terminal, Warp,
  and `Choose…`, with native icons.
- Code editor choices: Cursor, Xcode, and Zed with their icons. Browser choices:
  Arc, Brave Browser, Dia, Google Chrome, Safari, Tor Browser, and Zen. Chat,
  terminal, download, and VM helper apps were absent from browser suggestions.
- `Choose…` opened the `open-panel` sheet with `Where: Applications` and title
  `Choose a terminal`. Selecting `/Applications/Ghostty.app` updated the Terminal
  control and icon; the label and exact path were present in JSON before Finish.
- Choosing Cursor from the editor menu saved its label/path. Both Ghostty and
  Cursor survived Quit and relaunch during unfinished onboarding.
- Selecting `System default (Terminal)` displayed `Terminal (default)` and
  saved `terminalUseSystemDefault: true` while retaining Ghostty's saved
  label/path. After another Quit/relaunch, Terminal remained in default mode,
  Cursor remained explicit, and the untouched Browser showed `Zen (default)`.
- Reopening `Choose…` and pressing `Cancel` retained default mode. The final
  menu displayed the full system-default name. The closed control dimensions
  and surrounding onboarding layout remained unchanged.

The final test instance quit through `Quit Silo Preview`; a process check found
no remaining Silo instance. Native stdout/stderr logs were empty. Local logs and
the isolated settings snapshot are under the ignored
`app/SiloUI/src-tauri/target/applications-verification/` directory. No host default
associations or production settings were changed. Native status-panel visuals
were not reverified; shared default resolution is covered by main/status tests.
Workspace and integration states remain deterministic scaffold values.

To repeat the focused UI check, build and launch with a fresh isolated settings
directory as described below, then open Dependencies > Applications. Inspect all
three lists and icons, choose and cancel a native application, select a named
app, quit before Finish, and relaunch using the same directory. Switch to System
default and repeat; confirm the current default name and retained explicit
choice in the JSON. On Linux, also exercise `.desktop`, executable, and AppImage
choices, GTK theme icons, and the disabled default option where no association
exists.

## Saved values

| JSON field | Existing control | Default when absent |
| --- | --- | --- |
| `theme` | Theme | System |
| `launchAtLogin` | Launch Silo at login | On |
| `startWorkspacesAtLaunch` | Start sandboxes at launch | Off |
| `startupWorkspaceIds` | Startup sandboxes | Existing initial `dev` selection, otherwise first sandbox |
| `terminal` | Terminal | Terminal |
| `editor` | Code editor | Visual Studio Code |
| `browser` | Browser | Safari |
| `reduceMotion` | Reduce motion | Off |
| `notificationsEnabled` | Enable notifications | On |
| `notifyHealth` | Sandbox health | On |
| `notifyActions` | Action failures | On |
| `notifyBackup` | Backup failures | On |

Defaults are applied in TypeScript and are not written on mount. The startup
default follows the current sandbox list until the user saves a selection. An explicit
`false` or empty startup selection overrides its default. Startup selections use
stable machine IDs; temporarily missing machines do not delete saved IDs.
The existing valid `silo-theme` browser value is imported only when the native
document lacks a theme, and its original key is retained.

The document is `settings.json` under Tauri's `app_config_dir`, using the
unchanged application identifier `org.silo.preview`. This resolves to
`~/Library/Application Support/org.silo.preview` on macOS and
`$XDG_CONFIG_HOME/org.silo.preview` (normally `~/.config/org.silo.preview`) on
Linux. See the official [Tauri path reference](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html#method.app_config_dir).

```json
{
  "schemaVersion": 1,
  "settings": {},
  "onboardingDraft": null
}
```

`settings` contains explicit changes, not a complete default snapshot.
Unknown document and preference fields survive later writes. Revision numbers
and save errors belong to the running session and are not written to disk.

An onboarding draft contains the current step, saved machine configurations,
unfinished machine editor, repository selections and push choices, and Git
identity input. Edits save immediately, including incomplete text. Application
choices use shared preferences. Save still validates configuration; Cancel
discards the current editor draft; successful completion clears recovery data.
Drafts never claim that installation, authentication, or integration work has
completed. Credentials and operation results are not accepted draft fields.

## Shared state and failures

The main window initializes native storage before rendering. It selects fixture
mode before Rust opens any settings file. Status reads wait for initialization
on a worker thread. Changing fixture mode requires a full app relaunch.

One Rust mutex serializes individual preference patches and complete onboarding
draft updates. Both windows subscribe before reading; numbered snapshots prevent
old replies from replacing newer state. Focus and status-panel opening refresh
the snapshot. React uses [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore).
This follows Tauri's [managed-state](https://v2.tauri.app/develop/state-management/)
and [event](https://v2.tauri.app/develop/calling-frontend/#event-system) patterns.
Main-only mutation permissions and caller checks protect writes; status snapshots
omit onboarding data. See [Tauri capabilities](https://v2.tauri.app/security/capabilities/).

No new frontend state library is needed. [TanStack Store](https://tanstack.com/store/latest/docs/overview)
provides reactive state; native disk writes and cross-window delivery still need
the Tauri boundary. [Tauri Store](https://v2.tauri.app/plugin/store/) supports
saved key/value settings, but this implementation needs explicit atomic writes,
protected invalid files, and a Quit flush. A small Rust owner and React's existing
subscription API keep those rules in one place.

Writes create a private temporary file in the destination directory, write and
sync it, atomically replace the destination, and sync the directory.
[`tempfile::NamedTempFile::persist`](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html#method.persist)
provides replacement; explicit sync calls provide the durability steps.
Failures before replacement preserve the old file. A directory-sync failure
after replacement leaves a complete new file but reports uncertain durability.

Session edits remain usable and synchronized after a save failure. The next
change or flush retries them. Errors are returned in state and logged, with no
new dialog or banner. Malformed, unreadable, unsupported-version, or invalid
saved documents are protected from all writes for that session; valid known
preferences can still be displayed. Drafts must match the existing machine
contracts and allow unfinished editor input. Documents are capped at 1 MiB,
drafts at 256 KiB, and startup selections at 256 IDs.

All native Quit paths intercept Tauri's
[`ExitRequested`](https://docs.rs/tauri/latest/tauri/enum.RunEvent.html), request a
main-window flush, wait for queued edits, and then exit. The frontend acknowledges
before draining its queue. A two-second fallback applies only when no
acknowledgment arrives; an acknowledged flush can take as long as needed. A
frontend that crashes after acknowledging can require force-quit. A crash cannot
save input that has not reached Rust. An unfinished temporary file is never
loaded as the settings document.

## Fixture isolation

- Browser previews and tests use independent memory stores; they do not read or
  write browser settings storage or native settings files.
- Explicit native fixture selectors initialize native storage in memory before
  any file access. `view` and `native-status` are navigation, not fixture selectors.
- Debug `SILO_SETTINGS_MEMORY=1` forces native memory storage. Native theme import
  ignores memory stores, so a production theme cannot seed the fixture.
- Debug `SILO_SETTINGS_DIR=/absolute/test/directory` selects a separate persisted
  test document. Reuse that directory to test restarts. Release builds ignore
  both environment overrides.

Workspace status and integration results remain deterministic fixtures, not live
VM telemetry or integration verification. Only preference edits and onboarding
recovery input enter this storage path.

## Verification

Completed on macOS arm64, 2026-09-07. Frontend commands run from `app/SiloUI`:

```sh
npm test
npm run typecheck
npm run lint
npm run desktop:build -- --debug --bundles app
```

All passed: 305 frontend tests, type checking, lint, and the macOS debug bundle.
The desktop build also runs the TypeScript and Vite production build. Tests use
four Vitest workers: unrestricted workers caused CPU contention and five-second
test timeouts on this host. Test timeouts and assertions were retained.

Native commands run from the repository root:

```sh
cargo test --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml
cargo build --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml
git diff --check -- app/SiloUI/src-tauri
```

All passed: 20 Rust tests, including 18 settings tests and two existing panel
geometry tests. Settings coverage includes every field, false/empty selections,
legacy import, unknown fields, invalid saved machines, corrupt/future documents,
failed-write retry, incomplete temporary files, concurrent patches, onboarding
recovery, fixture isolation, status initialization ordering, and both Quit
acknowledgment paths.

General, Notifications, and onboarding browser screenshots at 1160×820 were
compared with committed HEAD: zero changed pixels on all three surfaces. Tests
also exercise all 12 preferences, retained values after source replacement and
remount, native event ordering, missed-event refresh, Quit queue draining,
unfinished machine input, Git input, and completion/Cancel behavior.

The macOS bundle used for native checks was
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app`. It ran with
`SILO_SETTINGS_DIR` pointing to a new temporary test directory, without explicit
scenario selectors. Observed native controls after Quit and relaunch, and again
after intentional SIGTERM and relaunch:

- `GitHub` remained the selected setup tab.
- `Git name for dev` retained `Recovery Check`.
- `Allow pushes for acme/silo` remained checked.
- On `Dependencies`, `Terminal` retained `iTerm` and `Code editor` retained `Cursor`.

The JSON file contained edits before Finish. Native Quit exited cleanly; a
process check confirmed no remaining `silo-preview` instance after cleanup.
The native launch logs were empty. Local screenshots and logs are kept in the
ignored `app/SiloUI/src-tauri/target/settings-verification/` directory.

The complete native checklist below is **not** claimed as passed. Accessing the
macOS status item through SystemUIServer timed out in automation; native panel
appearance, folder picker, focus, Escape, and outside-click dismissal remain
unverified for this change. The default running setup fixture blocks machine
editing, so native persistence checks used editable Git inputs; machine-editor
recovery is covered by component and native storage tests.

For repeatable manual checks, build first, then launch from the repository root:

```sh
SILO_SETTINGS_TEST_DIR=$(mktemp -d /tmp/silo-settings-ui.XXXXXX)
open -n 'app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app' \
  --env "SILO_SETTINGS_DIR=$SILO_SETTINGS_TEST_DIR"
```

1. Capture General, Notifications, onboarding application choices, and the native
   status panel at the same dimensions as the baseline.
2. In General change Theme, both startup switches, startup selection, Terminal,
   Code editor, Browser, and Reduce motion. In Notifications change the master
   switch and each category. Navigate away and back; verify each value.
3. Clear Startup sandboxes, disable/re-enable Start sandboxes at launch, and
   confirm the empty selection survives. Disable/re-enable notifications and
   confirm category choices survive.
4. Open the native panel. Verify matching appearance, motion, and application
   labels. Exercise its folder picker, keyboard focus, nested-menu Escape, and
   outside-click dismissal.
5. Change onboarding application preferences; verify General and the panel agree.
   Leave repository selections, push choices, and Git identity input. Quit without
   Finish, relaunch with the same test directory, and verify recovery. Separately,
   in the complete browser fixture (`?view=onboarding&scenario=complete`), exercise
   machine editing, Cancel, and Finish. Do not treat a fixture reload as a disk
   recovery check: explicit fixtures deliberately use memory.
6. Use Quit Silo immediately after another edit, confirm process exit, relaunch
   with the same directory, and verify all preference values. Repeat System,
   Light, and Dark appearance checks and compare baseline screenshots.
7. Relaunch in memory/explicit fixture mode; confirm saved production/test values
   do not appear or change. Repeat the native sequence on Linux when a desktop
   session is available.

Linux native GUI verification is not established by the current host checks:
the host reports Darwin arm64, and installed Rust targets are macOS arm64 and
WebAssembly. Docker and OrbStack command-line tools exist; that alone does not
prove a running Linux desktop session. No Linux build or GUI pass is claimed.
The read-only `orb list --format json` probe returned no output and was canceled
with Ctrl-C (exit 130); it did not establish a Linux VM or desktop session.
