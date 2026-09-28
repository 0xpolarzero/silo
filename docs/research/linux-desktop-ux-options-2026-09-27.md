# Linux desktop UX for Silo

Research date: 2026-09-27. This is a product and platform proposal, not a
benchmark or an implementation report. It compares primary-source product and
project documentation with Silo's checked-in desktop and agent requirements.
All capabilities attributed to upstream products below are documented claims;
none of the proposed combinations were run in this research.

## Recommendation

Design one persistent Linux GUI session attached to the sandbox and make the
full desktop its source of truth. Its running applications, workspace files,
terminal jobs, and agent target survive changes in viewer and transport. Start
with the full desktop because it is the reliable common denominator for human
and agent use. Offer native app windows only if a candidate exposes windows
from that same display/session; an app mode that launches a second X server or
login is a separate workspace and fails this contract. Xpra documents seamless
applications and full desktops, but those separate modes do not by themselves
prove switching between the same app session and full desktop. Qualify that
boundary before proposing an Apps toggle.

For remote computers, compare KasmVNC full desktop (baseline) with Xpra and
Selkies 2.0 full-session streaming. Xpra is the strongest candidate if
same-session seamless window forwarding can be established. Selkies 2.0 is a
stable release (2026-09-23), not an RC: its official docs describe a bundled
browser client and X11/headless-Wayland backends with clipboard, file transfer,
audio and app controls. Selkies documents a streamed desktop, not native
host-level app windows. Its new release is not a measured Silo win. The Xpra
Wayland backend remains documented as experimental. Do not claim that any path
is better on clarity, latency, resource use, or reliability until measured.

For local macOS Linux VMs, evaluate a native VM display before adding a remote
stream. Apple's Virtualization.framework provides `VZVirtualMachineView` for
Linux guests on macOS 13+; it renders the VM framebuffer, forwards keyboard and
pointer input, can capture system keys, and can follow the host view size. It
does not directly display Silo's current MicroSandbox/libkrun VM: that requires
an engine/device integration or supported runtime path. QEMU+SPICE with
CocoaSpice is a separate Mac client option. Keep a shared Silo session/view
contract while qualifying local and remote delivery independently.

This is a proposed workflow advantage over commodity remote desktop: the
desktop is a first-class view of the sandbox the user already created. The
terminal, shared project directory, GUI apps, agent, and lifecycle controls
belong to one named workspace. The smallest offer worth testing is “open this
project's native Linux app, then let me and my agent work in the same live
session.” That addresses work the SSH-plus-browser/CLI workaround cannot
complete, such as desktop-only applications, OS dialogs, and cross-app visual
tasks. The repo documents the architecture and gap, but does not establish
weekly user dependence or willingness to pay; validate those before expanding
into a general remote-workstation product.

## Product precedents and their limits

