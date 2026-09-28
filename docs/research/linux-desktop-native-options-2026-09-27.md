# Native local Linux desktop delivery

Research date: 2026-09-27. Source review only. No VM, display backend, or viewer
was installed, started, or benchmarked. This comparison deliberately permits
replacing Silo's current runtime and UI integration. Recommendations are
engineering judgments; measured superiority remains unestablished.

## Decision

**Use a native virtual display as the local-performance reference.** On macOS,
start with Apple's Virtualization framework and `VZVirtualMachineView`. On
Linux, compare QEMU/KVM with virtio-gpu and its supported local display or SPICE
client. If a common runtime across hosts matters more than the smallest Mac
integration, compare QEMU on both hosts with SPICE, CocoaSpice on macOS, and
spice-gtk on Linux.

This removes the requirement to encode a network video stream for a VM on the
same computer. It does not establish zero-copy delivery, lower total latency,
hardware-accelerated guest applications, or lower memory use. Measure those
separately. A mature native client is also a demanding UX benchmark for an
embedded browser viewer.

## Apple supplies the Mac building blocks

Apple's [GUI Linux sample](https://developer.apple.com/documentation/virtualization/running-gui-linux-in-a-virtual-machine-on-a-mac)
boots architecture-matched Linux guests on Intel and Apple Silicon Macs. It
configures graphics, absolute pointing, keyboard, audio, and SPICE clipboard
devices. It documents text/image clipboard support from macOS 13 with
`spice-vdagent` in the guest, and automatic display reconfiguration from macOS
14. This is direct evidence that these integrations have supported APIs.

