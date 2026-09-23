# Desktop and streaming assessment

For the subsequent selection without agent-library constraints, use
[Independent desktop and viewer selection](SiloUI-DESKTOP-SELECTION.md).
That assessment revises the viewer shortlist and distinguishes documented
capabilities from unmeasured performance, reliability and usability.

Research date: 2026-09-22. This is a selection assessment, not a migration or a
claim that alternatives passed Silo acceptance tests.

## Recommendation

**Keep Xfce on native X11 as the supported desktop for current Luda. Retain
KasmVNC provisionally, subject to correcting and verifying the viewer's input
behavior. Use TigerVNC with upstream noVNC as the primary replacement candidate.**
Selkies deserves a separate evaluation for its streaming features, but its
current 2.0 release candidate is too new to inherit a production reliability
claim from older Selkies deployments. LXQt is the resource-efficiency challenger
to Xfce. GNOME and KDE Plasma belong in a longer-term evaluation that includes
a Wayland backend for Luda.

This recommendation follows compatibility and integration evidence. No
controlled comparison establishes the current stack, or a replacement, as
the fastest, smallest, most intuitive or most reliable in Silo.

## What we are selecting

There are separate decisions:

| Layer | Purpose | Current Silo choice |
| --- | --- | --- |
| Desktop environment | Panels, launcher, windows, settings and file manager | Xfce |
| Display system | Windows, screen content and input inside Linux | Native X11 |
| Streaming server and browser client | Send pixels to the human; return keyboard and mouse input | KasmVNC and its modified noVNC client |
| Host viewer | Embed the client and integrate focus, clipboard, scaling and shortcuts | Tauri native webview: WKWebView on macOS, WebKitGTK on Linux |
| Agent interface | Observe applications and perform actions inside the guest | Luda 0.3.4 |

An agent's successful action does not verify human viewer input. Luda can reach
the guest directly while the host webview mishandles clicks or keyboard events.
Likewise, changing desktop themes or window managers does not repair a browser
clipboard integration defect.

The implementation installs Ubuntu 24.04 packages plus KasmVNC 1.5.0 into the
existing VM. It caps streaming at 30 fps. Our required deployment includes
ARM64 and AMD64 guests, existing user data and applications, a shared human/agent
session, and local or SSH-forwarded viewing. Hardware encoding inside the guest
has not been established; a host GPU is not evidence that a guest encoder can
use it. See the [installer](../app/SiloUI/src-tauri/guest/setup-desktop.sh),
[desktop implementation](SiloUI-DESKTOP.md) and [Luda integration](SiloUI-LUDA.md).

## Desktop comparison

The resource descriptions below identify design goals and integration costs,
not measured RAM or latency rankings. Distribution adoption establishes actual
deployment, not comparative usability or defect rates.

| Desktop | UX and ecosystem evidence | Performance and agent implications | Assessment for Silo |
| --- | --- | --- | --- |
| **Xfce** | Traditional launcher, panel and file manager; modular components; established distribution packaging. | Explicit lightweight design. Native X11 and the exact session/window-manager family qualified by current Luda. | **Best-supported choice for today's integration.** No evidence that its desktop is responsible for the confirmed native Paste popup. |
| **LXQt** | Traditional modular desktop built with Qt; distributed by Lubuntu and others; current releases continue UI improvements. | Explicit lightweight design, but savings over our minimal Xfce installation are unmeasured. Luda session discovery and window-manager behavior need qualification. Qt applications use a different input route from Luda's qualified GTK3 route. | **Best resource challenger.** Adopt only for demonstrated savings without losing workflows or agent behavior. |
| **MATE** | Conventional GNOME 2-style desktop and applications; established project and distribution packages. | Native X11 is available. A different session/window manager still needs Luda qualification; no measured advantage over our Xfce package set. | Valid traditional alternative, with no demonstrated reason to pay migration cost now. |
| **Cinnamon** | Linux Mint's principal full-featured traditional desktop; integrated settings and effects. | X11 versions provide a possible integration route. Its desktop shell and application mix need separate resource and agent tests. | Evaluate if user testing identifies a concrete usability advantage; no current Silo performance evidence. |
| **GNOME** | Formal human-interface guidelines and default deployment in Ubuntu, Fedora, Debian and several enterprise distributions. | Strong UX/accessibility infrastructure. GNOME 50 removed native X11 backend/session code; current Luda rejects Wayland. Ubuntu 24.04's older GNOME 46 is a different candidate. | **Strong UX reference and future candidate.** Current upstream direction requires Luda backend work. |
| **KDE Plasma** | Formal design guidelines, extensive desktop integration and customization. | Native X11 remains an option in older/current pre-6.8 releases, but Plasma 6.8 is planned to be Wayland-only. Qt and a different window manager also change Luda qualification. | **Strong full-desktop candidate after compatibility work.** Do not start a new long-term dependency on its retiring X11 session without accepting that cost. |
| **Standalone window managers**, e.g. i3/Openbox | Window arrangement with fewer integrated desktop services; i3 has a documented control interface. | A smaller component set is possible, but Silo must supply and maintain the missing desktop experience. WM control does not provide application semantics. | Suitable for controlled agent appliances; weaker fit for an intuitive general-purpose desktop. |