| Product/pattern | Verified from official documentation | Limit for Silo |
| --- | --- | --- |
| **Xpra seamless windows + desktop** | Seamless mode puts each remote app in a movable/resizable host window, preserves apps after disconnect, and supports SSH. Desktop mode shows a full environment. | HTML5 windows remain inside the browser. The Wayland backend is experimental; Xpra requires a supported server display environment. Separate seamless and desktop modes do not prove the same display can switch between rootless windows and a whole desktop. [Seamless mode](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Seamless.md), [usage guide](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/README.md) |
| **Selkies 2.0 full-session streaming** | Stable 2.0.0 shipped 2026-09-23. Official docs describe one WebSocket port by default carrying video, audio, input, clipboard, and file transfer; browser client supports X11/headless Wayland, selectable app settings, and Chromium/Firefox/Safari. | Browser-first streamed session; no documented native host-app window forwarding. This major new implementation has no Silo qualification. A single server process still carries a dependency tree. [Release](https://github.com/selkies-project/selkies/releases/tag/2.0.0), [web client](https://docs.selkies.io/latest/components/web-client), [component](https://docs.selkies.io/latest/component/) |
| **Microsoft RemoteApp / RAIL** | RemoteApp is an established published-application pattern in Windows Remote Desktop Services. xrdp documents RAIL as an RDP channel setting, alongside clipboard, audio, and device channels. | RAIL being allowed by xrdp does not prove xrdp implements a complete Linux RemoteApp host. Treat this as a UX precedent; require an end-to-end Linux implementation before selecting it. [Microsoft RemoteApp](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remote-desktop-services-overview), [xrdp channels](https://github.com/neutrinolabs/xrdp/blob/devel/docs/man/xrdp.ini.5.in) |
| **Amazon DCV** | Official client matrix covers native and web clients, copy/paste, file transfer, audio, multi-monitor, and full-screen extension. Native clients support up to four displays at 4096x4096 each by default; browser resolution defaults to 1920x1080 and browser multi-screen to two displays. | Powerful feature benchmark, but server setup is substantial and Linux service uses an X session; AWS documentation says Ubuntu 22.04/24.04 needs GNOME/GDM and disables Wayland. Multi-monitor is disabled while collaborating. [Feature matrix](https://docs.aws.amazon.com/dcv/latest/userguide/client-features.html), [monitor limits](https://docs.aws.amazon.com/dcv/latest/userguide/using-multiple-screens.html), [Linux prerequisites](https://docs.aws.amazon.com/dcv/latest/adminguide/setting-up-installing-linux-prereq.html), [collaboration/multiple screens note](https://docs.aws.amazon.com/dcv/latest/userguide/using-multiple-screens.html) |
| **Jump Desktop** | Strong attended-session pattern: show who is connected, request approval, choose view-only or control, show remote pointers, and let the host stop sharing. Its CLI/MCP documents AI agents that connect, view, and control with human monitoring/takeover. | Current Jump docs label Linux Connect alpha and not for production. Linux no-user sessions require X11 and close about 30 seconds after the last user disconnects. Browser has clipboard/audio but no file transfer, observe mode, or privacy mode; screen sharing disables virtual displays and clipboard. [Remote support](https://docs.jumpdesktop.com/viewer/workflows/remote-support/), [Linux Connect status](https://docs.jumpdesktop.com/connect/install/), [unattended Linux behavior](https://docs.jumpdesktop.com/connect/unattended-access/), [browser limits](https://docs.jumpdesktop.com/viewer/browser/), [agent MCP](https://docs.jumpdesktop.com/cli/) |
| **Parsec** | Useful input preferences: immersive mode can pass shortcuts to the host; macOS modifier swapping addresses Command/Ctrl; per-display settings and virtual-display support are documented. | Linux is a client only; Parsec documents hosting on Windows and macOS. Virtual displays are also Windows/macOS host features. Its optimized streaming focus does not solve the Linux VM host case. [Linux client](https://support.parsec.app/hc/en-us/articles/32381494397332-Parsec-App-for-Linux), [compatibility](https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility), [virtual displays](https://support.parsec.app/hc/en-us/articles/32381733729044-Multiple-Monitors-and-Virtual-Displays) |
| **Chrome Remote Desktop** | Supports unattended Linux access with a selectable desktop session and one-time approved support codes; enterprise documentation exposes access and network policies. | It is a whole-machine remote desktop routed through Google services, not a sandbox-aware app/session API. Its support flow's 30-minute approval renewal is not the fit for persistent agent/human work. No first-party evidence here establishes native remote app windows, high-DPI controls, or multi-monitor behavior. [Linux setup and support](https://support.google.com/chrome/answer/1649523?hl=en), [admin controls](https://support.google.com/chrome/a/answer/2799701?hl=en) |
| **Apple Virtualization view / QEMU+SPICE+CocoaSpice (local macOS)** | Apple's `VZVirtualMachineView` displays the VM framebuffer, forwards keyboard/mouse, can capture system keys, and can reconfigure guest display size with the view. CocoaSpice documents native macOS rendering, clipboard and SPICE channels; UTM documents multi-display and resolution-change behavior via `spice-vdagent`. | Apple's view is tied to Virtualization.framework, so it cannot render Silo's MicroSandbox/libkrun VM without a different runtime/device path. CocoaSpice is a QEMU/SPICE client, not a remote Linux app/window server, and needs its own display/clipboard/IME testing. [Apple view](https://developer.apple.com/documentation/virtualization/vzvirtualmachineview), [CocoaSpice](https://github.com/utmapp/CocoaSpice), [UTM graphics](https://github.com/utmapp/UTM/blob/main/Documentation/Graphics.md), [UTM architecture](https://github.com/utmapp/UTM/blob/main/Documentation/Architecture.md) |

**RDP is a protocol, not the experience.** xrdp documents an Xorg-backed Linux desktop, reconnect, dynamic resize, bidirectional text/bitmap/file clipboard, optional audio/microphone modules, and drive redirection. GNOME Remote Desktop documents remote assistance, single-user headless, and GDM-backed headless login modes; modes differ by protocol and service. The GNOME headless arrangement is a serious Wayland-capable challenger, not a drop-in assumption for Ubuntu 24.04 packages or an embedded Silo viewer. [xrdp overview](https://github.com/neutrinolabs/xrdp), [GNOME Remote Desktop modes](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md).

## Linux desktop and compositor choice

No desktop environment wins all Silo objectives. Existing repo research ranks Xfce/X11 as a compatibility baseline, with MATE, LXQt/Openbox, Plasma and GNOME as candidates, and explicitly leaves the measured outcome unranked. Retain that evidence boundary.

| Environment | Product value | Constraints to qualify |
| --- | --- | --- |
| **Xfce/X11** | Current Silo session; conservative for legacy GUI automation and X11 input tools. Existing guest contract supplies Xfce, KasmVNC, one 1440x900 display, viewer scaling, and shared human/agent X11 access. | Current fixed desktop resolution is not a HiDPI solution: scaling a 1440x900 framebuffer into a Retina window can enlarge pixels rather than produce finer text. IME/CJK and clipboard are explicitly unverified in the repo. X11 automation has broad access to other clients; the VM boundary is not an app-level permission boundary. [Silo desktop contract](../SiloUI-DESKTOP.md), [agent access research](desktop-selection-agents-2026-09-22.md) |
| **GNOME 50/51 Wayland flagship candidate** | Current-generation GNOME is the product-quality challenger for first-run coherence, accessibility and integrated settings. GNOME Remote Desktop documents headless single-user and remote-login modes, using PipeWire/libei/Mutter. | Earn its place through target-image tests: package support, rendering/CPU, accessibility, remote input and reconnect. Remote mode and portal permissions need unattended qualification. Do not award it credit for polish or a latest API alone. [GNOME Remote Desktop architecture](https://github.com/GNOME/gnome-remote-desktop), [mode configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md) |
| **Xfce/X11 CPU baseline** | Current installed session and small conventional setup provide a useful CPU-oriented control. X11 has a broad legacy automation surface. | Existing compatibility is not quality evidence and earns no selection points. The fixed 1440x900 stream is not HiDPI: scaling enlarges pixels rather than adding detail. IME/CJK and clipboard remain unverified. X11 tools can observe/control other clients in the display. [Silo desktop contract](../SiloUI-DESKTOP.md), [agent access research](desktop-selection-agents-2026-09-22.md) |
| **Plasma/KWin Wayland** | Extensive KWin scripting/window surface; potentially strong desktop-native app/window control and user-facing controls. | Requires a purpose-built compositor adapter and version pins. Neither a scripting API nor a Wayland portal by itself grants unattended control or quality accessibility for arbitrary applications. Silo agent research says qualify compositor + portal, not a generic “Wayland supported” flag. [Repo agent research](desktop-selection-agents-2026-09-22.md) |
| **Sway/wlroots** | Compact, explicit window tree and IPC make it attractive for agent orchestration. | `xdg-desktop-portal-wlr` documents ScreenCast and Screenshot, but not RemoteDesktop input. A window manager is not a complete consumer desktop. Do not count screenshot support as pointer/keyboard capability. [Repo agent research](desktop-selection-agents-2026-09-22.md) |
| **Xpra X11** | A display/server route as well as the app forwarding layer; best fit for the proposed app+desktop prototype and X11-based guest automation. | Current HTML5 client cannot make windows into actual macOS top-level windows; regular Xpra client is required. Exact native client embedding, clipboard/IME, audio, keyboard map, and supported macOS/Linux versions remain to test. [Xpra seamless mode](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Seamless.md) |
| **GNOME Remote Desktop RDP** | Standard client ecosystem and first-party support for headless modes. Headless does not require a physical monitor by definition in the documented mode. | RDP integration inside Tauri, credentials/certificate lifecycle, headless monitor creation/resizing, IME, multi-monitor and reconnect need qualification. Its use of PipeWire/libei is not proof all agents can automate unattended without a consent UI. [GNOME docs](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md) |

**Decision:** qualify GNOME 50/51 Wayland as the flagship and Xfce/X11 as the
CPU baseline, each against complete session/transport/agent combinations.
Compare full-session KasmVNC (control), Selkies 2.0, and Xpra desktop mode;
test seamless windows only if they attach to that same display. Current Xfce
compatibility is a control, not a score bonus. GNOME headless support is a
reason to test it, not proof that it fits Silo's target image or runtime.

## Proposed Silo experience

The entry point belongs beside the sandbox terminal, files, and lifecycle. It
should feel like opening another view into the selected sandbox, not launching
a separate remote-computer product. The VM/session manager owns session and
process lifetime; viewer windows are disposable attachments. Closing a view
never stops the desktop.

1. **Open Desktop** resumes the running graphical session or starts it and
   reports concrete state: starting, ready, reconnecting, stopped, or failed.
   A reconnect returns to the same app windows and unsaved application state
   while the VM remains running. Explain that stopping the desktop closes GUI
   apps; closing the view disconnects only. Keep Silo's existing lifecycle
   semantics visible.
2. **Apps** is a convenience view, not a promised second session. It may open
   an installed app as a host-native window only after proving it uses the same
   display. **Desktop** reveals the full Linux session. The user may switch
   without restarting apps. If native windows require another X server, show
   that as a separate session or omit it; never imply continuity.
3. **Readable view** uses negotiated guest resolution and scale factor. Default
   to “Fit” with pointer-coordinate mapping; provide “More workspace” and
   “Sharper text” controls, with current guest resolution and scale in a small
   status menu. When window resizing changes guest resolution, debounce it and
   show “Changing display…” until guest confirmation. Keep an explicit fixed
   resolution option for agents/tools that need stable coordinates.
4. **Input profile** preserves host shortcuts by default and gives users an
   explicit “Linux key map” profile. Do not globally map Command to Ctrl:
   Ctrl+C means interrupt in a terminal, while Cmd+C means copy on the host.
   Use semantic app-aware shortcuts only where the app exposes a reliable
   mapping; show the active profile, reserve Silo disconnect/quit keys, and
   report host/guest keyboard layout and IME composition state. Do not promise
   international input based on ASCII typing.
5. **Files** is a Silo workspace panel backed by the same sandbox workspace
   directory exposed to GUI applications. Dragging between that panel and an
   app transfers actual project files, not only pixels. Expose “Open in Linux”
   and “Save to workspace” actions; display transfer direction/progress and
   make a completed file immediately visible in the terminal/files view. Avoid
   depending on remote desktop protocol drive sharing for the core workflow.
6. **Clipboard** starts with text enabled and makes image/file clipboard policy
   explicit. A toolbar item shows direction and last-sync state; offer pause,
   guest-to-host, host-to-guest, and both-directions controls. Never make a
   clipboard failure look like a successful paste. Avoid polling/replacing the
   user's clipboard when a session is disconnected.
7. **Audio** exposes an output mute and an opt-in microphone button. Indicate
   when audio is active. Do not assume browser/native viewer codec support or
   enable microphone capture without an explicit action.
8. **Multi-monitor** starts with a single high-density virtual display sized to
   the Silo pane. Add more displays only after layout, topology changes,
   fullscreen, mixed DPI and remote-app window placement pass. Keep monitor
   count and resolution visible in Display settings; provide reset-to-one-screen.
9. **Agent handoff** reuses the existing guest session. A compact activity chip
   says “You control,” “Agent controlling,” or “View only,” and names the active
   agent. Explicit delegation authorizes that task's supported agent adapter
   until revoked; do not ask for a new grant on every reconnect. A server-side
   control lease gates supported agent input. “Take control” revokes the lease,
   pauses/cancels that adapter, and waits for acknowledgement before viewer
   input resumes. Show the agent pointer and recent action/status. Multiple
   viewers can observe; one supported actor holds the lease at a time. Guest
   processes with raw X11 access can bypass this lease, so the UI cannot promise
   arbitration over arbitrary guest tools. Prefer semantic AT-SPI actions where
   available; record control transitions, not screen contents.
10. **Reconnect** is a view lifecycle, not a guest lifecycle. Distinguish
    transport disconnected from guest session stopped. Retry automatically
    with bounded backoff; retain the last frame with a clear “Reconnecting”
    overlay and block stale coordinate input. Once reattached, re-read display
    geometry before enabling control. Offer explicit retry and copied
    diagnostic code on failure.

The UX borrows Jump's clear observe/control state and host-visible identities,
DCV's monitor/quality/audio/file feature discoverability, and Xpra's persistent
apps alongside a full desktop. Silo's differentiator is that views and agents
attach to the sandbox's already-associated project, file store, terminal and
lifecycle; the research does not claim a unique technical remote display
feature.

## Acceptance criteria

These are proposed gates, not results. Record exact app, guest image, host OS,
viewer build, server/client versions, architecture, resolution, scale, network
and test source (fixture/live). Keep UI tests on fixtures and actual GUI tests
in disposable VMs.

### Readability, resize, and display

- On a Retina Mac and a standard-density Linux host, display editor text at
  100% guest scale and at fit-to-window. A fixed source document includes
  10–14 px Latin text, CJK text, thin strokes, syntax colors, and a one-pixel
  grid. User can read every line without horizontal blur at the default size;
  screenshots of guest and viewer are saved for review.
- Resize the viewer from half to full window size and across a second monitor.
  Pointer clicks land on the intended control at all sizes. If the guest
  resolution changes, guest and client report the same dimensions before input
  resumes. Repeat with 1x, 2x, mixed-DPI displays, and fullscreen exit.
- Attach a second monitor and unplug/rearrange it during the session. The guest
  recovers a valid layout without windows becoming unreachable. Until this
  passes, multi-monitor stays out of the default path.

### Keyboard, IME, accessibility

- Verify US, French AZERTY, German QWERTZ, and Japanese or Chinese IME. Include
  dead keys, accents, compose sequences, CJK composition/candidate selection,
  repeat, keypad, function keys, AltGr, and terminal Ctrl-C. Compare typed text
  exactly against a reference string in a GTK editor, a Qt app, a browser input,
  and a terminal.
- Verify Command+C/V/A/Z maps to the named Linux profile; host app switching,
  Silo quit, and the configured “send Linux keys” chord are deterministic. The
  UI displays the active mapping and never traps the user's only way to
  disconnect.
- For a GTK app and a Qt app, exercise accessible tree, names/roles/states,
  focus, text entry and a semantic action through AT-SPI. Report unavailable
  semantics accurately and prove pixel fallback still works. Test Screen Reader
  operation as its own acceptance item before calling the desktop accessible.

### Files, clipboard, and audio

- Drag a 1-byte file, a 10 MB file, and a Unicode filename from Silo Files into
  Linux Files and back. Compare SHA-256; cancellation and reconnect leave either
  a complete file or a clearly identified partial file that can be removed.
- Copy/paste plain text with Unicode and multiline content in both directions.
  Verify image clipboard if supported. If files are excluded from clipboard,
  communicate that and route file operations through Silo Files.
- Mute, unmute, change guest output, and play continuous audio while the window
  is resized/reconnected. Prove no microphone stream exists until the user
  activates it, and that mute stops local playback promptly.

### Session state and human/agent handoff

- Launch editor with an unsaved buffer, a GUI process marker and a terminal
  background job. Close/reopen the viewer and interrupt/recover the display
  transport. All three survive; the saved workspace file is readable from the
  Silo terminal. Explicit desktop stop closes GUI apps while the independent
  terminal job and VM remain alive, matching the current product contract.
- Run a supported agent adapter against the same screen that the human sees.
  Confirm screenshot geometry, pointer coordinate mapping and latest frame;
  drive one semantic action and one pixel action in the same app. The user can
  observe, pause, take control, and return control without two simultaneous
  actors. Cancel an in-flight agent action and verify no later injected event
  arrives after control transfer acknowledgement.
- Disconnect transport while an agent action is in flight. Inputs stop, state
  reports “Reconnecting,” and stale coordinates cannot be replayed after
  reconnect. Geometry and permissions are re-read before control resumes.
- Test viewer reconnect after temporary network loss, owner app sleep/wake,
  remote SSH-tunnel drop, and VM reboot. Reboot is expected to lose unsaved RAM
  state unless a checkpoint product contract says otherwise; the UI must not
  imply that saved files restore GUI process memory.

### Product demand and comparison

- Put the prototype in front of five people with a recent task that required a
  Linux GUI inside a sandbox. For each, record the concrete app/task, what the
  SSH-plus-browser/CLI workaround cost in steps/time, whether it recurs weekly,
  and whether the user commits to paying a named price to avoid that workaround.
  Interest or “looks useful” does not pass. If no one has a recurring blocked
  task, keep desktop as an optional capability and do not expand scope.
- Have each user complete one app task via full desktop, one via seamless app
  view, and the closest existing workaround. Compare completion, errors, and
  elapsed time for equal tasks; publish failures and denominators. No performance
  or time-saving claim is allowed from feature lists or one successful demo.

## Evidence boundary and source trail

Repository context: [current Silo desktop contract](../SiloUI-DESKTOP.md),
[desktop selection](../SiloUI-DESKTOP-SELECTION.md), [agent API comparison](desktop-selection-agents-2026-09-22.md),
[viewer comparison](desktop-selection-viewers-2026-09-22.md),
[checkpoint and desktop direction](checkpoints-desktop-direction-2026-09-24.md),
and [native display assessment](msb-native-display-2026-09-27.md). Those docs
record the installed KasmVNC/Xfce behavior, the earlier candidate analysis,
current agent requirements, and why the native display route remains a
qualification experiment.

Official external sources used above:

- Xpra: [seamless applications](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Seamless.md), [usage](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/README.md).
- Selkies 2.0: [stable release](https://github.com/selkies-project/selkies/releases/tag/2.0.0), [web client](https://docs.selkies.io/latest/components/web-client), [component](https://docs.selkies.io/latest/component/).
- Microsoft RDS: [Remote Desktop Services overview](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remote-desktop-services-overview).
- xrdp: [project feature summary](https://github.com/neutrinolabs/xrdp), [RDP channel settings](https://github.com/neutrinolabs/xrdp/blob/devel/docs/man/xrdp.ini.5.in).
- Amazon DCV: [client feature matrix](https://docs.aws.amazon.com/dcv/latest/userguide/client-features.html), [multi-screen](https://docs.aws.amazon.com/dcv/latest/userguide/using-multiple-screens.html), [Linux prerequisites](https://docs.aws.amazon.com/dcv/latest/adminguide/setting-up-installing-linux-prereq.html), [clipboard](https://docs.aws.amazon.com/dcv/latest/userguide/using-copy-paste.html).
- Jump Desktop: [remote support](https://docs.jumpdesktop.com/viewer/workflows/remote-support/), [Linux Connect install status](https://docs.jumpdesktop.com/connect/install/), [unattended Linux session](https://docs.jumpdesktop.com/connect/unattended-access/), [browser client limits](https://docs.jumpdesktop.com/viewer/browser/), [Jump CLI and AI agent MCP](https://docs.jumpdesktop.com/cli/).
- Parsec: [Linux client support](https://support.parsec.app/hc/en-us/articles/32381494397332-Parsec-App-for-Linux), [host compatibility](https://support.parsec.app/hc/en-us/articles/32381568346644-Hardware-and-Software-Compatibility), [display support](https://support.parsec.app/hc/en-us/articles/32381733729044-Multiple-Monitors-and-Virtual-Displays).
- Chrome Remote Desktop: [Linux access and support](https://support.google.com/chrome/answer/1649523?hl=en), [admin control](https://support.google.com/chrome/a/answer/2799701?hl=en).
- GNOME Remote Desktop: [project architecture](https://github.com/GNOME/gnome-remote-desktop), [mode configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md).
- Local native views: [Apple Virtualization view](https://developer.apple.com/documentation/virtualization/vzvirtualmachineview), [CocoaSpice](https://github.com/utmapp/CocoaSpice), [UTM graphics](https://github.com/utmapp/UTM/blob/main/Documentation/Graphics.md), [UTM architecture](https://github.com/utmapp/UTM/blob/main/Documentation/Architecture.md).

## Next action

Run disposable VM trials for GNOME 50/51 Wayland and Xfce/X11 against KasmVNC,
Selkies 2.0 and Xpra desktop mode, using one GUI app and one agent task. For
Xpra, prove whether the same server display can switch between a whole desktop
and host-native app windows without launching a second session. Compare exact
text/IME, same-session agent access, coordinate stability, clipboard/files,
reconnect, and native-local versus streamed-remote paths. Ask five users with
a recent blocked GUI task to commit to a paid pilot at a stated price. Continue
only if both the interaction contract and recurring workaround cost are
demonstrated.
