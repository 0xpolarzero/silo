# Linux desktop streaming engines for Silo

Research snapshot: 2026-09-27. This report compares upstream capabilities and
release artifacts for an interactive Linux desktop embedded in Silo's macOS and
Linux Tauri webviews. Silo runs Ubuntu 24.04 guests on ARM64 and AMD64; a guest
GPU is not guaranteed. This is a selection recommendation, not a performance,
reliability, WebKit compatibility, or licensing opinion based on a completed
Silo integration.

## Decision

**There is no evidence-based winner. Compare Selkies 2.0.0, KasmVNC 1.5.0,
TurboVNC 3.3.1 with noVNC 1.7.0, and Sunshine 2026.914.233613 with Moonlight
PC using clients that each stack officially supports.** Use a current stable
Chromium browser on macOS and Ubuntu 24.04 x86_64/ARM64 as the common web-client
baseline for browser-capable servers. Test Moonlight PC as its own native
client path on macOS and Linux. Select a product stack only after comparing
text, motion, input, files/clipboard, session reuse, transport behavior and
deployment/licensing cost in the matching client class. Selkies is a strong
browser challenger for software-only motion and GPU-assisted streaming because
it supports CPU encoders, 4:4:4-aware codec negotiation, WebSockets and WebRTC,
and current Ubuntu 24.04 packages on both architectures. TurboVNC plus noVNC is
the standards-based text and client-replacement challenger. Sunshine/Moonlight
is a credible GPU/high-motion native specialization; its lack of a web client
does not disqualify it if Silo accepts a native viewer.

Moonlight's official FAQ says there is no pure web client because the protocol
needs raw TCP/UDP sockets that browsers do not expose. That constrains the
client architecture; it does not disqualify the stack. Wolf remains an
additional candidate for multi-user, on-demand GPU desktops in containers. SPICE
is relevant when Silo owns a QEMU SPICE display/device; its HTML5 client is a
separate option to qualify.

No upstream throughput, FPS, latency, CPU, or bandwidth statement below is
treated as a Silo measurement. In particular, Selkies' published 1080p/60 FPS
software-CPU statement is an upstream claim with a different or unspecified
workload; it is not a comparable 2.0.0 benchmark. The next section specifies a
test that can reject this recommendation.

## Shortlist and disqualifiers

| Candidate | Fit for Silo | Main advantage | Disqualifier or unresolved cost | Recommendation |
| --- | --- | --- | --- | --- |
| **Selkies 2.0.0** | Browser server/client, one TCP port by default; optional WebRTC; Ubuntu 24.04 x86_64/aarch64 packages; CPU and GPU paths | Modern media path, explicit codec and 4:4:4 negotiation, configurable TCP/WebRTC behavior, X11 and headless Wayland | Final release is four days old at snapshot; browser codec/input behavior needs qualification; dependency and codec-license closure needs packaging review | **Browser streaming candidate** |
| **KasmVNC 1.5.0** | Ubuntu 24.04 x86_64/aarch64 packages; browser-native viewer; Xvnc session | Lossless/RFB modes plus H.264/H.265/AV1 video mode; Chromium is its documented preferred browser path | Modified RFB reduces client interoperability; 4:4:4 behavior for its video path is not established by the reviewed upstream docs; complete package/license review needed | **Browser streaming candidate** |
| **TurboVNC 3.3.1 + noVNC 1.7.0** | X11 desktop with two-architecture Ubuntu support; browser RFB client; server supports direct WebSocket/WSS | Mature standard RFB boundary, CPU-oriented image/region encoding, public noVNC embedding API; optional websockify | Adds a separately versioned client/server integration; browser path does not inherit native TurboVNC performance; high-motion video is not its main advantage | **Text/compatibility candidate** |
| **TigerVNC 1.16.2 + noVNC 1.7.0 + websockify 0.13.0** | Conventional RFB server and browser client | Distribution integration and replaceable standard parts | Separate WebSocket bridge; GPL-2.0 server; x0vncserver is for sharing an existing X display and is documented as inefficient; use Xvnc for a virtual desktop | **Fallback where distro packages win** |
| **Sunshine 2026.914.233613 + Moonlight PC** | GPU-backed host, native client on macOS/Linux, software encoder also available | Game-streaming transport and mature native decoder; 4:4:4 documented for Moonlight PC; AMD/Intel/NVIDIA encoding paths | No pure web client; native GPL-3.0 host/client path; text, file transfer and clipboard workflow must be compared with browser viewers; VM display and GPU access need qualification | **GPU/high-motion native candidate** |
| **Wolf + Moonlight** | Multi-user, on-demand container desktops with GPUs | Purpose-built for headless virtual desktops, multiple users/GPUs, gamepad streaming | Wolf explicitly points general-purpose users to Sunshine; Linux/Docker-first architecture adds a distinct deployment model; compare operational fit and its MIT license separately | **Multi-user GPU candidate** |
| **SPICE + virt-viewer or spice-html5** | QEMU with a SPICE display device and guest agent | Protocol designed for VM display, clipboard and device channels | Requires SPICE display/device and client support; spice-html5 is a distinct browser client, not an embedding drop-in; no evidence here of exact runtime integration or modern browser performance | **QEMU-native candidate** |
| **Xpra 6.5.3 + HTML5 client 20** | Persistent desktop/app sessions over built-in web server; Ubuntu packages | Can forward individual apps or a full desktop and has an HTML5 client | More protocol/session surface than Silo needs; browser codecs and guest ARM64/package closure need qualification | **Reserve for app-forwarding requirements** |
| **xrdp 0.10.6.1 + xorgxrdp + Guacamole 1.6.0** | Standard RDP server translated to browser Guacamole protocol | Apache-2.0 gateway and public browser interaction API; useful if RDP interoperability is a product requirement | More processes and protocol translation; the browser client does not directly speak RDP; greater deployment/integration footprint than one guest desktop | **Reject without an RDP requirement** |

