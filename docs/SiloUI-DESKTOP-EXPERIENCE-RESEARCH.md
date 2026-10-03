# Linux desktop experience: an unconstrained recommendation

**Current direction:** [one detached viewer across every supported platform](SiloUI-DESKTOP-VIEWER-DIRECTION.md)
supersedes this document's split native-local/streamed-remote recommendation.
The comparison and primary-source findings below remain research evidence;
they are not a proposal to ship multiple viewer engines.

The [implementation plan](SiloUI-DETACHED-DESKTOP-IMPLEMENTATION-PLAN.md) also
supersedes this memo's input-handoff proposals and acceptance gates. Human and
agent input remain concurrent, with conflicts left to the human; coordination
and agent pausing are outside the agreed scope.

Research date: 2026-09-27. Coordinated research by the parent agent and three
Luna researchers covering streaming, session platforms, and UX. This is a
proposal supported by primary sources, not an implementation or benchmark.
No running Silo instance, computer, or user data was changed.

## Recommendation

**Build the experience around one persistent Linux session, with native local
display and an adaptive remote viewer. Qualify Selkies 2.0 as the lead remote
streaming candidate, and GNOME Remote Desktop with FreeRDP as the main
Wayland-native alternative.** The product should choose its delivery mechanism;
users should choose the computer and task.

The strongest local reference is Apple's supported Linux VM display on Mac;
QEMU with virtio-gpu and native SPICE clients supplies the cross-platform
reference. The strongest browser-streaming challenger is now Selkies 2.0.
GNOME's compositor-integrated RDP stack deserves a separate, complete trial
because it addresses modern display scaling, accessibility and persistent
headless sessions together. Amazon DCV is the commercial remote-workstation
benchmark, with explicit platform and licensing restrictions.

This is a selection of where to invest next. **There is no comparable evidence
establishing an absolute latency, efficiency or reliability winner.** No
candidate earns those labels from vendor FPS claims, GitHub popularity, a
native window, or a recent release. Shipping a new engine before the tests
below would move the finish line from a working desktop to a technology demo.

## What "best" means for this feature

Assumed primary workload: a person or agent uses a browser, editor, file
manager and occasional desktop-only Linux application in a named computer,
on local Mac/Linux or a remote device. Both ARM64 and x86-64 matter. A GPU
is a separate supported profile, not an implicit property of every computer.

The decision order is:

1. Preserve the correct session, application state and input ownership.
2. Make text readable and keyboard/pointer behavior correct.
3. Recover from viewer and network failure without losing running work.
4. Minimize task latency and total host-plus-guest resource use.
5. Add high-motion quality, extra monitors, media and per-app windows where the
   actual task benefits.

Missing evidence: real workload frequency, supported device budgets, network
distribution, measured input latency, user error rate and willingness to pay
for a better GUI workflow. The current research can select candidates and
disqualify incompatible combinations; it cannot fill those numbers in.

Compare the feature against SSH plus a local editor/browser and a standalone
native VM viewer. For text editing or an ordinary web preview, those are strong
workarounds. The desktop earns its place for Linux GUI applications, OS dialogs,
visual verification, and human/agent work in the same environment. Wallpaper,
tiling animations and a codec badge do not establish demand.

## Complete routes to compare

| Route | Complete candidate | Why it earns a trial | Boundary that must be proved |
| --- | --- | --- | --- |
| Local Mac | Apple Virtualization + a Linux desktop on its virtual display + `VZVirtualMachineView` | Official framebuffer, input, resize, clipboard and audio building blocks; no network video stream required | Requires Apple's VM runtime; no claim of guest 3D acceleration, lower total cost, or arbitrary checkpoint compatibility |
| Local Linux, or one runtime family across devices | QEMU/KVM or QEMU/HVF + virtio-gpu + native display/SPICE; spice-gtk on Linux, CocoaSpice on Mac | Maintained VM/display ecosystem and reusable native clients | Device, renderer, guest-tool, packaging and client versions form one qualified combination; GPU mode is conditional |
| Remote browser experience | Existing Xorg session + Selkies 2.0 native package + supported browser client | Rich display/media/input channels, CPU paths, optional WebRTC, documented chroma negotiation | Prove reconnect, input, text quality and resource use; its native existing-Wayland capture documentation is inconsistent |
| Modern Wayland desktop | GNOME 50/51 + GNOME Remote Desktop + native FreeRDP | Compositor-integrated capture/input, RDP client ecosystem and maintained headless modes | Sharing an existing seat and creating a headless login are different modes; select one and prove session identity |
| Commercial remote workstation | Supported Linux X11 server + Amazon DCV + Web Client SDK or vendor native client | Rich documented desktop channels and an official embedded web SDK | Off-EC2 licensing, restricted supported ARM server configurations, no Linux Wayland; native features are not Web SDK features |
| Native high-motion specialist | Supported Linux display + Sunshine + Moonlight PC | Native clients, hardware paths and 4:4:4 support merit a GPU workload trial | Capture, pairing, input, files and session lifetime need product integration; no browser client is a design choice, not a disqualification |

