# Linux desktops for agent sandboxes

Research date: 2026-09-18. Proposal only; no desktop image was built or booted,
no agent integration was tested, and no application behavior changed.

The [implementation plan](SiloUI-DESKTOP-IMPLEMENTATION-PLAN.md) is authoritative
for the agreed scope: automatic startup by default with a manual-mode setting,
no removal workflow, and no shipped agent tools or agent-control UI. Earlier
adapter and coordination proposals below are research history, not commitments.

## Recommendation

Add an optional desktop capability to existing Ubuntu 24.04 sandboxes: minimal
Xfce on X11, KasmVNC 1.5.0 for the virtual display and integrated browser viewer,
and compatibility with guest-local screenshot/input tools. Install through guest packages;
retain the same MicroSandbox VM, root disk, workspace and ordinary terminal
image. A creation checkbox runs this same enablement workflow. A separate
desktop image is not required. This supersedes the earlier image-only proposal
and initial TigerVNC/noVNC recommendation.

Run the session as a normal guest user with unrestricted passwordless sudo.
This preserves application compatibility while giving the agent full guest
administration without permission prompts. It is not a restriction on the
agent's guest privileges.

This is an engineering inference from the components' documented interfaces,
not evidence that the combination works on Silo's pinned runtime. Prove one
agent workflow before building the creation picker or publishing an image.

## Optional desktop lifecycle

Proposed user-facing states:

- Not installed: today's terminal-only sandbox, without desktop packages.
- Installed and stopped: desktop files remain; its session and streaming
  processes are stopped. Terminal use and independent background jobs continue.
- Running: one guest desktop shared by the human viewer and compatible agent.

Install a versioned `silo-desktop` guest package and its dependencies, with a
recoverable installation journal. Record pre-existing packages, package marks
and configuration touched by installation. Preflight free disk, architecture,
supported OS version and package-manager health. Fail visibly on unsupported
or conflicting guest configuration; never replace the user's root filesystem.

Start/stop only the supervised desktop process group. Closing the viewer merely
disconnects the viewer. Explicitly stopping the desktop ends its GUI apps and
can lose unsaved GUI work, so it is separate from closing a view. Independent
terminal processes must survive. Stopping releases desktop process resources
inside the guest; immediate host memory reclamation depends on the VM runtime.

Desktop removal is out of scope by user decision. Installation at creation and
installation later use the same workflow. Once installed, desktop packages
remain; users can stop/start the graphical session independently of the VM.

The desktop and agent must share a display, session bus and appropriate guest
user permissions. Existing root-run agents need an explicit session launcher;
do not silently move credentials or recursively change workspace ownership.
Preserve terminal/SSH entrypoints. Supply a scoped GUI launch environment rather
than setting DISPLAY globally when the desktop is absent.

Support Silo's prepared Ubuntu release on both architectures first. Ordinary
desktop application support is the target; arbitrary distributions, init
systems, GPU workloads and applications requiring unavailable kernel features
are not established by this research.

## Existing seams

- `app/SiloUI/guest-image/Dockerfile` builds the Ubuntu 24.04 CLI guest.
- `app/SiloUI/src-tauri/src/runtime.rs` prepares one image and passes it to
  `msb create --pull never`, with CPU, memory, disk and workspace configuration.
- [Guest images](SiloUI-GUEST-IMAGES.md) documents pinned ARM64/AMD64 artifacts.
  The optional desktop package set needs its own version, inventory and verified
  artifact provenance; installing it must preserve existing guest configuration.
- [Networking](SiloUI-NETWORK-PLAN.md) documents host-loopback forwarding and
  remote SSH tunnels. Guest-loopback-only listeners are not reachable through
  the current publisher. Expose KasmVNC's authenticated web endpoint on a
  reachable guest interface through the existing host-loopback publisher.
  Use TCP/WebSockets initially; the existing transport does not manage UDP.
- The bundled runtime is patched MicroSandbox 0.6.17. Current upstream features
  are not proof of bundled capability.

## Selection evidence

