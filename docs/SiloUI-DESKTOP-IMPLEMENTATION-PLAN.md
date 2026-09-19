# Optional Linux desktop implementation plan

Status: implemented and locally verified, 2026-09-18.
See [desktop behavior and verification](SiloUI-DESKTOP.md) for measured results
and remaining platform acceptance limits. The sequence below records the design
and acceptance targets, not a claim that every platform has passed.
This plan supersedes conflicting lifecycle and agent-integration suggestions
in [the research](SiloUI-LINUX-DESKTOP-RESEARCH.md).

## Product contract

Provide an optional ordinary Linux desktop in the same sandbox. Use Ubuntu
24.04, distribution Xfce on X11 and a pinned KasmVNC release. Support Silo-managed
VMs locally and on connected computers, on ARM64 and AMD64. Legacy arbitrary
SSH machines are not automatically supported installation targets.

Install at creation or later through one idempotent installation operation.
No removal workflow. No agent integration, MCP server, harness configuration,
takeover arbitration or agent pause/resume UI. Document standard Linux session
access for users' tools. A compatible third-party tool is useful acceptance
evidence, not part of the shipped runtime.

## Minimal interface

- Creation: one unchecked `Linux desktop` checkbox with short explanatory copy.
  The default installation policy starts the desktop with its VM. New VM
  creation preserves Silo's existing stopped-after-creation contract.
- Existing sandbox: `Add desktop` in sandbox configuration. No toggle that
  implies uninstall. Use the existing progress/activity presentation.
- Installed sandbox: one `Start desktop with sandbox` switch, default on.
  Helper: `When off, start the desktop from its viewer.`
- A sandbox-scoped `Open desktop` action opens a dedicated resizable Silo viewer
  window with the sandbox/computer identity. No new global dashboard or extra
  permanent controls on every sandbox row. Reuse an existing viewer window for
  the same VM. Prototype this interaction with fixtures before finalizing it.
- Stopped desktop: viewer contains one `Start desktop` action. Stopped VM:
  `Start sandbox` in automatic mode or `Start sandbox and desktop` in manual
  mode; opening a viewer alone does not silently boot a stopped VM.
- Running viewer: display gets the space, with a compact connection indicator,
  fullscreen control and an overflow menu for `Stop desktop` and recovery
  `Restart desktop`. No codec, protocol or frame-rate settings in ordinary UI.
- Closing the viewer only disconnects it. Explicit stopping warns that desktop
  applications will close. This is independent of terminal jobs.

## Lifecycle semantics

Automatic mode starts the desktop after every guest boot. Manual mode leaves it
stopped after boot until explicitly started. Both modes stop when the VM stops.
An explicit stop in automatic mode persists for that boot; the next VM boot
starts it again. Turning automatic startup off does not terminate a running
desktop. Turning it on starts the desktop if the VM is already running.
Installing onto a running VM starts the desktop with the default automatic mode.

Guest-side supervision must implement these semantics, including starts outside
the Silo window. Inspect the pinned guest init/agentd path first; do not assume
systemd, replace SSH entrypoints or introduce a host polling dependency. If a
guest startup hook is missing, make a small upstream-suitable runtime change
with a regression test. Bound crash restart attempts and expose a persistent
failure instead of restarting forever. Separate explicit stop from a crash.

## Implementation sequence

1. Disposable compatibility proof. Use the exact bundled engine and an existing
   prepared Ubuntu guest. Install the pinned packages; prove startup, shutdown,
   browser/file-manager operation, shared session access and reconnect. Check
   D-Bus, X authorization, fonts, Unicode, browser sandboxing and shared memory.
   Measure idle overhead with no apps/viewer, static viewer, and active apps.
   Exercise macOS's actual Tauri webview before committing to viewer embedding.
2. Guest package and provisioning. Maintain one versioned recipe, package
   inventory, hashes and license notices for both architectures. Reuse verified
   downloads and the existing provisioning/activity infrastructure. No runtime
   Docker requirement or root image replacement. Check OS/architecture, disk,
   package locks and conflicting packages. Journal progress and recover partial
   installs. An interrupted desktop install leaves the VM usable via terminal.
   Package-manager mutations are not assumed transactional; do not claim rollback
   of arbitrary apt operations. Use a normal desktop user with passwordless sudo;
   preserve identities, credentials and existing file ownership.
3. Domain and backend. Represent installation/version, startup preference,
   observed session health and current operation separately. Implement bounded,
   idempotent install/start/stop/status operations per stable VM identity. Serialize
   conflicting install, VM stop/delete and desktop operations using existing
   ownership/operation rules. Defaults migrate existing VMs to no desktop.
   Detect supported manually modified/broken installations rather than silently
   overwriting guest configuration. Keep logs bounded and use existing logs UI.
4. Transport and viewer. Reuse local loopback publishing and remote SSH tunnels
   through the owning computer. Use authenticated TCP/WebSocket delivery, scoped
   to the correct VM. Resolve certificate/authentication setup without requiring
   users to dismiss certificate errors or exposing tokens in URLs/logs. Load the
   desktop in a separate webview without privileged Tauri command access. Verify
   content policy and origin boundaries. Internal desktop connections should not
   require manual Network-page configuration or survive beyond their ownership.
5. UI integration. Extend contracts, creation/configuration forms, production
   sources, native actions and fixtures. Ship the minimal interaction above.
   Handle installation, connecting, reconnecting, stopped and failed states with
   one relevant primary action. Distinguish viewer disconnect from session failure.
   Verify keyboard focus, shortcuts, Unicode, scrolling, resizing, HiDPI and
   fullscreen. Keep a stable initial guest resolution and scale the viewer;
   user-directed resolution changes are explicit, not triggered by window resize.
6. Persistence and maintenance. Preserve desktop packages, preferences and user
   profiles in existing backup/restore paths; recreate transient display sockets,
   authentication and transport endpoints. Define explicit versioned update/repair
   behavior without reinstalling on every boot or changing running sessions
   unexpectedly. Remote operations execute on the owner and survive controller
   reconnect according to existing durable-operation rules.
7. Verification and delivery. Run focused behavior tests plus repository
   typecheck/lint, relevant frontend/native suites and release-tooling tests.
   Build and inspect the exact packaged application. Add a minor changeset,
   bundled help and measured verification notes. Do not publish a release or
   guest artifacts without the corresponding authorized release step.

## Acceptance gates

- Existing terminal-only creation/start/stop and SSH behavior remains unchanged.
- Creation opt-in and later installation converge to the same installed state.
- Automatic/manual startup, explicit stops, VM restart and controller reconnect
  follow the specified state table; desktop failure never reports the VM stopped.
- A desktop survives viewer close/reopen. Desktop stop does not stop independent
  terminal jobs; VM stop ends all guest desktop processes and owned connections.
- A user can interact with real Linux applications in the packaged viewer.
  A separately configured guest screenshot/input tool observes the same display.
- Interrupted downloads/installs, full disks, failed services, VM stop during
  installation and unavailable remote owners produce recoverable visible states.
- Supported architecture/host combinations receive actual live evidence. Fixture
  tests and cross-compilation do not substitute for Linux/KVM or remote-owner runs.
- Report measured guest memory and host footprint separately. The research's
  300–700 MiB idle estimate is not an acceptance result or guaranteed budget.

First deliverable: the disposable compatibility proof and a fixture-based viewer
interaction mock, followed by production implementation after those seams work.
