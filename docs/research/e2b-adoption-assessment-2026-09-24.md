# E2B adoption assessment for Silo

Date: 2026-09-24. Recommendation, not an approved product decision or runtime
change. This assessment reopens the choice of backend; the replacement plan is
a conditional implementation plan, not evidence that replacement is worthwhile.

**Follow-up correction, 2026-09-24:** the comparison below accurately describes
Silo's pinned 0.6.17, but omitted upgrading MicroSandbox as a fourth option.
Released 0.7.2 already contains full snapshots, live branches and CoW memory.
The user's subsequent proposal makes these features part of the desired Silo
direction. Qualify that upstream upgrade first; do not treat E2B as the only
available implementation. See the [new evidence and acceptance requirements](checkpoints-desktop-direction-2026-09-24.md).
The desktop-only experiment below remains useful, but the runtime qualification
now takes priority. No upgrade has been executed.

**Recommendation: retain MicroSandbox for the current product and refactor the
desktop image, session lifecycle and viewer integration. Do not adopt the full
E2B backend merely to obtain its packaged desktop/viewer experience.**

E2B supplies a substantial additional capability: persistent memory checkpoints,
resume and forks of running environments. That is a valid reason to evaluate a
different runtime. Its desktop package alone does not justify the current
cutover: our Apple Silicon deployment still owns the guest recipe and viewer
integration, adds an execution host and control plane, and must replace several
working runtime integrations. The tested candidate also has unresolved state
preservation failures. Fixing those failures is necessary but would not, by
itself, establish a benefit for the desktop-only objective.

## Evidence and comparison boundary

Compared three concrete choices:

1. **Current Silo:** shipped integration of pinned MicroSandbox 0.6.17 plus
   Silo's checked-in patch, Ubuntu 24.04 guest, optional Xfce/KasmVNC desktop,
   native Tauri viewer and Silo's local/remote product services.
2. **Targeted refactor:** retain that VM engine and product services; package
   the desktop in the existing versioned guest-image pipeline and qualify an
   upstream viewer/server combination independently of the engine.
3. **E2B cutover:** the self-hosted Embed architecture actually tested, with a
   Linux execution host on macOS, Firecracker guests, Silo's ARM64 desktop
   template, SDK adapter and Silo-owned product policies. E2B Cloud and BYOC
   are separate deployments; their features do not automatically exist in Embed.

Repository code and dated execution reports establish current behavior and
measured subsets. Upstream documentation/source checked today establishes
published capabilities. A documented capability is not an executed Silo pass.
No new VM, desktop, account, credential or benchmark was run for this assessment.
No test supports an overall speed, efficiency or reliability ranking between
the complete stacks. Those claims receive no credit in the recommendation.

## What the desktop package actually replaces

E2B's [desktop template](https://github.com/e2b-dev/desktop/blob/main/template/template.py)
assembles Ubuntu 22.04, Xfce/Xvfb, x11vnc, an E2B noVNC fork and websockify.
Its Chrome and VS Code repository entries target AMD64. This is useful upstream
integration, but it is not the unchanged ARM64 image used by our PoC.

