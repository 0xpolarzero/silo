# E2B viewer input and ownership readiness

Date: 2026-09-23. Scope: native WKWebView input/save and two-viewer ownership.
The first sections record the source review before the PoC ownership fix; a
later section records implementation and a fresh live run.

## Before-fix evidence

The PoC creates a disposable AppKit `WKWebView` that loads a supplied URL. It
does not register Tauri IPC or add an automation bridge
([harness](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/viewer-harness.swift:1)).
The latest fresh desktop run showed the Xfce desktop, Firefox and Mousepad in
WKWebView and reported native text entry, but it did not verify a native file
save. Automated Control chords did not act as expected. The historical 2026-09-22
save through noVNC's on-screen Control key is a separate run and is not a pass
for this fresh run ([fresh-run report](e2b-fresh-desktop-qualification-2026-09-23.md)).

Before the ownership fix, the browser set noVNC's `view_only=true` query
parameter while the desktop's global mode was `agent`; the gateway separately
chose guest port 6081 in agent mode and 6080 in human mode.
The guest launches two x11vnc servers: port 5900 allows input, while 5901 starts
with `-viewonly`; websockify exposes them on 6080 and 6081 respectively
([desktop startup](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/start-desktop.sh:15)).
The viewer proxy chose the port from the shared desktop record on the host,
not from the browser query. A proposed observer URL parameter-change test was
rejected by automatic browser review and was not attempted through another route.

Before the fix, tickets carried the logical desktop ID, epoch and expiry. They had no
per-viewer ID or owner role. `mode()` changes one workspace-wide value and
increments its epoch; `viewer_session()` mints a ticket for any running
workspace; and the route sends every viewer to the same port selected by that
global mode ([ticket code](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/server.py:77),
[mode code](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/runtime.py:409),
[session endpoint](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/server.py:296)).
The control page refreshes state every four seconds and mints a new ticket
whenever the selected workspace's ID, epoch or status changes
([refresh loop](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/index.html:19)).

This created a concrete falsifiable ownership risk: after viewer A took
control, A and B's old epoch tickets should stop working. But after either page
refreshed, both could obtain fresh tickets while mode was `human`, and both
were routed to the shared writable server. Live run
`7d468e5fb97f450abcc4aba0707518b3` confirmed a second browser viewer's
`B` keystroke appeared in the shared guest buffer while a native viewer held
human mode; two mint requests produced the same ticket digest. This was a PoC
viewer ownership defect, not an attributed E2B runtime defect.

### Implemented owner-specific PoC fix

The earlier API had no authenticated user, browser, tab, or viewer-instance
identity. Signed tickets held only `sid`, `epoch`, and `exp`; the mint endpoint
ignored request data, and identical claims produced identical tickets within
the same second. `mode` recorded only a workspace-wide `agent`/`human` value.

The PoC now gives each control-page tab a random UUIDv4 `viewer_instance` in
`sessionStorage`. Takeover stores its SHA-256 digest as `control_owner` and
advances the epoch; release checks the matching instance, clears the owner and
advances the epoch. Viewer-session mint includes a random nonce and signs an
explicit `control` or `observer` role. It grants `control` only when the
requesting instance matches the stored owner. Each viewer asset and WebSocket
route selects port 6080 for that verified role, otherwise 6081. The URL's
`view_only` value does not select the upstream port. Existing stream checks
revalidate the signed ticket and epoch, closing old streams after a transition.
The ten-minute ticket TTL remains.

Service-level tests use two viewer instances and assert the actual WebSocket
upstream gets 6080 for the owner and 6081 for the observer. They also cover
explicit takeover by the second viewer, old-ticket rejection and release.
The fresh live run `8c17677f1fc4417ba6a0ef22ed08f40c` displayed A as
control/B as observer at epoch 1, then A as observer/B as control after an
explicit B takeover at epoch 2, then both as observers at epoch 3. The private
live receipt SHA-256 is
`f44dae351cf2058514430a1b6157b871b98a70ea5fb037d6217e9426357d0777`;
exact-run cleanup receipt SHA-256 is
`5afbc6570ff2bc3748abc1b08e652a60249fb356cdc5027db0f8bf0736238779`.
The one run-owned guest was deleted and temporary tabs/forward were closed.
This is a per-tab capability in the trusted local PoC, not user authentication:
any script with same-origin API access can request or take over control.
Production use needs an authenticated principal or a server-minted secret
capability with an explicit authorization policy.

