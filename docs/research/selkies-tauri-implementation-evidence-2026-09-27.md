# Selkies 2.0.0 implementation evidence for Silo

Research snapshot: 2026-09-27. This is an implementation qualification note,
not a measured performance result. The target is one Xfce/X11 session per Linux
VM, native Selkies attached to that display and its audio server, and a viewer
inside Silo's existing macOS/Linux Tauri webview. Local and remote connections
use Silo's existing authenticated forwarding. Silo's in-guest LCU remains a
separate direct path. The existing human viewer retains direct keyboard and
pointer input. Attaching, resizing, hiding, disconnecting, or restarting the
streamer must not cause other desktop state changes. Overlapping input with LCU
is the user's responsibility; no coordination mechanism is part of this design.

## Position

**Selkies 2.0.0 is a credible candidate for this architecture on Ubuntu 24.04
AMD64 and ARM64, including CPU-only guests, but one decisive embedded-webview
spike is still required before adoption.** Upstream explicitly supports a native
X11 attach path, ships Ubuntu 24.04 packages for both architectures, serves its
own bundled HTML client, defaults to a single-port WebSocket transport, and
ships CPU encoder fallbacks. The unresolved gate is not whether WebKit has some
WebCodecs support: upstream documents JPEG fallback when WebCodecs is absent.
The gate is whether the exact Tauri WKWebView and WebKitGTK builds render,
decode, focus, authenticate, and reconnect acceptably through Silo's actual
local/remote forwarding path.

Do not treat upstream codec availability, `createImageBitmap` support, or the
JPEG fallback as proof of acceptable text sharpness, motion, CPU load,
bandwidth, latency, or a usable Silo user experience. No Silo measurement has
been made here.

## Pinned upstream facts

| Topic | Demonstrated in Selkies 2.0.0 / platform source | What remains unproven for Silo |
| --- | --- | --- |
| Browser decode | Default WebSockets use browser WebCodecs. The release describes a striped-JPEG path for browsers without WebCodecs. The server/client codec ladder offers only codecs available on both sides, with JPEG last. | Per-codec operation and resource cost in the exact macOS WKWebView and Linux WebKitGTK shipped by Silo; whether the no-WebCodecs JPEG route meets product quality. |
| WebAssembly | The pinned 2.0.0 release description documents WebCodecs and striped JPEG fallback; it does not document a WASM codec decoder. | No reason to count a WASM decode path as available. Source-level confirmation in packaged web assets is part of the spike if this distinction matters. |
| WebKit versions | WebKit announced video WebCodecs in Safari 16.4. WebKitGTK announced WebCodecs support in 2.44. Ubuntu Noble's WebKitGTK package family begins at 2.44 and is updated separately by architecture. | The exact system WebKitGTK version and API/codec configuration on each supported Linux package; API presence alone does not prove H.264/4:4:4 decoding or Selkies compatibility. |
| Tauri engines | Tauri/Wry uses WKWebView on macOS and WebKitGTK on Linux. | Tauri's installed Wry version, macOS runtime, system WebKitGTK build, and Linux hardware decode path must be read from each packaged Silo build. |
| Native server | The 2.0.0 native guide says native packages start nothing and attach to an existing X.Org display plus PulseAudio or PipeWire-Pulse. Existing Wayland desktop capture is not the documented native path. | Running under Silo's exact Xfce/Xvfb process environment, sharing the same session/audio endpoint, and keeping that session alive through streamer restart. |
| Architecture | The 2.0.0 release contains `ubuntu24.04-amd64.deb` and `ubuntu24.04-arm64.deb`; native packages install a private `/opt/selkies` Python environment and bundled web/media extensions. | Clean install and startup on Silo's built guest images, including package dependencies and cold-start time. |
| Software-only host | 2.0.0 documents software encoders: x264/OpenH264 H.264, x265/kvazaar H.265, libvpx VP8/VP9, SVT-AV1, striped software H.264 and JPEG. | The default package's exact encoder build, 4:4:4 behavior, CPU cost and useful frame rate at target resolution. No upstream headline claim is a Silo result. |
| Input roles | A `#shared` viewer is server-enforced as keyboard/mouse/gamepad read-only. Secure-mode tokens carry a `controller` or `viewer` role and slot; role checks are server-side. Optional Basic view-only password also caps a page at viewer. | Silo's current direct-input viewer does not need an observer role or auth-mode change. If a future viewer-only path uses upstream roles, a fragment is not sufficient security; test server-enforced credentials. |
| Resize/data movement | Resize is enabled by default. Clipboard defaults to both directions; file transfers default to upload+download; printing defaults enabled. | Whether Silo exposes any of these features and what defaults product policy requires. Lock or disable features Silo does not intend to support. |
| Network/auth | WebSockets is default on one TCP port. Secure mode authenticates `/api/websockets` with `?token=` and offers session tokens by role; legacy Basic auth covers the page and routes. Exact WebSocket origin allowlisting is available. | That the current local and remote forwarding preserves HTTP Upgrade, the WebSocket route/query, and the Tauri page's actual Origin. Exact-origin allowance and Tauri scheme behavior need a live integration check. |

