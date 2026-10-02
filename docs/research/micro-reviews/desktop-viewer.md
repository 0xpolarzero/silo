# Desktop viewer micro-review

Scope: `app/SiloUI/src-tauri/src/desktop_viewer.rs`.

Read-only source review. Checked the first, second, and existing third-pass review reports for prior desktop-viewer findings. No builds, tests, native apps, or live data were exercised.

## DESKTOP-VIEWER-1: Host recovery leaves the viewer attached to a retired proxy

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/desktop_viewer.rs:632–651`, particularly `disconnect_matching` and `close_host`.
- **Trigger:** Open a running remote desktop. Three failed computer polls invoke `close_host`; the computer subsequently becomes reachable while its desktop and stream remain running. Leave the viewer's dimensions unchanged.
- **Evidence:** `remote.rs:1219,1283–1292` closes desktop connections after three failed polls. `disconnect_matching` calls `Viewer::disconnect`, dropping each proxy/tunnel without closing the guest child or notifying its shell. `Viewer::disconnect` (`desktop_viewer.rs:116–119`) changes only backend registry state. The shell preserves its prior desktop state when a status read fails (`linux-desktop-viewer.tsx:119–123`). A successful subsequent read clears the error and restores the same running state. Attachment runs only when `workspace`, `streamReady`, `connection`, or `transport` changes, or a resize occurs (`linux-desktop-viewer.tsx:132–160`); none changes in this sequence. The guest remains on the retired proxy origin from `desktop_viewer.rs:562,587`. The Reconnect button requires an error (`linux-desktop-viewer.tsx:60–63`), which successful polling clears, and the desktop menu provides only stop/restart (`linux-desktop-menu.tsx:46–48`).
- **Consequence:** Restored connectivity does not restore the display. The shell removes its connection error and Reconnect control even though the child cannot reach its retired proxy. Resizing or closing/reopening the viewer is required to create a fresh connection; stop/restart is an unnecessarily destructive alternative.
- **Suggested fix:** Propagate backend connection invalidation to the owning shell. Track connection state separately from guest desktop/stream state, and trigger a serialized reattach after recovery or retain a Reconnect control until a fresh attach succeeds. Keep generation checks so late connections cannot undo a newer disconnect.
- **Regression test:** With a running desktop and an attached viewer, invoke host-failure cleanup, then supply successful status reads returning the identical running desktop/stream state without resize events. Assert that the shell either requests a fresh attach or retains a visible, usable Reconnect control until attach succeeds. Verify that recovery never requests desktop stop/restart and that the new child navigates to a fresh proxy origin.