Sources: [Apple GUI Linux](https://developer.apple.com/documentation/virtualization/running-gui-linux-in-a-virtual-machine-on-a-mac),
[QEMU graphics](https://www.qemu.org/docs/master/system/devices/virtio/virtio-gpu.html),
[CocoaSpice](https://github.com/utmapp/CocoaSpice),
[Selkies native integration](https://github.com/selkies-project/selkies/blob/2.0.0/docs/native.md),
[GNOME session modes](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md),
[DCV supported servers](https://docs.aws.amazon.com/dcv/latest/adminguide/servers.html),
[Moonlight PC](https://github.com/moonlight-stream/moonlight-qt).

The table is a set of experiments, not a proposal to ship six backends. Select
one remote engine after the comparison, and add a local native route only when
its measured benefit pays for maintaining it. Do not build a generic plugin
framework before two validated adapters exist. If a single streamed route
meets the local budget and materially reduces failures, it wins on total
product cost.

## What changed in the evidence

**Selkies is no longer an RC.** [2.0.0 shipped September 23](https://github.com/selkies-project/selkies/releases/tag/2.0.0).
The rewrite uses a Python service with Rust media extensions, defaults to
WebSockets, and offers optional WebRTC. That reverses the release-status
objection in the September 22 assessment. Four days of final-release history
does not prove operational reliability.

**The client runtime is a choice.** Test a supported Chromium client first
to establish the candidate's intended capabilities. Compare an embedded
Chromium implementation, system WebKit, or a native client as complete
deliverables, including memory, update ownership, input and clipboard. A
WKWebView limitation is not an automatic rejection in this unconstrained
study; neither is shipping Chromium automatically an efficiency improvement.

**Native Linux VM UI does not require an experimental Silo runtime fork.**
Apple provides a supported API, and SPICE has native clients. Adopting either
still has consequential runtime and integration costs. The separate
[native-display report](research/linux-desktop-native-options-2026-09-27.md)
records those costs and the current UTM beta limitations.

**GNOME's current remote stack deserves more than a passing mention.**
[GNOME 50](https://release.gnome.org/50/) adds remote HiDPI support, conditional
Vulkan/VA-API acceleration and headless sessions that survive remote-service
restart. [GNOME 51](https://release.gnome.org/51/) shipped September 16. These
are version-specific upstream capabilities, not features to attribute to
every older LTS image. Use a distribution-supported version and its actual
packages in the trial.

**Plasma is a credible future desktop, with a present release boundary.**
KDE's [August remote-desktop update](https://blog.davidedmundson.co.uk/blog/whats-happening-in-kde-remote-desktop-improved-unattended-mode-and-more/)
describes improvements targeted at 6.8, including unattended display layout,
input and streaming. It also calls for testing work still landing. Do not
treat those improvements as already proven in a stable deployed combination.
The [6.8 X11 removal](https://blogs.kde.org/2025/11/26/going-all-in-on-a-wayland-future/)
also makes a new long-term "latest Plasma + Xvnc" architecture a poor bet.

## Choose the desktop separately from the transport

**GNOME/Wayland is the flagship UX candidate; Xfce/X11 is the CPU and
compatibility control.** This is a design judgment, not a memory or usability
ranking. GNOME's current display, accessibility and remote-session work gives
it a coherent modern path. Xfce gives the experiment a conventional desktop
with broad X11 capture choices. Also test LXQt/labwc if measured resource
limits rule out the flagship; do not select it from the word "lightweight."

The first transport comparison should hold the desktop environment and apps
constant on X11 across KasmVNC, Selkies and TurboVNC/noVNC. Their display-server
implementations differ, so record that unavoidable difference rather than
claiming to isolate the wire protocol alone. The flagship comparison should then test GNOME/Wayland
with its own RDP integration against the winning full X11 stack. This separates
causal diagnosis from the user's final experience.

Selkies' headless Wayland session and capture of an existing native Wayland
seat are not interchangeable. Its pinned native instructions and current
component instructions differ; qualify the exact artifact and mode before
claiming native-local and remote views can share that seat. Existing-Xorg
attachment is the clearer documented initial seam.

Keep the desktop recognizable and configured: readable scale, useful fonts,
file manager, browser, terminal and a computer shortcut. Ship neither a
custom desktop shell nor a theme distribution as the feature's core value.

## The experience to build

The main surface is the application content. A small toolbar identifies the
computer, connection state, controller and audio; display, input and transfer
details live in a menu. Do not expose protocols, encoder names or bitrate
sliders in the normal opening flow.

| Moment | Desired behavior | Proof required |
| --- | --- | --- |
| Open | One action opens the existing desktop, or starts it with an explicit progress state | First usable frame and input readiness, not merely an open socket |
| Read and resize | Match guest pixels and logical scale to the actual device display; retain text clarity after motion | Thin colored text, mixed DPI, fractional scale, accurate pointer geometry |
| Type | Respect layout, composition and application shortcut meaning | AZERTY, AltGr, dead keys, CJK IME, terminal Ctrl-C and GTK/Qt/browser editors |
| Move files | Drop a file into a named guest destination; show completion and reveal it there | Unicode paths, hashes, cancellation and interruption; file transfer is not always a native app drag |
| Leave | Closing the view keeps applications running while the computer remains alive | Unsaved editor buffer, app process and terminal job survive viewer close/crash |
| Reconnect | Preserve the last frame with a clear stale/disconnected state; reconnect to the same session | No buffered stale clicks, repeated keystrokes or surprise new desktop |
| Delegate | Show who controls; the user's delegated task starts authorized control | Supported agent and human see the same session, geometry and current state |
| Take over | One visible action revokes agent input, releases held keys/buttons, acknowledges handoff, then admits human input | No late event from an in-flight supported agent action after ownership changes |

Avoid a global Command-to-Control swap: Command-C means copy in a Mac editor
but Ctrl-C interrupts a Linux terminal process. Use an explicit raw Linux
keyboard profile plus narrowly defined semantic shortcuts where they are
correct. Never consume the user's only escape from the guest.

Clipboard and audio should be useful defaults with clear authority: clipboard
directions must be explicit and failures visible; microphone and camera require
the user's activation. Let the controlling viewer own desktop resize; an
observer should scale its view instead of rearranging the controller's windows.

The creative opportunity is **a computer that a person and agent can hand
back and forth without setup or state loss**. An optional application launcher
can focus installed Linux apps in that computer. Add actual device-native app
windows only after Xpra or another maintained implementation proves they can
refer to that same session. A cropped stream is not a native app window, and a
second login is not the same computer.

Pixels also do not carry an accessibility tree. Use supported guest semantic
interfaces for agent actions and accessibility where available, and identify
pixel-only behavior honestly. A Silo control lease can govern its supported
agent adapters; it cannot prevent arbitrary privileged software inside the computer
from injecting input. Do not overstate that guarantee.

## Reliability belongs in session ownership

The computer/session supervisor owns the compositor and application lifetime. The
viewer attaches and detaches; it does not start a replacement desktop on every
retry. Keep transport recovery separate from session creation and explicit
desktop stop. A server that embeds its display server can still terminate apps
when that server crashes; test that boundary instead of assuming separation.

Viewer reconnect, VM suspend, application session recovery and durable computer
checkpoint are four different promises. State which one is supported. A device
restart does not preserve unsaved application memory merely because disk files
persist. If checkpoints remain part of the product contract, test every new
graphics/audio/device configuration through capture, device restart and restore.

No new proprietary network protocol is justified by this research. Use the
selected upstream client's transport/authentication mechanisms and an
established private connection where needed. For WebRTC, account for direct
connectivity and managed TURN/relay operation if the product needs it; TCP
fallback and UDP media have different failure/latency behavior. Do not require
a relay system for a local-only viewer.

## Operational and distribution decisions

Every shipped combination needs an owner, pinned dependency manifest, security
update route, reproducible build and rollback. Count guest services, native
client dependencies, browser runtime and codec libraries, not just the number
of top-level packages. Select supported release lines, not an arbitrary latest
branch or an older distribution package assumed to be abandoned.

Review the exact artifact's notices and redistribution terms: Selkies' MPL
application and codec build variants; GPL components in Kasm, VNC and
Sunshine/Moonlight distributions; Apache-licensed FreeRDP/Guacamole interfaces;
and SPICE/CocoaSpice's mixed dependency licenses. A permissive wrapper does
not make its dependencies permissive. DCV outside EC2 needs the vendor's
production licensing arrangement, and its documented ARM server support is
not a blanket local-ARM entitlement. These are packaging gates, not legal
conclusions about a hypothetical combined product.

Guest-controlled media and device data reach host parsers. Clipboard, file,
URL, microphone and shared-folder bridges also cross trust boundaries. Prefer
upstream components, explicit per-session authority and minimal exposed
services. GPU command sharing adds a separate graphics-driver boundary.

## The experiment and rejection criteria

These numbers are **proposed acceptance targets**, not measured results or
universal remote-desktop thresholds. Freeze them before implementing the test.

| Gate | Initial target |
| --- | --- |
| Input latency | p95 input-to-visible-guest-response under 50 ms locally; under 120 ms at 40 ms RTT, 20 Mbps and 1% packet loss |
| Text | No transcription errors on a fixed code/document corpus at the default readable scale; retain colored thin strokes after the image settles |
| Reconnect | 100/100 viewer/transport reconnects preserve the same running session; p95 interactive recovery under 3 s after reachability returns |
| Input correctness | Exact Unicode result in GTK, Qt, browser and terminal; no stuck modifiers after focus loss, disconnect or handoff |
| Control ownership | 100/100 supported agent handoffs admit no agent event after acknowledged human takeover |
| Resource use | Compare total host/guest CPU, memory, bandwidth and startup bytes at matched quality; advance added complexity only for a material benefit, initially at least 20% on the declared bottleneck without a hard-gate regression |
| Soak | 8 hours per selected architecture/client route, including sleep/wake, resize, active transfers and interrupted media; record failures and denominator |

Start with 1080p and a Retina-sized display profile on ARM64 Mac and x86-64
Linux; include ARM64 Linux before selecting a cross-platform winner. Test
software-only first, then a separately identified GPU profile. Record exact
hardware, OS, guest image, server/client builds, decoder, codec, chroma format,
resolution and logical scale. Compare at equal text quality, not equal bitrate.

Measure end-to-end guest response using synchronized instrumentation or a
high-speed recording; cursor-only motion and encoder frame time are not
input-to-photon latency. Use idle, typing, editor scrolling, browser animation,
video, resize and file-transfer workloads. Capture distributions, not just
averages. Add a worse network profile to reveal fallback behavior even when
it cannot meet the normal target.

These sample sizes screen candidates; they do not establish a production
failure rate or release readiness. Use staged elimination: one working instance of each complete route, then the
full matrix only for finalists. Include cold start, reconnect, viewer crash,
stream-service restart, compositor failure and computer reboot as distinct tests.
A compositor crash can destroy applications; the UX must report that honestly.
No silent desktop restart or fabricated session recovery is acceptable.

Finally, have five people with an actual recurring Linux GUI task complete it
with the finalists and their existing workaround. Record task completion,
errors, time and the situation that makes them depend on it. An attractive
demonstration or stated interest does not validate the feature's expansion.

**Next action:** run one disposable, reproducible desktop comparison with the
current viewer as control, Selkies 2.0 as the lead remote challenger, and
Apple's native view as the local reference; advance GNOME/RDP through the same
task and session gates before choosing the flagship stack.

## Evidence annexes

- [Streaming engines](research/linux-desktop-streaming-options-2026-09-27.md):
  Selkies, KasmVNC, TurboVNC/noVNC, TigerVNC, Sunshine/Moonlight and Wolf.
- [Session platforms](research/linux-desktop-platform-options-2026-09-27.md):
  native RDP, GNOME Remote Desktop, Xpra, DCV, Guacamole and commercial options.
- [UX and desktop choices](research/linux-desktop-ux-options-2026-09-27.md):
  product precedents, full-session versus seamless-app semantics and acceptance.
- [Native local delivery](research/linux-desktop-native-options-2026-09-27.md):
  Apple Virtualization, QEMU/SPICE, UTM and Linux window projection.

The annexes make recommendations for their own narrower questions. This memo
resolves them into an unconstrained product direction. It supersedes the older
RC-status assessment for Selkies, but does not rewrite historical test results
or claim a production migration has been approved or executed.
