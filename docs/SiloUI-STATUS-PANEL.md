# Status panel outline

The Tauri status window must be transparent, and its HTML/body backgrounds must
also be transparent. Otherwise the native rectangle shows behind the rounded CSS
panel as a second outline. The panel itself owns the background and rounded border;
the native window owns the shadow. The main window keeps its opaque background.

Tauri requires `app.macOSPrivateApi` and the `macos-private-api` Cargo feature for
[transparent windows on macOS](https://tauri.app/reference/javascript/api/namespacewindow/).
The Tauri CLI synchronizes that Cargo feature when building. This API is not
compatible with Mac App Store distribution.

Verify with `npm run build`,
`npm test -- src/desktop/status-panel.test.tsx src/features/status-bar/status-bar.test.tsx`,
and `npm run desktop:build:debug` from `app/SiloUI`. Inspect the native status
panel over another window to confirm that the desktop shows through all four
corners without a rectangular frame.

Validation on 2026-09-08: frontend build passed, both focused test files passed
(26 tests), and the ad-hoc signed native debug bundle built successfully at
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. The UI driver exposed
the setup window but no tray-item action, so native corner inspection remains
unverified.

## Live folder picker

The status picker uses the same validated `list_workspace_directory` command and
bounded directory cache as the main Files screen. The status window has explicit
read-only command permission. Each navigation loads one level; breadcrumbs reuse
cached entries while refreshing. Filtering applies to loaded folder names, with
Load more available when another page exists. Links are not followed.

Initial loads and additional pages show skeletons. Failed refreshes retain existing
folders and a compact Retry message. Empty and unavailable states are distinct.
Editor opening requires a running, fresh VM and a successfully listed folder.
Polling stops on window blur, hidden document, leaving the picker, or unavailable
VM state. Listing never boots a stopped VM. Preview/test trees are supplied only
through the fixture loader, with no production fallback to `workspace.files`.

Manual check: start dev, open Silo’s status item, choose dev’s Open in editor action,
then browse silo-files-test-express/lib. Breadcrumbs must return to real cached
folders, filtering must narrow the list, and Open must use the chosen guest path.