Primary sources:

- [Selkies 2.0.0 release](https://github.com/selkies-project/selkies/releases/tag/2.0.0): release date/tag, transports, codecs/fallback, package architecture, and release-specific behavior.
- [Selkies 2.0.0 native install guide](https://github.com/selkies-project/selkies/blob/2.0.0/docs/native.md): package installation, existing X11/audio attach, server command, listener binding and TLS/auth notes.
- [Selkies 2.0.0 settings reference](https://github.com/selkies-project/selkies/blob/2.0.0/docs/settings.md): source-generated defaults, encoders, resize, clipboard, input, and server configuration.
- [Selkies 2.0.0 usage guide](https://github.com/selkies-project/selkies/blob/2.0.0/docs/usage.md): sharing roles, clipboard/files, and defaults.
- [Selkies 2.0.0 secure mode](https://github.com/selkies-project/selkies/blob/2.0.0/docs/secure-mode.md): token provisioning, route auth, and WebSocket origin rules.
- [Selkies 2.0.0 input handler](https://github.com/selkies-project/selkies/blob/2.0.0/src/selkies/input_handler.py): server-side input authority and viewer message policy.
- [Selkies 2.0.0 settings source](https://github.com/selkies-project/selkies/blob/2.0.0/src/selkies/settings.py): defaults and listener/auth/codec configuration schema.
- [WebKit: Safari 16.4 features](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/): video portion of WebCodecs announced for Safari 16.4.
- [WebKitGTK 2.44 release notes](https://webkitgtk.org/2024/03/27/webkigit-2.44.html): WebCodecs announced for WebKitGTK 2.44.
- [Ubuntu Noble WebKitGTK package results](https://packages.ubuntu.com/search?keywords=webkit2gtk&searchon=names&suite=noble): current Noble package versions differ across AMD64 and ARM64; they are not a single fixed upstream WebKit version.
- [Tauri/Wry platform engines](https://github.com/tauri-apps/tauri): Tauri uses WKWebView on macOS and WebKitGTK on Linux.

## Browser and embedding implications

The pinned release says Selkies bundles and serves its HTML client from the same
Python service. It does not promise a separately versioned embeddable widget or
stable JavaScript client API. The lowest-risk first integration is therefore to
load the upstream-served page inside the existing Tauri webview. Preserve the existing Tauri child webview and outer shell for the spike; do
not add an iframe or copy/reimplement the Selkies protocol client. The child
loads the authenticated loopback origin, so verify that actual origin rather
than assuming the outer shell's custom scheme reaches Selkies.

The release identifies the no-WebCodecs path as striped JPEG. That is a
functional browser fallback, not a substitute proof for interactive video
quality. The pinned release page does not promise a WASM decoder. Require
WebCodecs and successful decoding of the chosen codec in the performance
qualification path; record JPEG separately as compatibility behavior. If
WebCodecs is missing but JPEG still renders, do not mark the engine supported
until that path meets an explicit CPU, motion, bandwidth and text-quality bar.

WebKit's own release notes establish that Safari's video WebCodecs started in
16.4 and WebKitGTK support arrived in 2.44. This makes WKWebView and Ubuntu
24.04 WebKitGTK plausible targets, not qualified targets. Tauri embeds the
system WebKitGTK on Linux; package updates can change its build. The current
Ubuntu package listing reports different package revisions for AMD64 and
ARM64. Capture `navigator.userAgent`, WebKitGTK package version, and
`VideoDecoder.isConfigSupported()` for the actual codecs in the packaged app.
Also test actual stream decode; codec probes can succeed while color format,
rendering, threading, permission, or WebSocket details fail.

The ordinary display viewer needs a secure WebSocket route and keyboard/mouse
event delivery. Selkies says localhost qualifies as a secure context for
browser clipboard, gamepad, pointer lock, microphone and webcam; that alone
does not prove a Tauri custom app origin is treated as localhost or can access
those APIs. For the initial spike, test keyboard and mouse through the actual
webview. Keep currently unsupported extras such as clipboard, gamepads,
microphone, webcam, printing and file transfer disabled unless the existing
viewer requires them. Resize is enabled by default and follows the browser
viewport; pass `--enable-resize=false` and set a fixed Xvfb mode so viewer
window changes cannot alter guest geometry.

For auth and forwarding, keep Selkies bound to guest loopback
(`--addr=127.0.0.1`) and use Silo's existing authenticated port forward and
gateway. Selkies 2.0.0 defaults to WebSockets on TCP 8080; legacy Basic auth
protects the page and routes. The gateway must carry HTTP WebSocket Upgrade
traffic and apply its existing upstream Basic auth to `/`, assets, API calls,
and the socket handshake, stripping any caller-supplied `Authorization` as it
already does. If the parent and viewer are cross-origin, the server's WebSocket
origin guard defaults to same-origin; record the exact Origin and allow only
that value with `--allowed-origins`. Do not use `*` or assume the SSH forward's
authentication alone authenticates the Selkies endpoint.

Selkies also has server-enforced roles, but they are not required to deliver
the current direct-input viewer. A `#shared` fragment is not authentication:
without secure mode a client can remove the fragment, so it must not be used as
a security boundary. The optional view-only Basic password is capped at viewer
server-side. Secure mode provisions `controller`/`viewer` roles through
`POST /api/tokens`, but its session token is carried in `/?token=...` and
`/api/websockets?token=...`; upstream warns that reverse-proxy logs may retain
those queries. Do not add secure-token plumbing or an observer capability in
this implementation unless a future product requirement calls for it.

## Smallest decisive compatibility spike

Run one one-command disposable guest fixture per architecture from the pinned
Ubuntu 24.04 runtime image. It should create the exact intended isolated Xfce
X11 display and audio server, start `selkies` as an independently supervised
native process, and use Silo's existing local and remote authenticated port
forwarding. Do not use `selkies-session`; it owns the desktop/display tree and
would fail to test the proposed separate-supervisor lifecycle. Do not add
WebRTC, a proxy, or a second viewer client to this first spike.

Install and launch using the upstream documented package path, with values
substituted by the fixture rather than committed credentials. This is the
upstream command shape, not a complete installer: resolve and verify the exact
package checksum before executing the installation step:

```sh
export SELKIES_VERSION=2.0.0
export SELKIES_DISTRO=ubuntu24.04
export SELKIES_ARCH="$(dpkg --print-architecture)"  # amd64 or arm64
export SELKIES_PKG="selkies-${SELKIES_VERSION}-${SELKIES_DISTRO}-${SELKIES_ARCH}.deb"
curl -fsSLO "https://github.com/selkies-project/selkies/releases/download/${SELKIES_VERSION}/${SELKIES_PKG}"
sudo apt-get install -y "./${SELKIES_PKG}"

# Run in the same guest environment as Xfce; the existing gateway injects
# Basic auth from its native credential store.
DISPLAY=:1 XDG_RUNTIME_DIR=/run/silo-desktop/user \
PULSE_RUNTIME_PATH=/run/silo-desktop/user/pulse \
PULSE_SERVER=unix:/run/silo-desktop/user/pulse/native \
selkies --addr=127.0.0.1 --port=6901 --enable-resize=false \
  --basic-auth-user=silo --basic-auth-password="$GATEWAY_UPSTREAM_SECRET"
```

The Silo child webview loads the loopback proxy origin. Verify the gateway
rewrites and forwards that origin correctly; add an exact `--allowed-origins`
value only if the observed server contract requires it. Do not add a Basic
password to the viewer URL or expose it to JavaScript. Disable optional
clipboard, file transfers, printing, gamepad, webcam and microphone features
for the first viewer check unless the existing product requires them.

Test only the critical vertical slice:

1. On macOS 14+ Apple Silicon and supported Ubuntu 24.04 Linux x86-64/ARM64
   packages, load the guest-served page in the exact packaged Tauri WebView.
   Record the OS build, Tauri/Wry versions, runtime WebKit versions, user agent,
   GPU visibility, guest architecture, and actual selected encoder.
2. Verify gateway-injected Basic auth, WebSocket Upgrade and frames through both
   local and remote existing forwarding. Record the actual Origin and verify a
   non-allowlisted Origin is rejected. Reconnect after dropping and restoring
   the forwarded connection.
3. Confirm canvas/video paints at the fixed Xvfb resolution; render a static
   small-text/color chart and a scrolling/moving workload. Exercise keyboard,
   mouse, window focus, and resize behavior. A viewport resize must not change
   guest geometry when `--enable-resize=false`.
4. Confirm negotiated decoder/encoder and pixel format from Selkies logs and
   WebView capabilities; run first with software H.264 on CPU-only AMD64 and
   ARM64. Add GPU encode only after confirming a guest-visible render/encode
   device. Keep any CPU, latency, bandwidth, and quality thresholds explicit
   and measure them; upstream claims do not set the Silo threshold.
5. Disconnect the viewer, kill/restart only the Selkies process, and reconnect.
   Verify Xvfb, Xfce, PulseAudio/PipeWire-Pulse, direct in-guest LCU and app
   processes remain alive and the same desktop state returns.
6. Hide/minimize the viewer and disconnect its last connection. Selkies lets a
   client stop its own video feed with `STOP_VIDEO`; the default session has
   video on and a shared viewer starts a stream. Measure whether capture/encode
   work suspends when all pages are hidden or disconnected, then confirm that
   the desktop and LCU continue. Upstream docs do not specify zero-viewer
   capture lifetime, so leave it unknown until this check passes.

This is a compatibility spike, not a broad bake-off. It gives a decisive yes/no
on the integration seam before Silo invests in product UI or distribution.

## Reject Selkies for this path if

- The exact Tauri webview cannot render the bundled client or decode the server
  stream on either supported architecture; the JPEG path alone misses the
  product's predeclared text/motion/CPU/bandwidth floor.
- The current authenticated local/remote forward cannot carry the single TCP
  WebSocket route and exact-origin check, or the gateway cannot inject Basic
  auth into WebSocket upgrade requests without exposing credentials to the
  webview.
- Native Selkies cannot attach to the same independently supervised Xfce/X11
  display/audio session, or restarting/losing the streamer breaks the session
  or direct in-guest LCU.
- CPU-only software H.264 cannot meet the measured acceptance floor on either
  required guest architecture. GPU support cannot rescue a baseline that must
  run without an assigned guest GPU.
- Silo requires a supported/maintained embeddable component API rather than
  hosting the upstream-served page, and the spike would require forking or
  reimplementing Selkies' private client protocol.

Do not reject on lack of WebCodecs alone: upstream supplies the JPEG fallback.
Do reject if that fallback is the only way to satisfy a supported platform and
it misses the product's measured floor.