[MicroSandbox](https://github.com/superradcompany/microsandbox) runs OCI images
with VM isolation. A graphical Linux userspace can be packaged in such an image;
an ISO installer and physical display are not required by the proposed design.

[KasmVNC's tagged 1.5.0 documentation](https://github.com/kasmtech/KasmVNC/blob/v1.5.0/README.md)
describes its integrated browser client, resizing, compression and shared
sessions. Its browser delivery avoids maintaining separate TigerVNC, noVNC
and WebSocket bridge components. It does not support standard VNC clients;
that is an accepted tradeoff for Silo's browser-based viewer.

The [published 1.5.0 assets](https://github.com/kasmtech/KasmVNC/releases/expanded_assets/v1.5.0)
include Ubuntu Noble packages for both AMD64 and ARM64, with SHA-256 hashes.
The release assets are dated 2026-07-29. This establishes package availability,
not execution in MicroSandbox. Pin the exact artifacts during implementation.

[Release history](https://github.com/kasmtech/KasmVNC/releases) records CPU,
client memory and encoding improvements as well as screenshot-handler and
multi-monitor fixes. These are maintenance evidence and vendor claims, not
independent proof that KasmVNC beats TigerVNC on Silo workloads.

[Xfce](https://www.xfce.org/about) explicitly targets a lightweight desktop.
Use a minimal session, disable compositing and screen locking, and fix the
initial resolution. Keep the distribution's supported package set. Xfce's
[4.20 tour](https://xfce.org/about/tour) calls Wayland support experimental;
X11 is the deliberate compatibility choice for this unattended desktop.

TigerVNC/noVNC remains a useful benchmark baseline, not another product option.
Do not introduce the full Kasm Workspaces orchestration platform. Silo already
owns VM creation and lifecycle. Xpra's individual-application forwarding is
not the primary requirement. A bare window manager saves components but leaves
more desktop behavior for Silo to assemble.

### Established teams and current remote-desktop work

[LinuxServer.io Webtop](https://docs.linuxserver.io/images/docker-webtop/)
provides full browser-accessible desktops on AMD64 and ARM64, currently using
Selkies. Its documentation covers clipboard, session sharing, audio/microphone
and file transfer. This is relevant product precedent that the first comparison
omitted, not proof that its complete container can retrofit an existing Silo VM.

[Selkies](https://github.com/selkies-project/selkies) describes origins with
Google engineers and ongoing development by researchers, LinuxServer.io and
community contributors. It documents CPU/GPU streaming, X11/Wayland and default
WebSocket transport; it should not be dismissed as GPU-only or UDP-only.
Its [platform architecture](https://docs.linuxserver.io/selkies/developer-guide/architecture/)
is a reference for a richer multimedia desktop. These are project descriptions,
not independent performance measurements or a current Google support promise.

Retain KasmVNC as the selected first implementation because its standalone
Ubuntu packages fit the newly explicit requirement to install into an existing
guest with minimal lifecycle changes. Selection is based on integration fit,
not a claim of measured superiority to Selkies. Multimedia requirements would
require further validation of the selected delivery stack.

For browser-only tasks, compare against Playwright and an isolated browser.
The full desktop earns its cost when tasks require native apps, OS dialogs or
interaction across applications. Prefer structured browser operations when
they satisfy the task, with screenshots for visual verification.

## Agent compatibility

The product boundary is a normal Linux desktop, independent of agent harness.
Silo owns installation, session lifecycle, a human viewer and documented guest
session access. Users choose their harness, model and Linux computer-use tools.
A Silo-specific plugin or agent runtime must not be required.

There are three independent compatibility boundaries: the plugin/skill must
load in the selected harness; its control backend must support Linux X11 and
the guest architecture; and it must target Silo's shared desktop session. The
harness/model must also support its screenshot/image observation path. Neither
a GUI nor a plugin package makes all three boundaries portable automatically.

Inside-guest tools can access the documented DISPLAY, X authorization and,
where needed, session D-Bus environment. A host-running harness requires a
guest-side backend and an explicit supported remote transport. A host-local
computer-use plugin does not automatically change its target to the VM.

[MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
standardize tool discovery/calls and image results, not a universal desktop
action schema or cross-harness plugin packaging. A tested optional MCP adapter
can simplify setup for compatible clients; ordinary scripts/skills that use
Linux control tools must remain usable without it.

[Official Computer Use product documentation](https://learn.chatgpt.com/docs/computer-use)
documents macOS and Windows desktop support. It does not establish installation
of this session's desktop plugin inside an arbitrary Linux VM.

[OpenAI's integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)
separately document a Linux desktop with Xvfb, Xfce and x11vnc, and an action
handler for screenshots, clicks and keystrokes. Build or select an adapter for
the intended agent, such as an MCP server exposing a small screenshot/input
surface. The model runs through its provider; the tool and apps can run inside
the guest. The agent and human viewer must share the same display/session.
Pixel control does not automatically reproduce native accessibility features.

An optional reference MCP adapter can wrap guest-local X11 operations;
[PyAutoGUI](https://pyautogui.readthedocs.io/en/latest/index.html) supplies the
basic mouse, keyboard and screenshot primitives. Unicode entry needs explicit
coverage and a guest-local clipboard insertion path. This adapter remains
integration work, not a verified bundled plugin.

Capture lossless screenshots directly from the guest display; do not make the
agent inspect the compressed remote viewer. Keep one display at 1440x900 while
the agent is active and scale the human viewer without resizing that display.
Take screenshots on demand rather than feeding video to the model. Silo must
coordinate human takeover with a pause in agent input for cooperating adapters.
It cannot universally pause arbitrary harnesses or tools that access X11
directly; users must pause those agents in their harness. These are proposed
defaults to validate, not measured optima.

## Costs and limits

Unmeasured planning budgets for one desktop plus light browser use:

| Resource | Initial budget |
| --- | --- |
| Guest memory | 2–4 GiB; start with 4 GiB alongside an agent/toolchain |
| Guest CPU | 2 vCPUs; consider 4 for simultaneous builds |
| Additional desktop download | Approximately 0.5–1.5 GB |
| Additional installed packages | Approximately 2–5 GB, excluding profiles/caches |

These are estimates, not minimum requirements or benchmarks. Measure actual
host RSS, idle/busy guest use, download size, allocated disk and startup time.
The browser and workload can dominate the desktop. Multiple running desktops
multiply resource pressure. Local execution needs no hosted-desktop fee;
agent subscription/API charges and maintenance remain. Exact model cost needs
a chosen model and a measured action trace.

Software rendering targets ordinary 2D apps. Do not promise accelerated 3D,
video editing or Windows/macOS application compatibility. Upstream
[libkrun](https://github.com/libkrun/libkrun) has optional GPU features, but that
does not prove Silo exposes or bundles them.

Implementation planning estimate: 1–3 engineer-days for a disposable proof,
then roughly 1–3 engineer-weeks for a limited supported feature if the proof
passes. This is not a delivery commitment. Guest supervision, image updates,
authentication, remote transport, restart, backup and both architectures are
the material integration work.

## Proof and acceptance

1. Boot the desktop using the exact bundled engine in a disposable runtime home.
   Verify process supervision, D-Bus, fonts, browser packaging, sandbox support
   and shared-memory behavior. Do not assume a systemd login session.
2. Run the intended agent inside the guest. Capture a screenshot, type Unicode,
   click, scroll and complete a file-picker/download workflow using the same
   display visible to the human. Verify the resulting file independently.
3. Stop/restart and reconnect. Check desktop readiness separately from VM health,
   detect failed services and arbitrate human/agent input.
4. Measure the costs above on Apple Silicon and Linux/KVM; verify remote viewing
   through existing SSH transport before declaring platform support.
5. Exercise installation on an existing sandbox with pre-existing tools and
   files and desktop stop/start. Confirm independent terminal jobs,
   workspace contents and user-installed dependencies survive. Then add desktop
   enablement to existing VMs and creation, a Desktop view, health reporting and
   backup/restore coverage.

Run GUI apps as a normal guest user with passwordless sudo, authenticate viewing/control, avoid host
display socket sharing and disable automatic host clipboard/file sharing.
VM isolation does not protect accounts deliberately logged into the guest.

Next action: build a disposable proof on an existing terminal-only VM. Have the agent
create a file in a native editor, upload it through a browser's file picker to
a local test page, and verify its contents. Repeat after VM restart and viewer
reconnect, recording resource use and action failures on the supported hosts.
