# Selkies 2.0.0 Web client first-frame fix

## Pin and provenance

Silo's Ubuntu 24.04 Selkies recipe pins upstream Selkies 2.0.0. The installed
client core is
`selkies/selkies_web/assets/selkies-core-BbKps5RD.js`, within the Python wheel.
The [Selkies 2.0.0 release](https://github.com/selkies-project/selkies/releases/tag/2.0.0)
publishes the versioned Linux package. The [web-client documentation](https://docs.selkies.io/latest/components/web-client)
describes the bundled `selkies-web-core` client. Selkies lists the server and
web client as [MPL-2.0](https://docs.selkies.io/latest/licensing); the patch
therefore remains a small, readable, source-fragment change to that licensed
file rather than a replaced or hidden bundle.

The installed ARM64 asset and the pinned amd64 DEB asset are byte-identical.
Their source SHA-256 is
`3a2199dfa2535eb0ad077e6413df11ef57b944e802209788d140c2194e2e1519`. The
verified patched output SHA-256 is
`7ef83a1dc3fd37f30662bd0faabc4f640380bea30c6a1d47f7ff89deebc554a2` for both
architectures. The installer helper
`app/SiloUI/src-tauri/guest/patch-selkies-web-client.py` accepts only those
exact source/output hashes and the three expected source fragments; it is
idempotent and atomically replaces the asset. Any unknown source hash or
fragment shape fails without writing.

## Reproduced event order and change

The pinned client assigns its `onopen` handler before handling server messages.
That handler awaits codec capability detection (`Bi()`) before assigning the
“Connection established. Waiting for server mode...” state. Selkies can send
`MODE websockets` during that await; the message handler advances the visible
state to “Waiting for stream...”, then the older `onopen` continuation
overwrites it. Moving the initial waiting-mode assignment before the await
removes that stale write.

The first patch alone exposed a second readiness gap. The video worker's
`present()` draws a decoded `VideoFrame` onto its OffscreenCanvas and sends a
`presented` event. The page handler used that event only to hide a fallback
canvas. It relied on a later `wireStats` message to call `no()`, the existing
idempotent routine that hides the waiting status. On the tested WebKit path the
worker delivered `presented` without `wireStats`, leaving the banner visible
after a successful first draw. The page now calls `no()` from the existing
`presented` handler. It does so only after the worker reports a successful
draw, and `no()`'s existing `xr` guard keeps the change idempotent.

The focused regression uses the exact three source fragments. A delayed codec
promise reproduces the stale status before the patch and preserves the early
MODE status after it. A separate event-order check confirms that an unrelated
worker message leaves the status visible, while the first `presented` event
hides it once even without `wireStats`.

## Live verification evidence

The live source-directed observer records only worker event types and numeric
frame summaries. On the ARM64 Ubuntu 24.04 scratch VM it observed video-worker
`mode=canvas`, `wireDims` of 1440×900, and `presented`; the latter follows the
worker's decoded-frame draw. The previous observer filtered video-worker
events, which is why the first transport/overlay analysis could not identify
this readiness callback. The earlier exposed `window.videoChunksReceived` and
`window.fps` counters were zero because the diverted socket-worker path sends
video buffers to the video worker and bypasses the page-level counter update.

The task-owned guest's static web files are copied from the Python package to
`/tmp/selkies_web*` when the streamer starts. Replacing the installed asset
alone therefore leaves the current process serving its startup copy. The
supported `silo-desktop restart-streamer` action replaces only Selkies while
preserving the desktop session; a no-cache authenticated GET then verifies the
served asset hash before a new viewer is opened. The final fixed-overlay
capture and its process/session identity check are recorded in the research
probe report after verification completes.
