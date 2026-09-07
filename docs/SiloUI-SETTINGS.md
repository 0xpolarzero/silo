# SiloUI settings persistence

SiloUI saves preferences and unfinished onboarding input. Controls, labels,
layout, navigation, and existing Save/Cancel/Finish actions stay unchanged.
The integrations configured by these preferences remain outside this piece.
Swift code and Swift saved values are untouched.

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