Use current stable Chromium on macOS and Ubuntu 24.04 x86_64/ARM64 as the
common browser baseline for Selkies, KasmVNC and noVNC. Record exact browser
versions and codec negotiation. Add each product's supported native client as
another client option where available; Sunshine/Moonlight is specifically a
native-client comparison. noVNC is the viewer; TigerVNC/TurboVNC are server
choices. Do not assume that noVNC's H.264 support makes the server negotiate
H.264. Record the encoding actually negotiated by each exact pair.

## What is supported upstream

### Selkies 2.0.0

The final [2.0.0 release](https://github.com/selkies-project/selkies/releases)
was published 2026-09-23. Its release notes list native DEBs for Ubuntu 24.04
and 26.04 and Debian Bookworm/Trixie on x86_64 and aarch64, plus RPMs, Alpine,
Arch x86_64, AppImages and multi-architecture container images. The Ubuntu
24.04 ARM64 and AMD64 package names are first-party release artifacts; do not
infer this support from the old GStreamer containers. Native packages install a
private Python environment and attach to an existing display/audio server.
They do not include the desktop or display server.

The [2.0 release notes](https://github.com/selkies-project/selkies/releases)
describe a single Python service with Rust `pixelflux` screen capture/encoding
and `pcmflux` audio encoding. Default WebSockets put display, audio, input,
clipboard and file transfers on one TCP port and decode with WebCodecs, with
striped JPEG fallback. WebRTC is opt-in, can constrain ports or use one shared
TCP/UDP port, and supports ICE-lite; dual-mode can switch transports during a
session. The [native-install guide](https://github.com/selkies-project/selkies/blob/2.0.0/docs/native.md)
describes attaching to an already-running session. The [component reference](https://github.com/selkies-project/selkies/blob/2.0.0/docs/component.md)
lists H.264, H.265, VP8, VP9 and AV1 where available, with software fallbacks,
and says the server advertises which encoder paths carry 4:4:4. It explicitly
notes that OpenH264 and kvazaar software paths are 4:2:0 only. This makes codec,
pixel format and client decoder a runtime result that must be captured in the
test; the list of advertised codecs is not proof that Silo will negotiate 4:4:4.

Selkies' [MPL-2.0 development notice](https://github.com/selkies-project/selkies/blob/2.0.0/docs/development.md)
allows a larger proprietary application to embed it, while modified MPL-covered
files distributed externally remain subject to MPL source-availability terms.
The project documents software encoder build variants: default x264/x265 GPL
components versus a GPL-free build using OpenH264/kvazaar; other encoders have
their own license terms. Audit the actual release artifact and bundled codec
libraries before shipping. Selkies 2.0 being final removes the RC disqualifier
from the earlier September 22 research, but its architecture is new and the
final release had only four days of release history at this snapshot. Do not
assign reliability credit until it has survived Silo's soak and reconnect tests.

**Session reuse is a separate qualification gate.** The [2.0.0 native install guide](https://github.com/selkies-project/selkies/blob/2.0.0/docs/native.md)
says the native package attaches to an existing X.Org display and existing
PulseAudio or PipeWire-Pulse server, and says an already-running Wayland
session cannot be captured. However, the [current component documentation](https://github.com/selkies-project/selkies/blob/main/docs/component.md)
describes a container path that captures a host Wayland compositor using
screen-copy protocols or xdg-desktop-portal, with consent where the portal asks
for it. Upstream documentation therefore conflicts or describes different
build/configuration paths. Treat capture of an existing Wayland seat by the
exact native 2.0.0 artifact as **unknown**, and prove it before relying on it.
`selkies-session` creates its own Xvfb (or Selkies' own headless Wayland
compositor when enabled), starts a desktop, then starts the streamer. That is a
separate desktop session, not a viewer attached to an existing Wayland desktop.
Silo's current Xfce/X11 session is the clearest reuse case; the selected
integration must share its DISPLAY, audio server, D-Bus and user session rather
than accidentally launching a second desktop.

**GPU acceleration is conditional on the VM boundary.** Selkies software
encoding works without a guest GPU. NVENC/VA-API encoding and Wayland dmabuf
capture require the matching driver/render device to be visible to the process.
The component docs describe zero-copy on Wayland when its compositor renders to
GPU buffers, and an NVIDIA NvFBC path on X11; ordinary X11 capture copies once
through shared memory. Some X11/DRI3 paths can retain GPU buffers, but none of
these claims applies merely because the host has a GPU. Silo must first prove
that a supported device reaches the guest. On a CPU-only VM, compare the X11
software path and do not count a GPU-only optimization in the selection.

Use a current stable Chromium browser as the common browser-client baseline:
Google Chrome on macOS and Chromium on Ubuntu 24.04 x86_64 and ARM64. Record
the exact build and codec APIs available in each run. Selkies' default uses
WebCodecs; its JPEG fallback does not establish comparable text sharpness,
bandwidth or latency. WebRTC uses the browser's RTP codec implementation and
ICE/network APIs. Treat WKWebView and WebKitGTK as optional native-embed client
comparisons if Silo wants them; they are not adoption gates for this
unconstrained selection. If selected, test the exact shipped builds and record
their negotiated codecs and pixel formats.

### KasmVNC 1.5.0

[KasmVNC 1.5.0](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0) has
separate Noble ARM64 and AMD64 packages. The
[tagged release notes](https://docs.kasmvnc.com/docs/release_notes/1.5.0)
document the current release; the [video streaming guide](https://docs.kasmvnc.com/docs/video_streaming_mode)
describes software and optional VA-API/NVENC H.264/H.265/AV1 paths. A server
with no exposed GPU uses software encoders where installed. Its standard RFB
rectangle path offers lossless and compressed modes; video mode is a separate
full-frame path. These modes should be tested separately because crisp text
and efficient motion can prefer different encodings.

The project's [README](https://github.com/kasmtech/KasmVNC) states that KasmVNC
has diverged from standard RFB and cannot be used with ordinary VNC viewers.
The upstream license is GPL-2.0; the packaged viewer/assets and dependencies
still need a complete distribution inventory. The client docs favor Chromium.
Use Chromium as the browser baseline and test other browser engines only if the
selected product ships them.

### TurboVNC/noVNC and TigerVNC/noVNC

[TurboVNC 3.3.1](https://github.com/TurboVNC/turbovnc/releases/tag/3.3.1)
publishes x86_64 and ARM64 packages. Its [Ubuntu support policy](https://turbovnc.org/Documentation/OSSupport)
covers Ubuntu LTS on both architectures and names Xfce among supported desktop
environments. The [3.0 change log](https://github.com/TurboVNC/turbovnc/blob/3.3.1/ChangeLog.md)
documents direct WebSocket/WSS support on the RFB port, so websockify is
optional for this server. [noVNC 1.7.0](https://github.com/novnc/noVNC/releases/tag/v1.7.0)
has a public [RFB embedding API](https://github.com/novnc/noVNC/blob/v1.7.0/docs/API.md)
for connection lifecycle, credentials, resizing/scaling, clipboard, keyboard
and framebuffer events. Its license is MPL-2.0 with additional assets under
their listed licenses. The API is useful for a human viewer; it is not a
semantic UI automation API.

[TigerVNC 1.16.2](https://github.com/TigerVNC/tigervnc/releases/tag/v1.16.2)
is maintained and identifies a security fix in the preceding 1.16.1 release
that was accidentally omitted. The [project README](https://github.com/TigerVNC/tigervnc)
describes `Xvnc` as an X server plus virtual framebuffer, `x0vncserver` as an
inefficient polling server mainly intended as a demonstration, and `w0vncserver`
as a Wayland server. For Silo's fresh virtual X11 desktop, evaluate `Xvnc`, not
`x0vncserver`. TigerVNC is GPL-2.0. A normal TigerVNC server needs
[websockify](https://github.com/novnc/websockify) to bridge RFB TCP to
WebSockets; this extra bridge is not a media encoder.

TurboVNC and TigerVNC are serious candidates for a mostly static developer
desktop, but their high-motion behavior must be measured against video modes.
Native viewer performance data does not predict noVNC running inside Chromium.

### Sunshine, Moonlight, Wolf, SPICE, and other alternatives

[Sunshine](https://github.com/LizardByte/Sunshine) supports AMD, Intel and
NVIDIA hardware encoders and has a software encoder. The September 2026 release
is `2026.914.233613`; its Linux releases include x86_64 and ARM64 artifacts.
The [official Linux capture/encoder table](https://github.com/LizardByte/Sunshine)
documents X11, KMS/DRM, portals and KWin capture paired with software, VAAPI,
NVENC or Vulkan encode on supported paths. [Moonlight PC](https://github.com/moonlight-stream/moonlight-qt)
supports macOS/Linux, H.264/HEVC/AV1, hardware decode, and YUV 4:4:4 with
Sunshine. Its official [FAQ](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions)
says it has no pure web client because GameStream needs raw TCP/UDP sockets.
The host and client are GPL-3.0. Sunshine is therefore attractive only if Silo
is prepared to ship a native client or own a native integration, a different
session/display-capture path and GPU handling. The web UI is for pairing and
configuration, not desktop rendering.

[Wolf](https://github.com/games-on-whales/wolf) describes itself as a
Moonlight streaming server for sharing one server among users, creating
headless desktops on demand, and splitting work across GPUs. It says it is
Linux/Docker-first and explicitly recommends Sunshine for general-purpose
streaming. This is strong evidence for a GPU-backed multi-user container
streaming product, not for adding Docker/GPU assumptions to each ordinary Silo
VM.

[SPICE](https://www.spice-space.org/) is a VM display protocol with display,
input, clipboard, audio and device channels, best integrated where Silo owns a
QEMU SPICE display. The [spice-html5 project page](https://www.spice-space.org/spice-html5.html)
identifies a browser client, but it is a separate component and not evidence of
current WKWebView/WebKitGTK quality. The upstream [protocol specification](https://www.spice-space.org/static/docs/spice_protocol.pdf)
documents video-stream commands. Compare it only if the selected VM runtime
exposes a supported SPICE server/display device; avoid layering it on a separate
X11 capture path.

[Xpra 6.5.3](https://github.com/Xpra-org/xpra/releases/tag/v6.5.3) and
[HTML5 client 20](https://github.com/Xpra-org/xpra-html5/releases/tag/v20)
are active alternatives for persistent apps or desktop sessions. Xpra's
[usage guide](https://github.com/Xpra-org/xpra/blob/v6.5.3/docs/Usage/README.md)
distinguishes app forwarding, desktop, and shadow modes. Its wider session
model is valuable if Silo needs individual app forwarding; it adds complexity
for a single persistent guest desktop.

[xrdp 0.10.6.1](https://github.com/neutrinolabs/xrdp/releases/tag/v0.10.6.1)
with xorgxrdp is a credible Linux RDP endpoint. [FreeRDP](https://github.com/FreeRDP/FreeRDP)
is Apache-2.0, but a browser still needs a translator. [Apache Guacamole](https://github.com/apache/guacamole-server)
uses `guacd` to translate VNC/RDP into its browser protocol and documents a
JavaScript API. Its architecture and security process are mature; the gateway,
web application and protocol libraries create an unnecessarily broad stack
unless interoperability with RDP is itself a requirement.

## Quality and threat-model implications

**Text and color:** screen text quality depends on the path selected for mostly
static changes, the encoder's chroma format, the browser's decoder and scaling.
H.264 video can smear colored glyph edges under 4:2:0 even when moving content
looks efficient. Selkies explicitly reports 4:4:4 availability and has codecs
that can retain it; its GPL-free H.264/H.265 software paths do not. KasmVNC
documents lossless RFB and video modes, but the reviewed docs do not establish
4:4:4 for its video path. TurboVNC/noVNC can use lossless/region encodings. Test
colored text, code syntax, subpixel antialiasing, terminal scrolling and DPI
scaling from captured decoded pixels; do not score by codec name.

**Motion, CPU and bandwidth:** with no guest GPU, server encoding consumes VM
CPU. The appropriate first comparison is software-only on both architectures,
at fixed image quality and screen size. Then test a GPU-backed configuration
only where Silo can actually expose a supported encoder device to that Linux
guest or host. Host GPU presence alone is insufficient. WebRTC can recover from
loss and congestion differently from WebSockets, while adding ICE/UDP and
firewall complexity; measure both on lossy/WAN profiles and verify the real
ports. Do not infer lower latency from the protocol label.

**Embedding and security:** keep media services on loopback or an owned
SSH-forwarded tunnel, use authenticated Silo-owned endpoints, and reject direct
guest-port exposure. Selkies supports localhost listening by default and
configurable basic auth/TLS; its public-listener option must not be used without
an explicit authenticated TLS boundary. Sunshine uses PIN pairing and a
separate configuration web UI, but its stream transport cannot be put into a
browser just by opening that UI. Standard RFB also needs a protected transport;
the viewer, server and bridge must agree on authentication and TLS. SPICE
requires the same tunnel/credential scrutiny. Validate clipboard, file transfer,
key injection, reconnect authorization, cross-origin controls and listener
binding as part of the security review. These upstream properties do not make
any one deployment safe by default.

**Licensing:** Selkies is MPL-2.0 plus an explicit inventory of third-party
components; default codec builds include GPL components. KasmVNC and TigerVNC
are GPL-2.0. noVNC is MPL-2.0 plus separately licensed assets. Sunshine and
Moonlight are GPL-3.0. FreeRDP is Apache-2.0. For each selected release, record
actual packaged libraries, codecs, notices, source offers and patents separately;
repository-level license labels are not the license closure of the final Silo
bundle. No legal or codec-patent clearance is established here.

## Falsifiable qualification plan

Compare **KasmVNC 1.5.0**, **Selkies 2.0.0 (WebSockets and WebRTC)**, and
**TurboVNC 3.3.1 + noVNC 1.7.0** in current stable Chrome on macOS Apple
Silicon and Chromium on Ubuntu 24.04 x86_64 and ARM64. Add **Sunshine
2026.914.233613 + Moonlight PC** as a separate native-client route on macOS and
Linux; evaluate Wolf with Moonlight only if multi-user container sessions are
in scope. Use the same clean Ubuntu 24.04 ARM64 and AMD64 guest image,
Xfce/X11 session, fixed 1440×900 desktop, fonts and test applications. Lock all
candidate server encoders to software for the first pass. Then repeat only on
a host/guest path where the encoder device is visibly available inside the
guest; label GPU vendor, driver, capture method, encoder, pixel format and
negotiated codec.

Use scripted repeatable states: static code editor with fine colored glyphs,
fast terminal scroll, resize/move/minimize, pointer motion and clicks, 1080p
video, browser animation, clipboard text/Unicode/image, idle, viewer disconnect
and reconnect. Capture local guest source frames and client-decoded frames.
Use OCR on a fixed glyph corpus and pixel/chroma edge comparisons for text;
record actual encoder format and WebRTC/WebCodecs codec negotiation.

For Selkies, test both attaching to the existing Xfce/X11 session and its
`selkies-session` path, which creates its own desktop. Verify whether the same
window, process, clipboard and audio session remain visible through viewer
close/reopen in the attach configuration. Do not count the separate session as
proof that an existing Wayland seat can be shared. For Sunshine/Moonlight,
verify full-desktop capture, text and Unicode input, pointer behavior, audio,
clipboard/file workflows, reconnect and session persistence; gamepad and
high-motion strengths do not prove those desktop workflows. If the product
requires an embedded client, separately measure WKWebView and WebKitGTK;
otherwise use Chromium as the browser acceptance path.

Measure guest and host CPU by process and total, RSS/PSS, transferred bytes,
rendered frame age, frame drops, and input-to-visible-paint p50/p95 from a
timestamped trigger and captured client frame. Repeat over loopback, 10 ms
added RTT, 50 ms RTT, and a controlled packet-loss profile. Run 100 scripted
reconnect cycles and a 12-hour session soak per architecture/transport. Keep
raw results and exact package hashes with the test run.

Reject a candidate only for a defined product requirement it fails, such as an
unsupported shipped client, inadequate text fidelity, missing clipboard/file
workflow, unacceptable input latency, or failed reconnect target. At a fixed
text OCR score and decoded quality, favor Selkies only if it reduces median
software CPU or WAN bandwidth by at least 20% versus the browser-RFB control
without worsening p95 input-to-paint by more than 10% or creating an unrecovered
reconnect in 100 attempts. Favor TurboVNC/noVNC only if it improves text OCR by
at least 2 percentage points or reduces idle CPU by at least 15% while meeting
the same input/reconnect gates. Favor Sunshine/Moonlight for a native GPU path
only if its motion latency or bandwidth improvement exceeds the browser
candidates by a predeclared product threshold and it passes the same desktop
workflow checks; account for a separately packaged native client. These are
proposed decision thresholds, not measured results. Record baseline values
before running and do not change thresholds after seeing results. Multiple
stacks may serve distinct workloads; this research does not name a winner.

**One action:** run the same-workload browser and native-client bakeoff on
ARM64 first, then AMD64, before choosing the supported remoting stack.

## Primary sources

- [Selkies 2.0.0 release and release artifacts](https://github.com/selkies-project/selkies/releases)
- [Selkies 2.0 native install](https://github.com/selkies-project/selkies/blob/2.0.0/docs/native.md)
- [Selkies 2.0 components, codecs and licenses](https://github.com/selkies-project/selkies/blob/2.0.0/docs/component.md)
- [Selkies MPL notice](https://github.com/selkies-project/selkies/blob/2.0.0/docs/development.md)
- [KasmVNC 1.5.0 release](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0)
- [KasmVNC video streaming mode](https://docs.kasmvnc.com/docs/video_streaming_mode)
- [KasmVNC project and license](https://github.com/kasmtech/KasmVNC)
- [TurboVNC 3.3.1 release](https://github.com/TurboVNC/turbovnc/releases/tag/3.3.1)
- [TurboVNC supported operating systems](https://turbovnc.org/Documentation/OSSupport)
- [noVNC 1.7.0 release](https://github.com/novnc/noVNC/releases/tag/v1.7.0)
- [noVNC embedding API](https://github.com/novnc/noVNC/blob/v1.7.0/docs/API.md)
- [TigerVNC 1.16.2 release](https://github.com/TigerVNC/tigervnc/releases/tag/v1.16.2)
- [Sunshine release](https://github.com/LizardByte/Sunshine/releases)
- [Moonlight PC client](https://github.com/moonlight-stream/moonlight-qt)
- [Moonlight FAQ, browser-client limitation](https://github.com/moonlight-stream/moonlight-docs/wiki/Frequently-Asked-Questions)
- [Wolf server](https://github.com/games-on-whales/wolf)
- [SPICE HTML5 client](https://www.spice-space.org/spice-html5.html)
- [SPICE protocol specification](https://www.spice-space.org/static/docs/spice_protocol.pdf)
- [Xpra 6.5.3 release](https://github.com/Xpra-org/xpra/releases/tag/v6.5.3)
- [xrdp 0.10.6.1 release](https://github.com/neutrinolabs/xrdp/releases/tag/v0.10.6.1)
- [Apache Guacamole server](https://github.com/apache/guacamole-server)
