# Browser desktop delivery: evidence for selection

Research snapshot: 2026-09-22. This is a source review, not a benchmark or a
claim that any replacement runs correctly in Silo. Scope: an existing Ubuntu
24.04 guest, AMD64 and ARM64, CPU rendering/encoding, a persistent shared
desktop, TCP/SSH forwarding, and Silo's macOS WKWebView/Linux WebKitGTK client.
No agent library is a selection constraint.

## Decision supported by the evidence

**TurboVNC + noVNC is the preferred replacement candidate to qualify.** It
combines a maintained CPU-oriented X11 server, published binaries for both guest
architectures, ordinary VNC interoperability, a documented embeddable browser
client, and direct WebSocket transport without a separate websockify process.
**TigerVNC + noVNC + websockify is the distribution-managed alternative.**
There is no measured basis here to say either is faster or more reliable than
KasmVNC. Retain the current implementation until the challenger passes the
same workload and native-WebKit acceptance tests.

This recommendation is an engineering inference from the facts below. It
favors an independently replaceable client/server and a small integration
surface for a 2D desktop. It does not favor VNC for high-motion multimedia.
Selkies is the strongest richer-media challenger, but its current upstream
release is a release candidate of a substantial new architecture. Xpra becomes
more attractive if persistent individual applications are a product requirement;
xrdp/Guacamole becomes more attractive if RDP interoperability or a centralized
multi-protocol gateway is a requirement.

## Auditable criteria

Do not turn vendor adjectives into performance points. Score these independently:

| Criterion | Evidence that earns credit | Evidence still required in Silo |
| --- | --- | --- |
| Hard compatibility | CPU mode, Linux AMD64/ARM64 artifacts, existing-session operation, TCP/browser transport | Boot/install on both exact guest/runtime combinations; session survives viewer disconnect |
| Client integration | Documented browser requirements; public resize, lifecycle, authentication and clipboard interfaces | WKWebView on minimum supported macOS and current macOS; WebKitGTK on supported Linux; keyboard/IME, clipboard, scaling, reconnect |
| Agent access | Documented input/capture/control surfaces and ordinary guest display access | Same pixels/session as human; Unicode, pointer, capture freshness, takeover. A viewer API is not an accessibility tree |
| Maintainability | Stable releases, recent fixes, explicit security reporting/update route, credible downstream use | Named Silo owner for packages and bundled libraries; reproducible upgrade and rollback |
| Dependency burden | Count independently supervised services and separately updated artifacts; inspect actual package manifest | Installed/download bytes, process RSS/PSS, cold startup. One DEB is not one dependency |
| Standards and exit cost | Server works with independent clients; protocol/API documented | Replace client or server without changing guest apps/session semantics |
| Measured efficiency | Same image, workload, resolution, quality target, network and hardware | Idle/busy CPU, host+guest memory, bandwidth, latency percentiles, text accuracy, dropped/stale frames |
| Observed reliability | Repeated reconnect/restart/soak outcomes, failures with denominators | At least a defined multi-hour soak and repeated reconnect/install cycles, including degraded network |

Age 2–5 years, version greater than 1.0, a rewrite, celebrity approval and lack
of popularity are not quality gates. websockify and xrdp still use 0.x version
numbers despite substantial deployment history. Rewrite history earns no
reliability credit without post-rewrite evidence. Open issue/PR counts are not
comparable defect rates.

## Exact release snapshot

Dates below are UTC `published_at` from fresh upstream GitHub API responses
on 2026-09-22, except Apache's own archive. Search-index excerpts were stale in
several cases, notably KasmVNC's new codec release notes. These are upstream
versions, not necessarily Ubuntu Noble versions or installed Silo versions.

