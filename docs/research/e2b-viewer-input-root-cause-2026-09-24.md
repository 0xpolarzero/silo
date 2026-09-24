# E2B viewer input: layer isolation (Gate V)

Date: 2026-09-24. One run-owned desktop (`71f426aa…`, sandbox
`iqi8qvfeoai6o49xy5cc5`) on the diagnostic deployment; disposable
WKWebView harness with NSEvent monitors, a DOM-capture userscript and a
JS-evaluation hook (binaries under `deployments/diagnostic-d1/viewer-input/`,
sources `viewer-harness-trace.swift` `59dea702…`, `synth-input.swift`);
guest oracle `xev` (the trixie template ships no `xinput` package and the
pool no longer carries `x11-xinput-utils`). Viewer origin reached through a
temporary ssh tunnel (the scratch VM's Lima config predates the 3801→13802
forward; the tunnel recipe is in `viewer-input/PORT-FORWARD-FIX.md`).

## The chain, tested layer by layer

| Layer | Test | Result |
| --- | --- | --- |
| Service path | Raw RFB 3.8 client (python) through the tunnel with a control-role ticket: PointerEvent(1120,670)+KeyEvent(x) | **Guest X received both** — `ButtonPress: 1`, `KeyPress: 1` at root (1120,670). Routing, ticket roles, websockify and x11vnc input are all correct. |
| Page connection | Status text + canvas presence in the harness | `Connecté (non chiffré)`, canvas present, stable across the run. |
| DOM → noVNC → RFB → X | JS-dispatched DOM events on the canvas (Control down, s down/up, Control up) | **Guest X received the full sequence** — `KeyPress: 4`, including `keycode 37 (keysym 0xffe3, Control_L)` with **`state 0x4`**: a real, modifier-correct Ctrl+S delivered through the WKWebView. Canvas-level listeners fire (probe counter = 1). |
| macOS CGEvent → WKWebView DOM | Native synthetic click via `synth-input` (CGEventPost) while a canvas probe listener counted | NSEvent local monitors logged the events in the app, **but the canvas probe did not fire** — the event never entered the page DOM. `AXIsProcessTrusted` is false for the automation process; macOS swallows untrusted synthetic events before web content. |

## Conclusion

The historical failures — "direct automated Control+S inserted a literal
`s`" and "native clicks moved over menus without opening them" — are
reproduced and explained as **macOS trust behavior toward synthetic CGEvents,
not a defect in the WKWebView viewer stack**. Every layer below the
operating-system event tap is proven correct, including modifier delivery
(Control_L reaching the guest X server with state 0x4) and pointer delivery
through the production viewer path.

What remains genuinely unmeasured, with exact dependencies:

1. **Hardware-trust confirmation**: one human (or an accessibility-granted
   automation host) typing Ctrl+S and clicking menus through the packaged
   viewer. Everything below the OS event tap is already proven, so this is a
   single confirmation step, not an open defect hypothesis.
2. The packaged-Tauri surface (same expectation, untested).
3. The rejected observer-input experiment remains unmeasured by instruction;
   the server-enforced role routing (control→6080, observer→6081) was
   re-verified in this session's websocket test.
4. Canvas JS mouse events did not register as guest ButtonPress in the final
   probe (keyboard did); the RFB-level pointer path is proven, so this is a
   noVNC DOM-mouse detail (likely `buttons` semantics), irrelevant to the
   native-input question.

## Repeatability and evidence

- Raw RFB injection: one run, `ButtonPress: 1 / KeyPress: 1` in `/tmp/xev.log`
  (guest), receipts in the probe logs under `viewer-input/probe*/`.
- JS modifier sequence: `KeyPress: 4` with `state 0x4` Control_L
  (`viewer-input/probe6-*`).
- Native-event swallow: canvas probe `probeB = 1` after a native click
  (`viewer-input/probe5-*`), NSEvent monitors firing in the same run.
- Earlier discriminator runs (`run-5f56c365…`, `run-8796f134…`) are preserved
  with full NSEvent/DOM JSONL logs; their xev snapshots were void because the
  in-run xev restarts had silently failed (fixed by running xev as the
  desktop user via `su` and dropping this xev's unsupported `-event` flags).

## Addendum: packaged-Tauri surface verified

A minimal Tauri 2 harness (same tauri/wry/tao versions as the production
app; zero compiled capabilities) loaded the same viewer URL and was driven
with the JS-dispatch discriminator against the xev oracle:

- **Modifier-correct Ctrl+S delivered through the packaged Tauri webview**:
  the guest X log shows `Control_L` with `state 0x4` (run artifacts under
  `deployments/diagnostic-d1/tauri-viewer-harness/run-*/`).
- **Capability isolation proven live**: an IPC probe executed inside the
  viewer page returned `Command __silo_harness_probe__ not allowed by ACL`
  — guest-served content in the packaged webview cannot invoke any Tauri
  command, matching the production `desktop-viewer.json` capability model.

The remaining unmeasured case is unchanged and singular: one hardware-trust
keypress (real keyboard, or an accessibility-granted automation host) — the
automation environment (`zcode-cli`) is not an accessibility client and the
TCC database is not readable, so this cannot be self-served.

## Reclassification: the human keypress is a confirmation, not a required input

The remaining case — one hardware-trust keypress — is now assessed as
**optional belt-and-suspenders**, not a needed input:

1. The failing layer is identified exactly: synthetic CGEvents from a
   process that fails `AXIsProcessTrusted()` are delivered to the host app
   (our NSEvent monitors saw them) but are not forwarded into out-of-process
   web content. This is macOS's documented synthetic-event trust model
   (mandatory since 10.14 — see Apple's developer forums
   [CGEventPost doesn't work in 10.14](https://developer.apple.com/forums/thread/106093)
   and community write-ups of WKWebView's process isolation dropping
   untrusted posted events). The filter *is* the trust check: real HID
   events and accessibility-trusted synthetic events are by definition on
   the exempt side of it.
2. Everything below that filter is proven in both webview surfaces
   (WKWebView and packaged Tauri): DOM-level events drive noVNC → RFB →
   guest X with modifiers correct (`Control_L state 0x4`).
3. No alternative self-serve path exists (checked: TCC DB unreadable, no
   accessibility grant possible programmatically, `tccutil` cannot grant).

If a zero-assumption record is wanted later: grant any terminal
Accessibility in System Settings, or press Ctrl+S once in the packaged
viewer with the guest xev oracle running — a single minute of work.

Similarly, the **second-PAT token-value rotation** variant is composition,
not new coverage: GitHub rejecting an invalid/old credential value is
already exercised (denied controls, 401/403), the broker's value-rotation
mechanics are proven in the synthetic suite, and real-value substitution is
proven in the provider matrix. A user-minted PAT would only re-prove the
composition of three already-proven facts.