Our [template](https://github.com/0xpolarzero/silo/blob/c122a498da064f08321c29bff82a6e92056a917d/experiments/e2b-local/template.py) instead builds Debian
trixie with distribution desktop packages, Firefox, OpenSSH and LCU. Our
[desktop launcher](https://github.com/0xpolarzero/silo/blob/c122a498da064f08321c29bff82a6e92056a917d/experiments/e2b-local/start-desktop.sh) starts the
display, session, control/observer servers and bridges. The distinction matters:
the successful Mac trial does not show that E2B has assumed maintenance of our
complete desktop appliance.

The [Desktop SDK](https://github.com/e2b-dev/E2B/blob/main/packages/desktop-python/e2b_desktop/main.py)
starts the display/session and VNC processes, offers screenshot and input
helpers, and creates viewer URLs. Its helpers use scrot/xdotool. Its view-only
URL setting is client configuration, not Silo's server-enforced ownership
contract. Silo still needs the native webview integration, protected transport,
current session authorization and human/agent handoff. Retaining LCU means the
Desktop SDK's input helpers do not replace the agent-control layer either.

Packaging standard components has value. Here, much of that value is separable
from E2B: Silo already builds and distributes [versioned OCI guest images](../SiloUI-GUEST-IMAGES.md).
Moving desktop provisioning into that pipeline does not require a new VM engine.
It does require a new image and acceptance tests; it is not already completed.

## Feature inventory

“Existing” below describes implementation, not universal platform qualification.
The evidence columns and coverage section distinguish actual tests.

| Capability | Current Silo | E2B route | Assessment |
| --- | --- | --- | --- |
| Isolated Linux VMs | MicroSandbox/libkrun; native host virtualization | Firecracker/KVM; nested inside the Mac execution host | Both provide VM boundaries. No comparative security superiority established. |
| Local macOS execution | Published Apple Silicon/macOS 14+ target | Documented nested route requires M3+/macOS 15+; M4 Max trial passed | Concrete compatibility loss for local execution, already accepted for evaluation. |
| Linux execution | ARM64/x86-64 packages, KVM requirement | ARM64/x86-64 KVM; small x86-64 guests passed on devbox | E2B has useful executed remote/Linux evidence; neither complete desktop matrix is proven. |
| Desktop ready at creation | Desktop currently installs after VM creation | Template can capture an already-started desktop | Prepared disk image is achievable on either engine; captured running desktop is an E2B benefit. |
| Desktop applications and appearance | Xfce/X11, shared working account | Xfce/X11 in the tested recipe | No demonstrated usability improvement from the engine. |
| Browser/native viewer | KasmVNC in Tauri child webview | noVNC in Tauri harness | Viewer replacement is independent of VM replacement. |
| Human/agent control ownership | Silo session/agent integration | PoC adds owned viewer tickets, epochs and separate observer route | Still product policy, not an automatically supplied E2B feature. |
| Agent computer-use semantics | Luda/LCU integration and guest tooling | Retained LCU plus E2B execution transport | No established agent task-success gain from changing runtime. |
| Commands, streams, PTYs, files | Runtime exec/SSH plus Silo wrappers and file views | Official command, PTY and filesystem SDK services; passing subsets | Real API consolidation opportunity; existing user capability, not wholly new functionality. |
| Native terminal/editor launch | Existing application discovery and SSH/exec handoff | Same host launchers; new E2B guest/access binding | Silo code remains; complete editor lifecycle still needs qualification. |
| Git and Git LFS | Guest tools, scoped grants, repositories and host publishing | Tools run in guest; SDK command/file transport available | GitHub authorization and host-push policy remain Silo's responsibility. |
| Secret isolation | Host store plus runtime placeholder substitution, selective TLS and live revocation | Required replacement broker not yet qualified | Current regression risk. E2B adoption does not remove this subsystem. |
| HTTP/HTTPS/WebSocket access | Local publication and remote tunnels | E2B HTTP routing and stream transport | Useful upstream transport; exposed endpoints and revocation remain product integration. |
| Generic TCP and OpenSSH | Patched runtime publisher and stdio SSH | PoC OpenSSH plus bridge; header-routed HTTP is not an OpenSSH endpoint | No complete drop-in parity demonstrated. |
| Stop/start with disk persistence | Existing lifecycle, files preserved, processes restart | Disk-only pause/reboot is documented; full pause also preserves RAM | E2B's memory option is an additional capability. |
| Memory checkpoint and fork | Pinned runtime snapshots are disk-only | Live process-memory capture, fork and revert subsets passed | Incremental over shipped Silo; MicroSandbox 0.7.2 offers an upstream alternative to qualify. E2B preservation failures remain unresolved. |
| Portable complete disk backup | Root, workspace and dependencies; restore without original cache passed | Selected plan substitutes project-file export; equivalent archive not qualified | A loss in the proposed product, not proof E2B can never export disk state. |
| Separate workspace disk | Managed root plus separate ext4 workspace capacity | Selected PoC uses one root; upstream volumes are a different beta facility | Simplification is a scope decision, not free feature parity. |
| CPU/RAM edits | Stop and save, apply next start | Restart-to-apply accepted; end-to-end resource change unproven | No new user benefit established. |
| Multiple computers | SSH owner/controller model with stable identities | Standard backend API can sit behind the owner transport | Useful seam; identity, authorization, tunneling and UI remain ours. |
| Headless execution service | Current remote owner requires Silo running | E2B services run independently of a GUI | Architectural benefit for a headless-owner product; Silo owner integration still required. |
| Logs, metrics and diagnostics | Existing Silo activity/logging/runtime metrics | Runtime telemetry and log services | Rich backend facilities, plus stores and service operations to maintain. |
| Image sharing | OCI image/cache pipeline already present | Shared templates, COW roots and lazy memory restore | Sharing is not unique; captured state and lazy RAM restore add capability. |
| Offline prepared workspace | Bundled CLI image and account provisioning live-tested offline | Self-contained after provisioning; fresh Embed setup downloads dependencies | Desktop-offline shipping still needs packaging work on both routes. |
| Install/update/Quit/recovery | Existing native packaging and journals | Linux host/control-plane packaging and update policy added | Material new integration obligation; not delegated to the Desktop SDK. |
| Product UI | Workspace, Files, GitHub, Network, settings and native launchers | Retained | No automatic UI improvement or deletion from E2B. |

Current evidence: [runtime/backup](../SiloUI-RUNTIME-BACKUP-FINDINGS.md),
[backup live verification](../SiloUI-DEPENDENCIES-BACKUP-TESTING.md),
[desktop](../SiloUI-DESKTOP.md), [secrets](../SiloUI-SECRETS.md),
[GitHub](../SiloUI-GITHUB-IMPLEMENTATION.md), [network](../SiloUI-NETWORK-PLAN.md),
[editor](../SiloUI-EDITOR-HANDOFF.md), [remote ownership](../SiloUI-CONNECTIONS.md).
E2B execution evidence: [current matrix](e2b-qualification-gates-2026-09-23.md),
[work log](e2b-qualification-worklog-2026-09-23.md),
[two-computer run](e2b-gate-h-two-computer-2026-09-24.md).

## Benefits that genuinely support E2B adoption

**Memory continuity and branching are a new product capability.** The pinned
MicroSandbox [snapshot contract](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/docs/sdk/typescript/snapshots.mdx)
explicitly does not implement resumable snapshots. E2B's
[snapshots](https://docs.e2b.dev/sandbox/snapshots) and
[persistence](https://docs.e2b.dev/sandbox/persistence) support preserving
processes and spawning branches. Our PoC verified process-memory and disk
oracles, so this benefit is more than a documentation claim. It also drops
active client connections at checkpoint time; terminals and viewers must reconnect.
The follow-up 0.7.2 research linked above establishes that these capabilities
are not exclusive to E2B compared with current upstream MicroSandbox.

**E2B provides a consistent service boundary.** Its command/file/PTY and
lifecycle services give a smaller upstream API to integrate than several
runtime-specific CLI/script paths. Its
[architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)
includes placement, template building, COW storage and lazy memory loading.
These mechanisms are valuable for checkpoint-oriented and server-operated
workloads. Silo's current identity, recovery and authorization rules still sit
above them. Both runtimes already provide SDKs; clean application boundaries
are not exclusive to E2B.

**A service deployment has strategic value for a headless or hosted product.**
E2B's [deployment offerings](https://e2b.dev/enterprise) provide routes beyond
one user's desktop. That is optional future product scope, not a benefit
already delivered to Silo's current user. No customer-demand evidence was
collected, and no managed-cloud terms or entitlement is assumed for local Embed.

## Drawbacks established by evidence

**Local packaging becomes a platform deployment.**
[Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md) explicitly
describes its single-machine shapes as evaluation packages. The Mac route adds
a shared Linux host, whereas current Silo runs its VM runtime directly. The
[Compose guide](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)
specifies Linux/KVM, newer ARM64 kernel support, a recommended 12 GiB host RAM
and 20 GiB free disk. Those are installation recommendations, not per-desktop
costs. The stock deployment also requires careful network exposure; its control
listeners are not all authenticated. Silo must own private installation and
recovery. This does not mean local E2B requires an E2B account or subscription.

The [service reference](https://github.com/e2b-dev/runtime/blob/main/embed/docs/REFERENCE.md)
includes databases, routing, logs and an orchestrator, not just a VM executable.
Our later scratch observation recorded approximately 1.31 GiB in Docker's
ClickHouse memory metric and 460 MiB for orchestrator, with other services
additional. This proves a nontrivial installed control-plane footprint. It does
not prove an unavoidable minimum or a memory ratio against MicroSandbox.

**The tested failure paths are unacceptable for user work.**
[#3658](https://github.com/e2b-dev/runtime/issues/3658) reproduces failed
pause/checkpoint leaving no SDK-restorable state;
[#3659](https://github.com/e2b-dev/runtime/issues/3659) records a successful
snapshot that repeatedly crashes on restore. Both were open when checked today.
The clean shutdown barrier now passes, but it does not repair those different
failures. No inference is made about failure rates in E2B Cloud or other releases.

**Storage/update ownership remains.** Our work log records API template deletion
leaving 44 GiB to reclaim manually after checking dependencies. A passing pause
also needed an explicit upload durability barrier before host stop. Runtime
updates still need compatibility and recovery qualification. Replacing Silo's
disk archive with project files loses installed packages and other root state;
that accepted simplification must remain visible in this comparison.

**Several advertised features do not close our integration gaps.** Current
[secret architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)
requires a backend and enterprise orchestrator resolution; our deployment has
not qualified that route. The current
[SDK network contract](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/sandboxApi.ts)
explicitly excludes the open-source runtime from its supplied BYOP feature.
The [broker comparison](e2b-credential-tools-2026-09-24.md) is therefore still
required. Separately, the SDK's
[Git wrapper](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/index.ts)
is deprecated in favor of running Git commands. It is not a replacement for
Silo's GitHub product integration.

**Release/source correspondence needs work.** The
[release procedure](https://github.com/e2b-dev/runtime/blob/main/docs/RELEASING.md)
describes a public mirror with releases produced internally. Our
[pinned-artifact audit](e2b-release-source-mapping-2026-09-23.md) could identify
the binaries but not their exact public source mapping. This is a concrete
debugging/rebuild limitation for our candidate, not a claim that E2B is closed
source. MicroSandbox's matching public source pin is established, although
Silo then adds its own patch and inherits that maintenance burden.

## Findings that prevent an unfair comparison

- **MicroSandbox is not maintenance-free or universally qualified.** Its
  [pinned README](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/README.md)
  identifies beta software. Silo's
  [patch](https://github.com/0xpolarzero/silo/blob/d3481b294342784bbf1047e6d94587381eee2479/app/SiloUI/patches/microsandbox-create-stopped-0.6.17.patch)
  spans creation, image integrity, secret/network policy, SSH, publication and
  logs. That is a reason to reduce patches and upstream fixes, not to call the
  incumbent finished.
- **Current desktop acceptance has holes.** The known Kasm clipboard mechanism
  has an implemented setting fix and source-level regression. Full packaged
  input acceptance, delayed typing/Enter attribution, Linux viewer coverage and
  all editor workflows are not proven. Existing remote-management tests also
  do not establish the complete real two-computer workflow.
- **E2B already has meaningful passes.** Memory forks, clean durable host
  restart, automatic suite cleanup, Tauri modifier delivery/IPC denial and
  basic native-Linux remote lifecycle are evidence. Do not erase those passes
  because other gates failed.
- **No comparative performance winner exists.** The older E2B installation
  measured 28.33 GiB allocated host storage with three desktops and retained
  experiments. Current Silo's 85.8 MB ARM64 archive is a compressed CLI base
  without its desktop. Comparing those numbers would be invalid. There is no
  matched input-latency, frame-rate, startup, host-memory or storage test.
- **Disk recovery is not categorically absent in E2B.** Current docs describe
  [filesystem-only pause](https://docs.e2b.dev/sandbox/filesystem-only-snapshots)
  and [reboot on resume](https://docs.e2b.dev/sandbox/resume-without-memory).
  The latter skips saved RAM and has crash-recovery disk semantics; unflushed
  writes are lost. Older control planes can ignore the option. These are
  upstream paths to qualify, not a proven repair of our snapshots or portable
  backup parity. CPU/RAM reconfiguration is not proven merely by a reboot API.
- **E2B volumes exist, but are not our ext4 workspace replacement by default.**
  The [overview](https://docs.e2b.dev/volumes) calls them private beta. Their
  [limitations](https://docs.e2b.dev/faq/volumes-beta-limitations) include locking,
  permission and small-file behavior; upstream recommends keeping builds, Git
  and package installation on local disk. Do not invent a missing feature, or
  claim equivalent semantics from the word “volume.”

## The narrower alternative

Retain the VM engine, host credential store, provider permissions, network
publication, editor/terminal integration, remote ownership and backup contracts.
Refactor these only at the seams required by the desktop change.

Use the existing guest-image publication pipeline to ship the desktop and its
tools ready to start. Keep session ownership and readiness explicit. Evaluate
upstream noVNC with an established VNC server in the existing private native
viewer. The prior [independent selection](../SiloUI-DESKTOP-SELECTION.md) puts
TurboVNC first and TigerVNC as an alternative; the
[TurboVNC manual](https://raw.githubusercontent.com/TurboVNC/turbovnc/3.3.1/doc/index.html)
documents noVNC integration, and
[noVNC's API](https://novnc.com/noVNC/docs/API.html) supplies embedding controls.
Use those components rather than writing another display or input protocol.
This is a candidate to qualify, not an already measured improvement over KasmVNC.

The smallest discriminating experiment uses the same VM, guest applications,
resolution and Tauri surface with the current viewer as control. Check native
typing/Enter, shortcuts, clipboard, drag/focus, reconnect, local/remote access,
saved bytes and resource/latency measurements. That isolates the desktop/viewer
benefit; the E2B PoC changed the VM engine, distribution and display stack at once.
Its success cannot attribute a viewer improvement specifically to Firecracker.

Prepared images, always-present desktops, a cleaner Files implementation,
one workspace filesystem and simpler UI are independent design choices.
Credit them to the refactor that implements them, not automatically to E2B.
The E2B replacement plan currently combines several of those choices with the
runtime migration; splitting their benefits is essential to this decision.

## Decision and reversal conditions

| Option | Decision for the stated objective |
| --- | --- |
| Keep everything unchanged | Reject. The desktop integration and patch ownership need focused improvement. |
| Keep MicroSandbox; refactor desktop packaging/viewing and reduce runtime patches | Recommend. Directly addresses the requested packaged desktop experience while preserving established product behavior. |
| Replace the backend with E2B Embed now | Reject. New memory semantics are valuable, but the desktop objective does not justify the operational additions, integration regressions and unresolved preservation failures. |
| Adopt E2B for a checkpoint/fork-first or hosted/headless product | Reassess against that explicit objective after qualifying the required deployment. Do not implement memory snapshots ourselves to avoid a vendor. |

I would reverse the recommendation if memory-preserving branches become a core
workflow requirement that the existing runtime cannot supply, and an E2B
candidate proves failure preservation, bounded storage, supported updates and
the remaining Silo access/security contracts. A promised fix, recognizable
vendor, SDK feature list or fast happy-path demo does not satisfy those tests.

**Updated next action: qualify the upstream MicroSandbox checkpoint/fork path
using the same preservation oracles as the E2B trial.** Then qualify the prepared
desktop and upstream viewer as a separate comparison. Keep the E2B PoC and its
evidence as an alternative if that runtime qualification fails. No runtime
replacement, product cut or UI change is authorized by this research document.