[`VZVirtualMachineView`](https://developer.apple.com/documentation/virtualization/vzvirtualmachineview)
is an AppKit view of a `VZVirtualMachine` framebuffer that forwards configured
keyboard and pointer events. Its
[`capturesSystemKeys`](https://developer.apple.com/documentation/virtualization/vzvirtualmachineview/capturessystemkeys)
property controls forwarding certain host shortcuts. It is not an arbitrary
framebuffer viewer that can be attached to another hypervisor's VM. Adopting it
means adopting Apple's VM ownership/configuration contract on Mac.

Apple's [clipboard attachment](https://developer.apple.com/documentation/virtualization/vzspiceagentportattachment)
has an explicit sharing switch. UTM's
[Linux guest integration](https://docs.getutm.app/guest-support/linux/)
provides an implemented precedent for SPICE guest tools and virtiofs shared
directories. These establish available integration paths, not correct IME,
keyboard layout, per-monitor scale, or clipboard behavior in a new Silo viewer.

Do not infer Linux guest 3D acceleration from the words "virtio graphics" or
from native host presentation. Do not infer that an NSView conforming to
accessibility protocols exposes the Linux application's semantic accessibility
tree. Both are separate capabilities.

## QEMU and SPICE provide a cross-platform reference

[QEMU's release page](https://www.qemu.org/download/) lists 11.1.1 and maintained
older release branches on the research date. Its
[virtio-gpu documentation](https://www.qemu.org/docs/master/system/devices/virtio/virtio-gpu.html)
distinguishes the default 2D device from virglrenderer and rutabaga acceleration.
The default device requires software rendering for 3D; accelerated modes have
specific host GPU, kernel, Mesa and memory-sharing requirements. The documented
vhost-user GPU backend moves graphics processing into a separate process for
isolation. These are capabilities to qualify in a selected release, not a
promise that a distribution package enables every mode.

[SPICE](https://www.spice-space.org/) connects a hypervisor display to a native
client. Its [download page](https://www.spice-space.org/download.html) lists
server 0.16.0 and spice-gtk 0.41. The latter exposes an embeddable GTK widget;
the recommended ready-made client is virt-viewer. Guest agents add integration
such as clipboard and display resizing. GPU rendering and SPICE remoting
remain separate decisions; do not assume a local accelerated buffer path can
be transmitted unchanged to a remote host.

[CocoaSpice](https://github.com/utmapp/CocoaSpice) wraps the SPICE client for
macOS/iOS. It exposes Metal display/cursor textures, clipboard bindings, Unix
and TCP sockets, scrolling, screenshots, and optional USB integration. The
wrapper uses Apache-2.0 but links GLib, GStreamer, and spice-client libraries;
its license does not replace their licenses. Its README has no completed
testing instructions and the repository does not present a normal release
catalog. Treat it as a real reusable component with a dependency and pinning
burden, not an Apple-supported widget.

For an embedded product, select a supported QEMU branch and freeze the entire
QEMU/SPICE/client build manifest. Audit upstream and distribution maintenance
for that manifest. QEMU's established ecosystem is evidence of reuse, not
evidence that a bespoke combination is automatically reliable.

## The newest GPU demonstrations are not the production baseline

UTM's [4.7.5 release](https://github.com/utmapp/UTM/releases/tag/v4.7.5) is marked
Latest. Its [5.0.6 release](https://github.com/utmapp/UTM/releases/tag/v5.0.6),
published September 24, is explicitly beta. The beta adds Linux Vulkan 1.3 and
OpenGL 4.1 paths, but also warns that Vulkan desktop rendering does not work
for its stated geometry-shader limitation and directs desktop users toward
VirGL. Its snapshot features have backend and host-OS requirements.

That is a promising experiment and a concrete limit. Do not cite the new
graphics feature without the warning, or describe the beta as a fully
supported stable replacement. UTM's fixes for display/input freezes, scaling
and clipboard integration are also useful regression cases, not a measured
failure rate for competing products.

## Seamless applications are a distinct product opportunity

[ChromeOS Sommelier](https://chromium.googlesource.com/chromiumos/platform2/+/HEAD/vm_tools/sommelier/README.md)
demonstrates projecting Linux application windows through a host compositor
instead of displaying an entire nested desktop. It includes X11 forwarding
through Xwayland and documents the shared X11 process's crash consequences.

[Sommelier-rs](https://github.com/google/sommelier-rs) is a newer Rust project
for virtio-gpu cross-domain Wayland projection. It requires a Wayland host
compositor and compatible VMM; X11 support is an explicit non-goal. It states
that it is not an officially supported Google product. Its architecture is
useful prior art for Linux hosts, not a ready-made Mac integration.

The useful product idea is "open the Linux app I need" with visible VM
identity and file handoff. Native per-app windows, desktop window cropping,
and launching another virtual session have different input, dialog, focus,
and accessibility semantics. Do not present them as equivalent. Xpra is the
more concrete cross-platform application-remoting comparison in the
[platform report](linux-desktop-platform-options-2026-09-27.md).

## Persistence and security boundaries

A viewer can disconnect while the guest compositor and apps keep running.
That is different from preserving applications after VM stop or host reboot.
Apple's [save-state API](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/savemachinestateto(url:completionhandler:))
requires a paused, savable VM, and
[`validateSaveRestoreSupport`](https://developer.apple.com/documentation/virtualization/vzvirtualmachineconfiguration/validatesaverestoresupport())
explicitly rejects unsupported configurations. Qualify the exact guest,
devices, host OS, storage and restore sequence before promising checkpoints.
Do not transfer macOS-guest support or a new-host feature to all Linux guests
on the minimum supported Mac version.

Display buffers, codec parsers, shared GPU commands, clipboard, shared folders,
and input devices cross the guest boundary. Prefer upstream device models and
clients, keep optional forwarding explicit, and ensure a hostile guest cannot
open arbitrary host files or execute a received URL/command. Native display
removes a web/network path locally but still exposes device and graphics
parsers. Share only the folder selected by the user. A guest GPU render node
does not necessarily expose a usable hardware video encoder.

## One experiment that settles the local question

Use the same architecture-matched guest applications, resolution, scale,
CPU/RAM allocation and scripted task on Apple native display, QEMU/SPICE, and
the current browser delivery path. Record unavoidable image/runtime differences.
Measure end-to-end input-to-visible-response p50/p95, text quality, scroll
frame-time distributions, host-plus-guest CPU/memory, idle work, time to first
usable frame, and reconnect outcomes. Include guest redraws so a smooth local
cursor cannot conceal a delayed application response.

Test host display-scale changes, AZERTY and US layouts, dead keys/CJK
composition, drag/drop, clipboard text and images, audio, suspend/wake and
viewer crashes. A second viewer must not unexpectedly resize the active
controller's desktop. Hold application session identity constant across local
and remote views; starting an unrelated remote session is a failed handoff.

**Advance the native route only if its measured benefit justifies the runtime
and platform maintenance it introduces.** Existing runtime compatibility earns
no UX points, and eliminating a video encoder alone is not a sufficient reason
to replace a working VM platform.