## Why automated Control may have failed

The evidence supports a focus/key-translation problem; it does not isolate the
exact cause. The harness activates the AppKit app and shows the window, but it
does not observe which native view or DOM canvas owns keyboard focus, record
modifier events, or claim the WKWebView as the window's first responder. AppKit
routes keyboard events through the first responder chain
([Apple `NSWindow.firstResponder`](https://developer.apple.com/documentation/appkit/nswindow/firstresponder)).
noVNC also has a `focusOnClick` behavior for moving keyboard focus to the remote
session; the click and the modifier chord must reach the noVNC canvas
([noVNC API](https://github.com/novnc/noVNC/blob/master/docs/API.md)).

The on-screen Control key takes another path: noVNC sends an explicit remote
Control keysym, so it can work even when the automation tool delivered the
wrong host modifier or sent the chord while focus was elsewhere. A macOS
`Command+S` is not a guest `Control+S`. Direct automation can also release the
modifier before the character, target browser chrome, or synthesize a key event
that WebKit does not forward like a native key event. These are hypotheses, not
established causes. During the live case, capture the native focused window,
click the viewer canvas before input, compare direct Control+S with noVNC's
on-screen Control followed by S, and record guest-side X input events. If the
second path works and the first produces no guest Control key event, the fault
lies in the Mac automation/focus/translation path; if both reach X but the
editor does not save, inspect the editor focus, shortcut, and dirty-buffer
state.

### Native click does not open Mousepad's File menu

The current controlled observation narrows this to the native input path:
IAB's click opens File; the same visible File target in WKWebView gets hover but
does not open; native text does reach Mousepad; and direct Ctrl+S and Super+S
each insert only `s`. The harness has no custom event translation or automation
bridge, so there is no source evidence for a harness-side click rewrite
([harness](/Users/polarzero/code/projects/microsandbox-workspaces/experiments/e2b-local/viewer-harness.swift:1)).
noVNC v1.6.0 registers separate canvas `mousemove`, `mousedown`, and `mouseup`
handlers and turns these events into VNC pointer messages
([noVNC RFB source](https://github.com/novnc/noVNC/blob/v1.6.0/core/rfb.js#L3101-L3125)).
Hover proves motion reached the displayed surface; it does not prove a button
press/release did. The matching “modifier chord became plain `s`” symptom makes
the leading hypothesis that native automation is moving/typing but not
delivering a complete native button or modifier sequence to WKWebView. This is
falsifiable and not yet a WKWebView or noVNC defect finding.

The smallest discriminator on the next run is to record, for one IAB and one
WKWebView attempt, (1) local NSEvent mouse-down/up and key-down/up with modifier
flags, (2) DOM canvas `mousedown`/`mouseup` and `keydown`/`keyup` with
`button`, `buttons`, `key`, and modifier flags, and (3) guest XI2
`ButtonPress`/`ButtonRelease` and key events with coordinates. Do not infer a
click from pointer motion. If NSEvent lacks a button pair, the automation
input is the cause; if NSEvent has it but DOM does not, isolate AppKit/WebKit
delivery and responder/focus; if DOM has it but guest XI2 does not, inspect
noVNC `viewOnly` and its VNC/WebSocket path; if guest XI2 sees a correctly
positioned left-button pair but Mousepad does not open the menu, inspect guest
window/event behavior. The same layer-by-layer check applies to modifiers.
Record the actual URL's `view_only` query and selected backend port: noVNC can
suppress events client-side, and the proxy can independently select a read-only
server. Do not change the harness or noVNC before this trace identifies a
missing edge; if the automation layer lacks native down/up and modifier
semantics, the smallest fix is to use a native event action that emits explicit
press, release, and modifier-held intervals, then rerun the same XI2 oracle.

## Deterministic live test

Run only on the exact owned scratch deployment under its active run lease. The
run owner should generate `run_id = uuid.uuid4().hex`, create the test desktop
with that `run_id`, and save all reports under
`evidence/runs/<run_id>/viewer-input/`. Record the desktop ID, SDK sandbox ID,
template/build ID, guest kernel and package versions, the local viewer/control
origin, and each ticket's digest (never publish ticket values; the two digests
may match).
On failure preserve the run-owned guest and report its ID. Delete only this
run's desktops after reports and hashes are written on a full pass.

### Guest-side oracles

Prepare two independent guest oracles before opening the viewers:

1. **File oracle:** choose a run-specific file under `/home/user`, write a
   baseline string through the SDK file API, and record its exact UTF-8 bytes,
   length and SHA-256 from an independent guest command. Open that exact path
   in Mousepad. The assertion after save is that both SDK file readback and
   guest `sha256sum` match the expected replacement bytes. A screenshot alone
   is not a save oracle.
2. **Input oracle:** run `xinput test-xi2 --root` in the guest, redirecting its
   output to a run-specific log, and take an initial event count. `xinput`
   registers XI2 input events and prints them
   ([X.Org manual](https://xorg.freedesktop.org/archive/X11R7.5/doc/man/man1/xinput.1.html)).
   Send a unique short alphanumeric canary and compare new guest-side key events
   and keycodes. Before trusting this oracle, send one known key from the
   writable control viewer and verify that the listener records it. If `xinput`
   is absent or the listener cannot observe the test device, stop; do not
   substitute an unchanged file for proof that input was blocked.

### Input and save sequence

1. Create two native viewers, A and B, to the same run-owned desktop. Mint a
   ticket through the control endpoint from each independent viewer context and
   retain only redacted ticket digests. The digests may match because the ticket
   claims have no viewer identity; record that result. Initially both should
   display the same desktop through the observer server.
2. Confirm B's signed observer role selects the guest's read-only server in an
   instrumented WebSocket route test. A normal observer URL also has
   `view_only=true`, which suppresses input at noVNC before the server sees it;
   the live normal-URL case alone cannot prove server-side input rejection.
3. A clicks **Take control** in the trusted control page. Verify the workspace
   epoch advances, both old tickets are rejected, and A receives a fresh
   writable viewer connection. B must remain read-only or be disconnected until
   A explicitly releases ownership or B explicitly takes it. Inspect the fresh
   B ticket role and WebSocket route after its normal four-second refresh.
   **Expected and observed in the fixed PoC:** B stays on port 6081 until it
   explicitly takes control. A received fresh access alone is not an ownership
   pass.
4. With A still owner, type a unique string into Mousepad. First test direct
   automated Control+S with a deliberate canvas focus. Then repeat using the
   noVNC on-screen Control key followed by S as the comparison path. Record the
   guest XI2 key events for each path. Verify the saved file's exact bytes and
   SHA-256 from the guest through the independent SDK/file channel.
5. Release A's ownership. Verify the epoch advances again and the prior A
   writable ticket cannot open assets or WebSockets. Verify the trusted page
   returns the session to observer port 6081. Input count must stay unchanged
   for both old and new normal observer connections.
6. Preserve the exact URL origins, redacted session/ticket digests, timestamped
   XI2 event counts, file bytes/hash, screenshots, HTTP status and WebSocket
   close codes. Keep raw access tokens, ticket values and unredacted SDK output
   private. On failure leave the guest untouched for inspection; on complete
   pass retire only run-ID-owned resources.

## What each proof establishes

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Browser or WKWebView shows the desktop | The viewer assets rendered and a display stream arrived. | Keyboard routing, persistence, packaged Tauri behavior, or exclusive control. |
| Synthetic browser `KeyboardEvent` or DOM event | Page code responded to a script-created event. | Native keyboard delivery or VNC input. |
| Native automation types visible text | Some native input reached the focused guest surface in that attempt. | That Control/Command modifiers work or that the file was saved. |
| Guest XI2 event log sees keycodes | Input reached the guest X server. | Editor accepted the text or persisted it. |
| Exact independent guest file readback and SHA-256 | The editor save reached the guest filesystem with expected bytes. | That other viewers are denied input. |
| B's view-only URL plus zero guest XI2 events | The guest-side observer server denied those attempted input events. | Denial after A takes control unless repeated in that state. |
| A succeeds and B produces no events while A owns | Exclusive live input ownership for this tested case. | Clipboard, physical keyboard on other hosts, packaged Tauri, or reconnect races. |

## Readiness verdict

Native rendering and text entry have partial evidence. Native pointer clicks,
modifier delivery, a fresh native save, and guest-observed denial for a viewer
with its client input UI enabled remain unqualified. The PoC now grants the
interactive backend only to the current owner in local WebSocket tests and a
two-tab live mode/role check. That does not establish authentication, exclusive
connection use when a bearer ticket is copied, or packaged Tauri behavior.