Sources: [Xfce design](https://www.xfce.org/about),
[Xfce 4.20 release](https://www.xfce.org/about/news/?post=1734220800),
[LXQt design](https://lxqt-project.org/about/),
[LXQt 2.4 release](https://lxqt-project.org/release/2026/04/20/release-lxqt-2-4-0/),
[MATE](https://mate-desktop.org/),
[Mint's desktop comparison](https://linuxmint-installation-guide.readthedocs.io/en/latest/choose.html),
[GNOME deployments](https://www.gnome.org/),
[GNOME HIG](https://developer.gnome.org/hig/),
[GNOME 50 development release changes](https://download.gnome.org/teams/releng/50.alpha/NEWS),
[KDE HIG](https://develop.kde.org/hig/),
[Plasma's X11 retirement](https://blogs.kde.org/2025/11/26/going-all-in-on-a-wayland-future/),
[i3 documentation](https://i3wm.org/docs/).

**Version matters.** Ubuntu 24.04 packages Xfce 4.18, LXQt 1.4 and GNOME Shell
46. Installing those packages does not deliver features demonstrated in current
upstream releases. A newer desktop can entail upgrading the guest distribution
or maintaining backports. Sources: Ubuntu's
[Xfce](https://packages.ubuntu.com/noble/xfce4),
[LXQt](https://packages.ubuntu.com/noble/lxqt) and
[GNOME Shell](https://packages.ubuntu.com/noble/gnome-shell) packages.

**UX conclusion:** GNOME and KDE provide particularly substantial documented
design systems. That supports their inclusion in a UX evaluation, not a claim
that either is universally more intuitive. Silo has no comparative user-task
study. Test opening an app, finding a file, changing a setting, switching windows
and recovering from an error with the intended users.

## Streaming and viewer comparison

| Stack | Documented strengths | Costs and evidence limits | Assessment |
| --- | --- | --- | --- |
| **KasmVNC 1.5.0** | Integrated X server, browser client, authentication and configuration; Noble ARM64/AMD64 packages. This release adds software/hardware H.264, H.265 and AV1 modes. | Modified protocol prevents using an ordinary VNC client as a drop-in replacement. Silo's WKWebView integration has a documented clipboard-detection defect. Neither video-mode performance nor all input paths are qualified in Silo. | **Lowest migration cost.** Keep only with correct input behavior and measured acceptance. |
| **TigerVNC + upstream noVNC** | Standard VNC/RFB ecosystem, native client alternatives, and a documented JavaScript API designed for embedding. Server and viewer can be maintained separately. | Adds a WebSocket bridge and separate component lifecycle. Requires replacement of Kasm's server as well as its browser assets. Features depend on negotiated server/client support; no Silo speed or reliability win has been measured. | **Primary challenger; strongest fit for owning a small custom viewer UI and preserving interoperability.** |
| **Selkies** | Current docs describe single-port WebSocket delivery, optional WebRTC, video encoding and audio. Native Ubuntu 24.04 ARM64/AMD64 packages now exist, so containers are not mandatory. | Latest tagged release is **2.0.0rc1, published September 20, 2026**. Current architecture includes Python/native media components and vendored libraries. WebCodecs, fallback rendering and clipboard/input need embedded-WebKit qualification. | **Streaming-feature challenger.** Evaluate the exact release candidate separately from older deployment history. |
| **xrdp + an RDP client** | Established RDP ecosystem, reconnectable Linux sessions, documented server configuration; usable with native RDP clients. | An embedded native client requires host integration; a browser gateway adds another service. Session creation/reconnection must preserve the desktop used by Luda. | Strong if native RDP interoperability becomes a product requirement; greater change than the two leading options. |
| **Xpra** | Persistent individual applications and full desktop sessions; native and HTML5 clients; audio, clipboard and other desktop integrations. | More capabilities and packaging/integration surface to qualify. No measured resource advantage in Silo. | Best aligned with a future “individual Linux app windows” experience. Full-desktop use is also supported. |

Sources: [KasmVNC 1.5 release](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0),
[Kasm protocol boundary](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/README.md),
[TigerVNC documentation and deployments](https://tigervnc.org/),
[noVNC integration and deployments](https://novnc.com/info.html),
[noVNC API](https://novnc.com/noVNC/docs/API.html),
[Selkies components](https://docs.selkies.io/latest/component),
[Selkies native installation](https://docs.selkies.io/latest/native),
[Selkies release](https://github.com/selkies-project/selkies/releases/tag/2.0.0rc1),
[xrdp](https://github.com/neutrinolabs/xrdp),
[Xpra](https://github.com/Xpra-org/xpra/).

Selkies can attach to an existing **X.Org** display. Its documented headless
Wayland mode owns its compositor; it does not capture an arbitrary existing
Wayland session. Default WebSocket mode fits a TCP tunnel without TURN.
Optional WebRTC has different network requirements. LinuxServer
[Webtop's use of Selkies](https://docs.linuxserver.io/images/docker-webtop/)
establishes deployment precedent, not qualification of the newly released 2.0
implementation or Silo's webviews. The GitHub release API labels `2.0.0rc1` as
non-prerelease, but the tag and current documentation explicitly identify an RC;
this assessment does not call it a final stable release.

Additional options serve different requirements:

- [TurboVNC](https://turbovnc.org/About/Introduction) is a relevant VNC server
  candidate for image-intensive/3D workloads. Its published optimization goals
  do not establish an advantage for Silo's current browser/editor workload or
  for a browser client instead of its native viewer.
- [Apache Guacamole](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
  is a browser gateway to RDP/VNC/SSH. It adds a proxy/protocol layer; it is not a
  desktop environment or a replacement for the guest display server.
- [Sunshine/Moonlight](https://github.com/LizardByte/Sunshine) targets game
  streaming and supports hardware and software encoding. It is worth evaluating
  for a native high-motion client requirement, not assuming it drops into our
  existing webview.
- [SPICE](https://www.spice-space.org/) is another VM display/integration system.
  Adopting it would require proving support in Silo's bundled virtualization and
  client stack; current integration does not establish that support.

**Viewer-host decision:** replacing Tauri's webview with Electron is not a
prerequisite for any of the leading browser options. A native VNC/RDP client
would move input/clipboard handling out of the browser, but introduces its own
platform integration and tests. The current WebKit defect must not be
generalized into a claim that all WebKit delivery is unusable.

## Agent APIs and compatibility

Luda 0.3.4's [documented backend boundary](https://github.com/0xpolarzero/luda/blob/v0.3.4/docs/BACKEND-SUPPORT.md)
rejects native Wayland and Xwayland sessions. Its
[session discovery](https://github.com/0xpolarzero/luda/blob/v0.3.4/src/luda/session.py)
looks for `xfce4-session`; an explicit session PID is an alternative entry point.
Changing to another X11 desktop therefore needs integration and qualification,
not necessarily a new display backend.

Its [background-input contract](https://github.com/0xpolarzero/luda/blob/v0.3.4/docs/BACKGROUND-EXPERIENCE.md)
qualifies independent input for positively identified GTK3 applications and the
tested window-manager setup. Other/unknown toolkits use foreground compatibility
input. A Qt desktop is not categorically unsupported, but it does not inherit
the GTK3 guarantee. Installing GTK apps on LXQt or Qt apps on Xfce also means
the desktop name alone cannot predict agent coverage.

| API need | Relevant interface | What it does not establish |
| --- | --- | --- |
| Observe controls, read text, invoke actions | [AT-SPI](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/); [Qt accessibility](https://doc.qt.io/qt-6/accessible.html) also uses Linux AT-SPI | Complete semantic coverage for every application/custom widget. |
| Control viewer connection, scaling, focus, clipboard and key injection | [noVNC's RFB JavaScript API](https://novnc.com/noVNC/docs/API.html) | An application automation API; it does not expose guest controls as a browser DOM. |
| Configure sessions/streaming | Kasm configuration, Selkies settings, xrdp configuration, Xpra commands | That pixel/input transport gives agents reliable semantic actions. |
| Future Wayland capture/input | [RemoteDesktop portal, PipeWire and EIS/libei](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) | A backend already implemented by Luda, or identical unattended/background behavior across compositors. |

**Agent conclusion:** current Xfce/X11 wins on actual Luda qualification. A
viewer replacement can preserve that foundation, provided its X server exposes
the required extensions and both human and agent attach to the same session.
Long-term desktop choice should revisit Luda's backend restriction rather than
silently equating “X11 today” with “best forever.”

## Performance: what the evidence actually establishes

Silo's September 18 ARM64 warm desktop stop/start test, with no viewer, measured
about **123 MiB less guest MemAvailable** and **233 MiB summed proportional
memory for desktop-user processes**. Those measurements have different meanings;
neither is host RAM cost, active streaming cost or a desktop comparison.
[Recorded method and limitations](SiloUI-DESKTOP.md#verification-2026-09-18).

Kasm publishes a useful **within-product** comparison in its developer docs.
For 1080p full-screen video on an AMD EPYC 7J13, with Medium quality capped at
24 fps, it reports:

| Mode | Reported server CPU | Delivered fps | Bandwidth |
| --- | --- | --- | --- |
| Software H.264 | 74% | 21 | 14.35 Mbit/s |
| JPEG/WebP | 64% | 21 | 33.48 Mbit/s |
| Software H.265 | 230% | 13.2 | 6.53 Mbit/s |

These are vendor measurements, using its CPU percentage convention, not Silo
results or a comparison against noVNC/Selkies. They show why bandwidth, CPU and
frame rate must be considered together. The same page reports a different
bandwidth ordering for its moderate-motion workload. Source:
[Kasm performance methodology and tables](https://docs.kasm.com/docs/develop/reference/kasm-performance).

No reviewed source supplies a current, controlled comparison of the candidate
stacks on Silo's CPU-only ARM64/AMD64 guests and WKWebView/WebKitGTK clients.
Consequently, this assessment does not rank absolute latency, RAM, CPU, image
quality or failure rates. Codec availability and “lightweight” positioning are
insufficient substitutes for that evidence.

## Maintenance and production history

Upstream release metadata checked on September 22:

| Component | Recent release evidence | Interpretation |
| --- | --- | --- |
| KasmVNC | [1.5.0, July 29, 2026](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0) | Active feature and bug-fix delivery; vendor-led fork. |
| noVNC | [1.7.0, April 28, 2026](https://github.com/novnc/noVNC/releases/tag/v1.7.0) | Maintained integration library; deployments include OpenStack, OpenNebula and ThinLinc. Its website names a two-person core team, so broad adoption does not imply a large core team. |
| TigerVNC | [1.16.2, March 26, 2026](https://github.com/TigerVNC/tigervnc/releases/tag/v1.16.2) | Broad distribution packaging. This release corrected omission of a security fix from 1.16.1, evidence that mature release processes still need verification. |
| Selkies | [2.0.0rc1, September 20, 2026](https://github.com/selkies-project/selkies/releases/tag/2.0.0rc1) | Active multi-contributor development, but the exact current RC has almost no elapsed production history. |
| xrdp | [0.10.6.1, July 7, 2026 publication](https://github.com/neutrinolabs/xrdp/releases/tag/v0.10.6.1) | Active security maintenance despite a 0.x version number. |
| Xpra | [6.5.3, August 18, 2026](https://github.com/Xpra-org/xpra/releases/tag/v6.5.3) | Continuing release delivery, documented native/HTML5 clients and LTS distribution options. |

These facts support continued evaluation of every main candidate. They do not
measure maintainer response time, funding resilience or comparative crash rates.
GitHub repository creation dates were not used as project ages: migrations and
forks make that misleading. Open issue counts and CVE totals were not treated
as defect-rate rankings.

Desktop maintenance also needs component-level evidence. Xfce's 4.20 umbrella
release dates to December 2024, but its
[panel 4.20.8 shipped July 29, 2026](https://archive.xfce.org/src/xfce/xfce4-panel/4.20/).
LXQt shipped 2.4 in April 2026. MATE's website still leads with
[1.28 from February 2024](https://mate-desktop.org/blog/), while its
[repository releases](https://github.com/mate-desktop/mate-desktop/releases)
include 1.29.0 from May 2026; these are different release lines.
[Cinnamon's repository](https://github.com/linuxmint/cinnamon) also shows current
development, but its automated/nightly release entries must not be mistaken for
a supported stable desktop release. These projects should not be declared
abandoned from an old homepage announcement alone.

For mature browser integration, TigerVNC/noVNC has the strongest combination in
this shortlist of standard protocol interoperability and documented independent
adoption. Kasm provides integrated packaging and a commercial product ecosystem.
Neither establishes superiority in Silo's exact embedding without testing.

## Adapting the proposed library checklist

| Proposed criterion | Use for this decision |
| --- | --- |
| Active maintenance, healthy maintainers, useful docs/APIs | Keep. Inspect releases, regression handling, ownership, documented contracts and downstream use. Recent commits alone do not prove health. |
| Fast, small, well-designed; no giant dependency tree | Keep the outcome, measure the installed component set and running workload. Count update ownership and vendored forks, not just package names. |
| Works on Linux | Strengthen: Ubuntu 24.04, ARM64 and AMD64, headless startup, existing VM/session, both host webviews and SSH transport. |
| 2–5 years old, post-1.0, survived a rewrite | Drop as hard gates. They would reject established desktop infrastructure and xrdp for irrelevant reasons. A recent rewrite requires new qualification. |
| Praise, fast growth, “not the most popular” | Drop. Actual deployments and reproducible behavior are useful evidence; fashion and endorsements are not acceptance criteria. |
| No acquisition or previous abandonment | Check current governance, patch ownership and ability to maintain/fork the exact dependency. History alone is not an automatic failure. |
| Repeated unresolved crash reports | Keep as a targeted investigation trigger. Verify affected version/platform, reproduction, maintainer response and regression coverage. |
| No unexplained Electron dependency | Keep the deployment constraint. None of the leading browser stacks requires adding Electron. |

Additional selection criteria: input correctness; predictable focus and human/
agent handoff; text clarity and scaling; explicit clipboard behavior;
accessibility and international input; reconnection without lost applications;
diagnostics; reproducible packages and updates; and licenses of the **exact
shipped components**. Selkies' [component licensing documentation](https://docs.selkies.io/latest/licensing)
illustrates why a top-level project license does not describe every bundled
encoder or dependency. Package footprint and license review remain unfinished
until an exact candidate build is selected.

## Selection experiment and decision rules

The existing [input investigation](SiloUI-DESKTOP.md#native-viewer-input-investigation-2026-09-22)
documents a concrete Kasm/WKWebView clipboard detection mismatch and upstream
precedent. Delayed typing and Enter have not been proven to share that cause.
First create deterministic reproductions of those exact symptoms. Timing
adjustments cannot substitute for explaining lost or misrouted events.

Then compare **corrected KasmVNC versus TigerVNC/noVNC on the same Xfce guest**.
Add Selkies as an experimental third candidate. Only test LXQt against the chosen
streamer afterward, avoiding an unnecessary desktop-by-streamer cross-product.

Required measurements and acceptance, proposed here rather than already run:

1. **Input is a gate.** Test ordinary clicking, dragging, double/right-click,
   scrolling, typing, Enter, modifier release and 100 focus transitions. Send at
   least 1,000 known input actions per tested configuration and independently
   read guest outcomes. Require zero lost/duplicate/misrouted actions and zero
   unsolicited clipboard prompts in that run. This finite run does not prove a
   zero failure rate. Include French/US layouts, accented text and IME input.
2. **Measure the whole interaction.** Record input-to-guest-action and
   input-to-visible-response separately, with median, p95 and p99 latency.
   Include a static screen: updates must appear without a second click.
   Exercise the actual embedded viewer, not only a standalone browser or Luda.
3. **Control the comparison.** Identical guest image, vCPU/RAM, applications,
   desktop settings and 1440×900 resolution; begin at the existing 30 fps ceiling.
   Record codec, quality and text fidelity, then evaluate higher frame rates
   separately. Test idle, text editing, browser scrolling, window movement and
   video. Report guest PSS, host memory, both-side CPU, bandwidth and dropped
   frames; measure cold/warm startup and installed disk cost separately.
4. **Cover supported delivery.** Apple Silicon/WKWebView and Linux/WebKitGTK,
   both guest architectures, local viewing and SSH forwarding. Add controlled
   50/100 ms RTT and packet-loss cases. Verify reconnect, resize, HiDPI scaling,
   persistent applications, agent observation/action and explicit human handoff.
5. **Choose by observed benefit.** If corrected Kasm passes and the challenger
   offers no material UX, resource or maintenance advantage, retain it. Replace
   it if noVNC passes the same gates and fixes remaining correctness problems or
   establishes a worthwhile improvement. Do not migrate based on a codec list.

Next action: reproduce the reported failures in an isolated copy of the actual
viewer, then run that exact input acceptance case against corrected KasmVNC and
TigerVNC/noVNC.

## Research verification

This assessment inspected the repository implementation, existing dated live
evidence, upstream documentation, release notes and public GitHub release
metadata. No candidate desktop/streamer was installed or benchmarked during
this assessment, and no running user VM was changed. Raw release metadata is
retained locally under the ignored
`app/SiloUI/src-tauri/target/verification/desktop-stack-assessment/` directory.