| Component | Current release and date | Maintenance evidence and qualification |
| --- | --- | --- |
| KasmVNC | [1.5.0, 2026-07-29](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0) | New video encoding, relative mouse, environment configuration; clipboard crash and monitor fixes. 1.4.0 was 2025-10-22 |
| TigerVNC | [1.16.2, 2026-03-26](https://github.com/TigerVNC/tigervnc/releases/tag/v1.16.2) | Security fix for x0vncserver; the immediately previous 1.16.1 accidentally omitted that fix. Specific release-process failure, not proof the Xvnc workload is generally unreliable |
| noVNC | [1.7.0, 2026-04-28](https://github.com/novnc/noVNC/releases/tag/v1.7.0) | ES-module package; rendered image data released; improved H.264 detection |
| websockify | [0.13.0, 2025-02-12](https://github.com/novnc/websockify/releases/tag/v0.13.0) | Header sanitization and TLS SNI updates; slower release cadence alone does not establish abandonment |
| TurboVNC | [3.3.1, 2026-08-20](https://github.com/TurboVNC/turbovnc/releases/tag/3.3.1) | Active support category; signed artifacts; updates bundled libjpeg-turbo/OpenJDK versions |
| Selkies | [2.0.0rc1, 2026-09-20](https://github.com/selkies-project/selkies/releases/tag/2.0.0rc1) | Release candidate despite Latest badge and API `prerelease:false`; rc0 was 2026-09-12. Multiple named contributors in rc1 |
| Xpra | [6.5.3, 2026-08-18](https://github.com/Xpra-org/xpra/releases/tag/v6.5.3) | Packaging, memory and display fixes; parallel 5.1.x maintenance |
| Xpra HTML5 | [20, 2026-03-18](https://github.com/Xpra-org/xpra-html5/releases/tag/v20) | Keyboard mapping, decoder failures, Unicode clipboard, dragging and file-upload fixes |
| xrdp | [0.10.6.1, 2026-07-07](https://github.com/neutrinolabs/xrdp/releases/tag/v0.10.6.1) | Release notes dated July 6; fixes 10 vulnerabilities plus a regression. Do not compare CVE counts without exposure and disclosure context |
| xorgxrdp | [0.10.5, 2026-01-28](https://github.com/neutrinolabs/xorgxrdp/releases/tag/v0.10.5) | Chrome pointer-detection fix |
| Apache Guacamole | [1.6.0, 2025-06-22](https://guacamole.apache.org/releases/) | Apache's current stable release; separate server/client and protocol dependencies |

## Stack facts and boundaries

### TurboVNC + noVNC

TurboVNC provides [3.3.1 AMD64 and ARM64 DEBs](https://github.com/TurboVNC/turbovnc/releases/expanded_assets/3.3.1).
These complete packages are about 43 MB and 42 MB respectively, not an installed
server-only size or a comparison with another stack's package closure.
Its [3.0 change log](https://github.com/TurboVNC/turbovnc/blob/3.3.1/ChangeLog.md)
documents direct WebSocket/WSS support on the RFB port and an optional noVNC
static-file server. Therefore **websockify is optional, not an inherent
TurboVNC dependency**. Silo can serve noVNC assets itself and proxy the WebSocket.
Using the browser client does not require running TurboVNC's Java viewer.

The [official OS support policy](https://turbovnc.org/Documentation/OSSupport)
explicitly covers publicly updated Ubuntu LTS on AMD64/ARM64 with
GNOME/MATE/Unity/Xfce and commits to per-release compatibility/performance
regression testing. Its [compatibility table](https://turbovnc.org/Documentation/Compatibility32)
lists Ubuntu 24.04 Xfce 4.18 and MATE 1.26 without known issues; GNOME 46 carries
workarounds and an accelerated-rendering recommendation. This is upstream
qualification of those combinations, not Silo qualification. LXQt and Plasma
are outside the policy's fully supported Ubuntu desktop list.

The [project describes](https://turbovnc.org/About/Introduction) adaptive Tight
encoding, JPEG compression and compatibility with other VNC implementations.
Its numerical performance claims are vendor measurements on other workloads;
they do not establish Silo performance. The
[Open OnDemand requirements](https://osc.github.io/ood-documentation/latest/how-tos/app-development/interactive/setup/software-requirements.html)
specify TurboVNC and websockify for interactive desktops. This is concrete
downstream dependence, not a claim that Open OnDemand uses the direct-WebSocket
path or that its workload matches Silo.

Tradeoff: upstream binary ownership, bundled-library updates and a funding model
based on [community sponsorship](https://github.com/TurboVNC/turbovnc/blob/3.3.1/README.md)
require an explicit maintenance plan. Release notes identify D. R. Commander;
that is maintainer-concentration evidence, not a verified bus-factor count.
Do not award a reliability advantage for one fewer process without measuring.
The [security policy](https://github.com/TurboVNC/turbovnc/security/policy)
specifies proactive fixes for supported branches and private reporting with an
optional GPG-encrypted email. There are documented
[DEB signature checks](https://turbovnc.org/Downloads/DigitalSignatures) and an
[upstream APT update repository](https://turbovnc.org/Downloads/YUM). This is
stronger operational evidence than a recent commit alone; upstream APT is still
distinct from Ubuntu maintaining the package.

### TigerVNC + noVNC + websockify

[TigerVNC](https://tigervnc.org/) has distribution integration and a conventional
RFB server/client boundary. Its TLS and advanced authentication support must
not be conflated with the browser's authentication capabilities. With the
ordinary TigerVNC TCP server, [noVNC requires a WebSocket bridge](https://github.com/novnc/noVNC/blob/v1.7.0/README.md);
websockify supplies this and optional static serving. It is a byte transport
bridge, not a video transcoder.

The benefit is distribution package/update integration and independently
replaceable pieces. The cost is an additional Python service, configuration,
health check and update surface. A Noble package can be supported with backports
while having a lower upstream version; verify its security status instead of
equating an older version number with an unpatched build.

### Shared noVNC client facts

The [1.7.0 README](https://github.com/novnc/noVNC/blob/v1.7.0/README.md) lists
Safari 15 among known minimum versions, Unicode clipboard, resizing/scaling,
Tight/ZRLE/JPEG/H.264 and other encodings. It names Cendio core maintainers and
OpenStack/OpenNebula/ThinLinc integrations. Safari support is stronger evidence
than a Chromium-only requirement, but **Safari is not a WKWebView or WebKitGTK
qualification result**.

The [public RFB API](https://novnc.com/noVNC/docs/API.html) has connection events,
credential handling, scaling versus server resizing, view-only, clipboard,
keyboard and framebuffer capture methods. Its published method list has no
public pointer-send method. It is a good viewer integration API, **not a
complete documented agent-control API**. RFB itself transports pointer input;
guest-local automation can access the same X11 session independently.

Both endpoints must negotiate an encoding. noVNC supporting H.264 does not make
TigerVNC or TurboVNC send H.264. Nor does it confer the optimized native client's
decoder behavior on a browser. Benchmark each actual server/client pair and
record the encoding selected, not just the requested codec or project feature
list. noVNC's quality/compression settings explicitly expose CPU/bandwidth
tradeoffs. Framebuffer exports reflect received pixels and can be stale or lossy.

### KasmVNC

KasmVNC combines its X server, web serving, streaming protocol and client. The
[tagged README](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/README.md)
explicitly says it diverges from standard RFB and cannot use ordinary VNC clients.
It has standalone Noble packages on both architectures and deployment in Kasm
Workspaces. Its API documents [screenshots, users/permissions, sessions and
clipboard-related operations](https://docs.kasmvnc.com/docs/developer_api).
This management surface is not a semantic application API.

**Do not repeat the stale claim that 1.5.0 has no H.264.** Current
[release notes](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0) add
H.264/H.265/AV1. The tagged
[EncoderProbe.cpp](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/common/rfb/encoders/EncoderProbe.cpp)
lists software H.264/H.265 and hardware H.264/H.265/AV1; software AV1 entries are
commented out. Tagged [EncodeManager.cxx](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/common/rfb/EncodeManager.cxx)
enables KasmVideo only when FFmpeg is available. The README's H.264 “Future
Goals” bullet is stale. A codec's source presence does not prove that the
installed guest libraries and native viewer can negotiate it.

The [client support documentation](https://docs.kasmvnc.com/docs/clientside)
prefers Chromium and explicitly excludes direct Safari connections because of
WebSocket Basic Auth. Silo's existing proxy injects upstream Authorization,
so this is **not an automatic Silo disqualification**. It remains a reason to
test the exact native WebKit path rather than infer support from Chrome.
The [video-mode documentation](https://docs.kasmvnc.com/docs/video_streaming_mode)
labels Safari WebCodecs support partial. Existing packaging convenience and
integration investment are real switching costs, not performance evidence.

### Selkies

The current [2.0 rc0 announcement](https://github.com/selkies-project/selkies/releases/tag/2.0.0rc0)
describes a new single Python application with bundled client and Rust
pixelflux/pcmflux extensions; GStreamer is removed from this runtime. The
[component documentation](https://docs.selkies.io/latest/component/) specifies
Ubuntu 24.04 DEBs for x86_64/aarch64, CPU encoding, default one-port WebSockets,
optional WebRTC, and a striped JPEG fallback when WebCodecs is unavailable.
Thus GPU-only, UDP-only and container-only exclusions are false for 2.0.

[LinuxServer.io documents](https://docs.linuxserver.io/selkies/) deployment in
Webtop, Chromium, Firefox and over one hundred application containers, with
audio, file transfer, clipboard, sharing, damage tracking and static-screen
paint-over. This proves substantial ecosystem usage, not reliability of the
two-day-old rc1 or the exact standalone package/WebKit combination. Historical
GStreamer releases and LinuxServer's rolling stack must not be treated as the
same tested artifact as upstream 2.0. Fresh upstream release/tag APIs listed
only rc0/rc1 on the research date; older search-cached 1.6.1 pages are not proof
of a currently maintained stable fallback.

The [development documentation](https://github.com/selkies-project/selkies/blob/2.0.0rc1/docs/development.md)
explains that an RC can deliberately receive the Latest designation. Assess it
as an RC regardless of that badge. The
[licensing inventory](https://docs.selkies.io/latest/licensing/) is unusually
explicit: MPL application, native extensions and vendored code, with GPL codec
components in default distributions. This is good inventory documentation and
also demonstrates that a single service has a substantial dependency tree.

### Xpra + HTML5

Xpra supports persistent remote applications, full desktop sessions and
shadowing; it is not limited to single-window forwarding. Its
[usage documentation](https://github.com/Xpra-org/xpra/blob/v6.5.3/docs/Usage/README.md)
separates these modes. The [HTML5 client](https://github.com/Xpra-org/xpra-html5)
uses the server's built-in web server and has documented connection options.
It avoids a separate RFB bridge but brings Xpra's protocol, Python server,
native dependencies and codec configuration. The
[upstream package instructions](https://github.com/Xpra-org/xpra/wiki/Download)
include Noble repositories. Native-client capabilities and codec support must
not be credited automatically to HTML5. Browser integration, package closure
on both architectures and exact text/video quality remain qualification work.

### xrdp + xorgxrdp + Guacamole

[xrdp](https://github.com/neutrinolabs/xrdp/blob/v0.10.6.1/README.md) supplies RDP,
TLS, reconnect/resizing and text/image/file clipboard; audio requires additional
modules. x86 and ARM are mature targets, while some SIMD optimizations are
x86-specific. xrdp alone is not a browser viewer.

[Guacamole's architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
adds a browser client, web application/tunnel, guacd, and the RDP library/backend
before reaching xrdp/xorgxrdp. The shipped web application uses Java; a custom
tunnel integration can replace that application, but not erase the protocol
gateway work. The [JavaScript API example](https://guacamole.apache.org/doc/gug/writing-you-own-guacamole-app.html)
documents mouse and key sending explicitly. RDP server feature support is not
proof of end-to-end browser feature support through the translator.

Apache's [security page](https://guacamole.apache.org/security/) supplies a
reporting contact, affected/fixed versions and specific mitigations; 1.6.0 fixes
a guacd terminal-code issue. The 1.x application retains AngularJS with documented
security analysis. This is visible maintenance practice, not a clean-bill-of-health
score. This stack's integration breadth exceeds Silo's current one-desktop need.

## Licensing, security and performance interpretation

KasmVNC's [license](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/LICENSE.TXT)
and TurboVNC's [README](https://github.com/TurboVNC/turbovnc/blob/3.3.1/README.md)
identify GPLv2 licensing; noVNC and Xpra HTML5 identify MPL2 in their linked
repositories. Inventory exact distributed server, client and codec artifacts;
a project-level license label is not the license closure of a package. No legal
opinion or patent clearance is established by this note.

Security should be assessed by authentication boundaries, listener exposure,
credential storage, explicit vulnerability handling, fix/update cadence and
artifact verification. Native RFB interoperability does not itself provide
encryption; TLS/WSS/SSH and appropriate authorization still matter. Conversely,
an extra gateway is not automatically insecure. Count exposed and independently
updated components, then test the actual configuration.

Lossless/RGB paths and lossless refresh are useful for small colored text;
lossy image/video encodings can reduce bandwidth while changing pixels.
Hardware acceleration is irrelevant unless the guest actually exposes it.
CPU encoding, dirty-region tracking, decode cost and network latency interact.
Vendor claims of 60 FPS or percentage CPU savings are hypotheses, not comparable
scores. Measure equal perceptual/text quality and include client CPU, rather
than rank codecs by FPS alone.

SPICE HTML5 remains an explicitly [limited browser client](https://www.spice-space.org/spice-html5.html)
and requires a SPICE server/display integration that this research has not
established in Silo's runtime. It is not a drop-in guest service replacement.
[Sunshine](https://github.com/LizardByte/Sunshine) streams to Moonlight and offers
software encoding; its browser UI configures and pairs clients.
[Moonlight](https://moonlight-stream.org/) supplies the streaming clients.
Qualify this architecture only if Silo changes its embedded-browser and
transport requirements.
Neither should silently earn a score for capabilities absent from the proposed
Silo integration.

**Next action:** qualify TurboVNC 3.3.1 + noVNC 1.7.0 against KasmVNC 1.5.0 on the
same fixed desktop, recording actual encoding, text fidelity, p50/p95 input-to-paint,
CPU/RSS, bandwidth, reconnect outcomes and native-WebKit failures; keep Selkies
2.0 RC as a separately labeled multimedia experiment.
