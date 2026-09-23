# Linux desktop selection: agent APIs and measurement evidence

Research checked 2026-09-22. This is a source assessment, not a running-system
test. No desktop, viewer, guest or native application was started or changed.
Rolling upstream documentation describes capability, not availability in Ubuntu
24.04 packages. Qualify the exact distribution packages separately.

## Decision-relevant findings

Agent compatibility is three separate capabilities: understanding application
controls, observing/injecting screen input, and managing windows. A viewer's
REST or JavaScript API is not a substitute for application semantics. A desktop
using GTK or Qt does not guarantee that arbitrary applications expose complete
accessible controls. There is no defensible desktop-wide “complete agent API”
winner in the reviewed evidence.

X11 offers a common, direct automation surface across conventional desktops.
Wayland offers functioning public remote-control interfaces with stronger
compositor control, but implementations and unattended setup differ. Rejecting
all Wayland desktops as impossible to automate would contradict current primary
sources. Selecting a Wayland stack requires qualifying its compositor and portal
backend, not merely checking a Wayland support checkbox.

## Structured application access

| Surface | Established capability | Limit on what it proves |
| --- | --- | --- |
| [AT-SPI Accessible](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/class.Accessible.html) | Roles, names, hierarchy, relations, states, toolkit identity, and interfaces for actions, text, editable text, tables, selections and values | Interfaces differ by object/application. Stable accessible IDs are available where applications provide them; the API does not manufacture meaningful labels for custom controls. |
| [AT-SPI Component](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/iface.Component.html) | Bounds, point lookup and focus operations | Bounds are meaningful only for objects with visible and showing states. This is not a guarantee of whole-desktop screen coordinates on every compositor. |
| [GTK 4 accessibility](https://gnome.pages.gitlab.gnome.org/gtk/gtk4/section-accessibility.html) | Standard widgets implement accessible interfaces; applications provide missing details; AT-SPI supports out-of-process tree embedding | Custom widgets need explicit implementation. “GTK desktop” does not establish accessible coverage of all installed applications. |
| [Qt QAccessible](https://doc.qt.io/qt-6/qaccessible.html) | AT-SPI integration and built-in widget implementations; custom widgets can supply accessibility interfaces | The documented Linux activation path requires AT-SPI D-Bus status properties or `QT_LINUX_ACCESSIBILITY_ALWAYS_ON`. Application setup is part of compatibility. |
| [Chromium accessibility architecture](https://chromium.googlesource.com/chromium/src/+/main/docs/accessibility/overview.md) | Linux ATK support, native actions and inspectable trees; on-demand accessibility and a force-enable option | Web author semantics and runtime activation still matter. Current source documentation supersedes the old chromium.org page claiming Linux accessibility is unsupported. |
| [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility) | Can expose Chromium's tree; `app.setAccessibilitySupportEnabled` is documented | The application must expose useful HTML semantics; Electron use alone neither establishes nor disproves usable accessibility. |

**Scoring consequence:** keep application semantic coverage unscored until the
same application suite is exercised on each desktop. Give a point for a
documented API surface, not a fabricated success rate. Prefer semantic actions
when available: the [AT-SPI mouse synthesis API](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Device.generate_mouse_event.html)
itself directs consumers toward AccessibleAction where suitable.

## Pixel input and unattended sessions

| Stack | Public control surface | Required setup or qualification |
| --- | --- | --- |
| Native X11 session | [XTest](https://www.x.org/releases/X11R7.5/doc/man/man3/XTestFakeKeyEvent.3.html) synthesizes keys, pointer movement and buttons. [EWMH](https://specifications.freedesktop.org/wm/latest-single/) exposes window/desktop state and requests. | Correct display and authorization; query supported extensions/properties. Requests can be refused by the window manager. Direct input changes the shared pointer/focus. |
| GNOME/KDE Wayland | [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html) requests keyboard/pointer/touch access; combines with ScreenCast/PipeWire and clipboard; supports D-Bus input or EIS. | Normally begins with a consent dialog. Persistence is optional permission state, not guaranteed automatic access. A failed restore can prompt again. Qualify the installed backend. |
| GNOME headless | [GNOME Remote Desktop](https://github.com/GNOME/gnome-remote-desktop/blob/main/README.md) implements single-user headless, assistance and remote-login modes, using PipeWire, libei and Mutter. [Configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md) documents CLI setup, credentials, certificates and system/user services. | Mode matters: multi-user remote login uses RDP/GDM; a separately configured single-user headless session is different. This proves a documented deployment route, not compatibility with Silo's init/network/browser integration. |
| KDE Wayland unattended control | Current [portal source](https://github.com/KDE/xdg-desktop-portal-kde/blob/master/src/remotedesktop.cpp) implements EIS through KWin and an explicit permission-store authorization mechanism for unattended access. | This is KDE-specific administration, not a portable portal promise. Its RemoteDesktop implementation requires a compatible Wayland compositor. |
| Sway/wlroots via its portal backend | [xdg-desktop-portal-wlr README](https://github.com/emersion/xdg-desktop-portal-wlr/blob/master/README.md) lists Screenshot and ScreenCast. | The reviewed backend does not list RemoteDesktop. Screen capture support must not be counted as input control. Separate compositor protocols/tools need separate evidence and tests. |

Version boundary: RemoteDesktop persistence and `ConnectToEIS` are interface
version 2 and already appear in the [xdg-desktop-portal 1.18.4 interface](https://github.com/flatpak/xdg-desktop-portal/blob/1.18.4/data/org.freedesktop.portal.RemoteDesktop.xml).
These are different version numbers. Backend implementation remains necessary.
Current [GNOME backend source](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/main/src/remotedesktop.c)
contains restoration and EIS handling; this is source evidence, not an executed
test of a particular installed release.

[libei's protocol](https://libinput.pages.freedesktop.org/libei/) deliberately
makes emulated input distinguishable inside the compositor so it can control
access. Clients see normal input events. Its [API](https://libinput.pages.freedesktop.org/libei/api/index.html)
provides client, server and portal-helper libraries. It does not supply app
semantics, screen capture or an automatic entitlement to control every desktop.

The [X.org security model](https://www.x.org/guide/communication/) grants broad
cross-client access after ordinary authentication; optional extensions can
restrict it. This makes unattended automation straightforward but is a weaker
application-isolation model. The VM boundary and in-session application
isolation are different concerns. Neither XTest nor libei promises conflict-free
simultaneous human and agent interaction. Arbitration or an explicit shared
session contract still needs application-level design and a test.

## Window management and API ergonomics

| Candidate family | Documented API advantage | Boundary |
| --- | --- | --- |
| Conventional X11 desktops, including Xfce, MATE, Cinnamon, LXQt with an EWMH window manager, and Plasma X11 | Common [EWMH](https://specifications.freedesktop.org/wm/latest-single/) vocabulary: active window, client list, workspace, close, move/resize requests and supported-property discovery | The specification permits refusing activation requests. Test each window manager and focus policy. This establishes portability, not identical behavior. |
| i3 | [IPC](https://i3wm.org/docs/ipc.html) has a documented JSON layout tree, commands, window/workspace events and explicit delivery constraints | Excellent window-state introspection does not expose controls inside applications. Event subscribers must handle interleaving and drain their sockets. |
| Sway | [IPC](https://github.com/swaywm/sway/blob/master/sway/sway-ipc.7.scd) exposes commands, tree, outputs, workspaces and events over a Unix socket | Similar window API benefit; it does not establish a complete portable screenshot/input backend. |
| KDE/KWin | [Scripting API](https://develop.kde.org/docs/plasma/kwin/api/) exposes window lists/properties, activation, desktops, signals and geometry-related operations | Runs as compositor scripting and requires an adapter. Version-specific symbols must be pinned; the reference labels its base as KWin 6.0 but includes later additions. |
| GNOME/Mutter | [Meta.Window](https://gnome.pages.gitlab.gnome.org/mutter/meta/class.Window.html) exposes activation, geometry, workspace and state operations | An in-process compositor/library API is not an unrestricted external automation endpoint. An extension/bridge and version qualification are additional work. The rolling page currently identifies API 51. |

**Narrow ranking supported by sources:** i3/Sway have the clearest external
window-management IPC; KWin has an extensive documented scripting surface;
conventional X11 desktops share portable standard hints. This is a ranking of
one API dimension, not of overall agent productivity or human usability.

## What published performance evidence establishes

| Primary source | Measurement or claim | Why it cannot rank Silo candidates |
| --- | --- | --- |
| [KasmVNC performance microbenchmarks](https://github.com/kasmtech/KasmVNC/wiki/Performance-Testing) | Fixed 1600×1200 source images, single-threaded encoding/scaling/analysis tests on AWS c5.large; historical table through February 2025 | Isolated functions and historical Kasm builds. No competing viewer, ARM64 or embedded WebKit result. |
| [Kasm performance reference](https://docs.kasm.com/docs/develop/reference/kasm-performance) | Its own 1080p encoding modes; software results on EPYC 7J13 and hardware results on Intel i5-10400H; separate client/server CPU, FPS and bandwidth | Useful evidence that workload and encoding mode change costs. Not a cross-product trial; no matching Silo client or ARM64 result. |
| [Selkies design](https://github.com/selkies-project/selkies/blob/main/docs/design.md) | Claims 1080p60 software encoding below 100% CPU and describes X11/Wayland and WebSocket/WebRTC paths | The headline is missing a matching CPU, client, workload, quality setting and repeatable comparative data. Treat it as a vendor performance target. |

The reviewed sources do not establish an apples-to-apples winner on Ubuntu
24.04, both guest architectures, CPU-only guest rendering/encoding and Silo's
embedded WebKit. “No qualifying comparison found” is a research result; it is
not a claim that no comparison exists anywhere. FPS, idle RAM, stars and
distribution adoption must not be substituted for measured interaction
latency, task completion or recovery reliability.

## Proposed auditable notation

For each criterion record `value / evidence / scope`, where evidence is:

- **M:** measured on the stated Silo configuration with reproducible output.
- **D:** documented public capability in primary sources, with version/config.
- **C:** project claim without a matching reproducible trial.
- **?:** missing or conflicting evidence.

Do not convert `?` into zero, or `C` into measured performance points. Separate
requirements from weights. A gate is passed only for the configuration actually
documented or tested. A weighted overall score is a policy choice: publish the
weights, the rubric for every level, and whether reasonable weight changes
reverse the order. Show ties and unknown intervals instead of decimal precision
that the evidence cannot justify.

For agents, score these separately: semantic app coverage; screenshot/input
coverage; window control; unattended initialization/recovery; documented public
API stability; permission/isolation model. Dependence on custom privileged
bridges is implementation cost, not proof that the task is impossible.

## Qualification protocol needed to decide performance and reliability

This is a proposed test, not a claim that these results were collected.

1. Freeze image/package manifests, vCPU/RAM, app versions, resolution, scale,
   locale, compositor effects, encoding/quality, transport and host WebKit
   versions. Test native ARM64 and AMD64 separately. Keep guest GPU absent for
   the CPU baseline; identify host decoding acceleration instead of assuming it.
2. Compare desktops under the same viewer, then viewers under the same desktop.
   Separately qualify combinations that require a different display server.
   Use the same functional package set, not a minimal session against a full
   distribution image with unrelated background services.
3. Record installation bytes, installed bytes, idle proportional memory and
   guest-wide available memory; guest app/compositor/encoder CPU; host VM and
   WebKit memory/CPU. RSS summed across processes double-counts shared pages.
   Check stopped-session memory separately from host VM reclamation.
4. Use a deterministic workload: static text, scrolling text, window dragging,
   document editing, browser navigation and video. Measure input-to-visible
   response p50/p95/p99, frame delivery, bandwidth and text/image fidelity at
   fixed resolutions, then compare quality-matched presets. Encoder FPS alone
   is not interaction latency.
5. Run both local transport and the actual SSH/TCP forwarding path with declared
   latency, bandwidth and packet-loss profiles. Measure reconnect, resize,
   sleep/resume and dropped-connection recovery. Include Unicode clipboard,
   drag/drop, US/French layouts, modifier release and IME behavior.
6. Probe AT-SPI roles/actions/text/bounds and pixel fallbacks in the same GTK 3,
   GTK 4, Qt 5/6, Chromium/Electron and document-app versions. Record successful
   tasks, missing controls, retries, timeouts and semantic/pixel fallback rate.
   Observe dialogs, menus, offscreen windows and overlapping windows. Repeat
   with deliberate human pointer/focus interference.
7. Start with five fresh runs per performance cell and report spread; extend
   only noisy or close comparisons. Publish recovery failures per attempt. Zero
   failures in 100 trials is still compatible with roughly a 3% failure rate at
   a one-sided 95% bound, not proof of production reliability.
8. Test human intuitiveness with representative new users performing fixed
   tasks, recording completion time/errors/help requests. Familiar layout and
   distribution support are documented proxies; they are not usability scores.

The next action is a controlled candidate bake-off in disposable guests using
the same workload and the real Silo viewer, with acceptance thresholds declared
before looking at the results.
