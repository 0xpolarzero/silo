# Remote hosts: UX proposal

Status: superseded implementation details. The user subsequently selected app-lifetime management with Quit stopping local VMs. See [Remote computers](SiloUI-REMOTE-COMPUTERS.md) for the implemented behavior and verification. This document retains the design discussion and original plan.

## Current evidence

- `app/SiloUI/src/features/sandboxes/components/machine-list.tsx` presents VM and SSH configurations as sibling machines. SSH fields are name, host, user, and port.
- `app/SiloUI/src-tauri/src/runtime.rs`, `application_source_with`, constructs SSH rows with `Stopped` and `Remote status is not connected.` No remote inspection establishes that state.
- The same runtime rejects VM lifecycle operations on SSH configurations.

## Recommended model

A host is a computer running the Silo runtime service. A VM belongs to one host. The desktop app manages its local host and connected remote hosts. SSH transports authenticated management requests and VM terminal/editor connections; it does not define the resource type.

Expose `Allow remote management` on the computer providing compute, rather than an exclusive client/server app mode. Keep local management available. A controlling computer should not need a local virtualization runtime if it only manages remote hosts.

Both UIs use the owning host's authoritative service. Do not synchronize independent writable VM inventories. Serialize conflicting lifecycle operations, reject stale edits, and refetch after reconnect. Cache observations for display only. Identify VMs by stable host ID plus VM ID. Connecting a second controller does not copy VM disks or files.

## Proposed interaction

1. Compute computer: install Silo, enable remote management, complete SSH/runtime readiness checks, and copy a connection address. Show service status and how to revoke access. Explain whether the service survives app exit, logout, and restart; implement the stated behavior.
2. Controller: choose `Connect host…`, paste a hostname, IP, SSH alias, or user@host, and reuse SSH configuration where available. Keep username, port, and key overrides in advanced options. Verify host identity and authenticate when necessary.
3. Probe Silo service availability, protocol compatibility, virtualization support, and resources. Distinguish unreachable computer, authentication failure, missing runtime, and unsupported virtualization. Offer explicit setup guidance for missing prerequisites.
4. Show discovered Silo-managed VMs and available capacity, then add the host. Do not claim arbitrary pre-existing VMs are supported or imported.
5. Group VMs by host. `Create VM…` includes `Run on`, defaulted from the selected host, with that host's resource limits. Start, stop, logs, terminal, and editor actions target the owning host. SSH reaches guests through the host so guests do not require public addresses.

On disconnect, show `Unavailable` and last-observed VM state with a timestamp. Disable mutations rather than silently queueing them. Removing a saved connection leaves remote VMs running; deleting a VM is a distinct host-qualified action. Preserve in-flight operations on the host across controller disconnects and reconcile their result on reconnect.

## Scope and validation

First slice: one user, two supported computers reachable over LAN or an existing private network, one remote host, full local and remote management of Silo VMs. Defer team roles, cross-host migration, offline edits, automatic internet traversal, and arbitrary SSH targets as managed VMs.

An IP alone does not establish reachability or grant access. Installation must check actual virtualization support; installing inside another VM does not guarantee nested virtualization.

Hypothesis: a user who already maintains a second development computer will replace repeated SSH plus Silo CLI operations with remote host management. Validate with that user's real create/start/open-editor/stop workflow and a controller disconnect. Proposed usability target: connect a prepared host and open a new remote VM within five minutes of user interaction, excluding downloads and provisioning. Technical precedent is not demand evidence.

## Primary-source precedent

- [libvirt remote support](https://www.libvirt.org/remote): an authenticated encrypted connection can manage a remote hypervisor through the same API shape as a local connection; SSH is a transport.
- [libvirt connection URIs](https://libvirt.org/uri.html): remote identity and transport are distinct from hypervisor resource type.
- [Incus remote servers](https://linuxcontainers.org/incus/docs/main/remotes/): clients register full remote servers as management destinations.

These establish prior art, not Silo compatibility. No remote Silo prototype, runtime test, or UI smoke test was performed for this proposal.

## Implementation plan, 2026-09-11

### Accepted product contract

Use `Connect computer…` and `Allow remote management` in the UI. Internally use host for the runtime owner. Both apps can create, inspect, start, stop, restart, and delete the same host-owned VMs. No exclusive app mode or independent inventory synchronization. Per-VM sharing remains separate future work.

### 1. Prove the service boundary

The current Tauri `runtime.rs` calls runtime operations through AppHandle-dependent commands and routes workspace actions by name. Its lifecycle/configuration/update recovery modules already persist recovery information. Preserve that behavior while extracting a core that can run without Tauri. Audit all mutation paths, including backup, restore, networking, GitHub, and updates, before changing ownership.

First disposable proof: a local background process owns runtime state; a fixed SSH bridge forwards framed requests to it; a second computer creates, starts, inspects, and stops a disposable VM. Kill the controller connection during an operation and recover its outcome without repeating it. Open a terminal into the guest through the host. Establish process ownership and compatibility with the bundled hypervisor before expanding the UI.

### 2. Introduce identity and a bounded protocol

Persist stable host identity, distinct from address, and address every VM by host ID plus VM ID. Support equal VM names on different hosts. Persist address/authentication references on the controller; retain VM configuration, disks, and operation history on the owner.

Define a versioned handshake, capabilities, structured errors, inventory snapshots, revision-aware commands, operation IDs, and bounded progress events. Use specific create/update/delete operations instead of allowing a stale client to replace the full inventory. Establish a single mutation owner and resource reservation for competing creates. Build local-socket and SSH transports against the same behavior tests; keep the abstraction limited to these two concrete adapters.

### 3. Package a supervised service

Implement platform service installation, startup, recovery, upgrades, and removal for the supported macOS/Linux runtime matrix. Local UI and remote requests must enter the same owner. Service operation must survive desktop app exit and SSH disconnect. Prove logout/reboot behavior separately; a login agent is not a boot daemon. Verify signing, virtualization entitlements, filesystem ownership, and credential-store access under the chosen service identity. Report sleep and pre-unlock availability honestly. Block release claims that have not been demonstrated on hardware.

### 4. Add SSH connection and authorization

Use system OpenSSH and existing user configuration. Parse addresses as data; invoke a fixed bridge command and send request data over stdin, not interpolated shell commands. Support aliases, hostname/IP, user, nondefault port, IPv6, and configured jump hosts. Implement first-use identity trust, changed-key failure, authentication prompts, timeouts, cancellation, and reconnect.

First release targets the user's own OS account and its Silo inventory. Make that authority explicit: existing general SSH login already grants account access. The remote-management toggle controls Silo's bridge, not the user's pre-existing shell access. Disabling it closes Silo management sessions, rejects new remote commands, preserves local management, and leaves VMs and accepted operations running. Do not forward agents or copy credentials by default. Do not advertise an unauthenticated public management listener.

### 5. Deliver the UI in parallel with the service proof

Build fixture-backed mock flows early: host-grouped VM list, connect dialog, remote-management settings, create-on-selected-computer, connection failures, and stale state. Fixtures are not proof of connectivity.

Connection flow: paste address, verify identity/authenticate, check service and runtime, preview discovered VMs, save connection. Controller-only onboarding skips local virtualization installation. The host settings show readiness, a copyable connection address, and access scope. Match existing styling and navigation rather than adding a separate dashboard. Scope tray actions, search, selection, notifications, dialogs, and resource displays to host identity.

### 6. Complete feature routing and recovery

Launch terminals/editors on the controlling computer while routing guest access through the owner; never return an owning computer's localhost address as a usable controller endpoint. Provide tunnel cleanup and per-host port conflict handling. Route guest files/logs to the host. Inventory every other surface: backup destinations and restore source, repositories, credentials, secrets, updates, and runtime repair need explicit ownership. Do not reuse local paths or local credentials for remote operations implicitly. Any deferred capability must have an accurate UI state, never a silently local action.

Use the host as the authority for concurrent actions and rejected stale edits. Persist accepted operation IDs/results so retry after a lost response cannot duplicate creation or deletion. Reconcile live runtime after service restart. Display last observed state with freshness and disable offline mutations. Forgetting a connection is distinct from deleting resources.

### 7. Migrate and verify

Back up saved metadata and migrate existing local VMs under the local host without recreation. Preserve existing SSH entries as legacy connection data; only convert one into a managed host after a successful Silo handshake. Never assume it represents a host rather than a guest. Test migration failure, rollback, duplicate connections, renamed hosts, and changed addresses.

Run meaningful Rust core/protocol/recovery tests, frontend behavior tests, typecheck/build, transport integration tests, and installed-app tests. Exercise supported macOS/Linux combinations with real VMs. Existing Swift UI smoke tests cover the Swift app only and are required if that app changes; they do not validate the Tauri feature.

Acceptance: connect a prepared computer, discover its VMs, create/start/open editor/stop/restart/delete a disposable VM remotely, observe local changes from the second app, and retain correct state after SSH loss, UI exit, and service restart. Verify duplicate-name targeting, simultaneous creates/deletes, rejected stale edits, full disk, authentication failures, version mismatch, and remote-access disablement. Publish exact commands and evidence with fixture coverage separated from hardware coverage.

### Sources and unresolved evidence

- [OpenSSH manual](https://man.openbsd.org/ssh): remote commands, SSH URI input, configuration resolution, jump hosts, and socket forwarding. Validate the installed OpenSSH versions rather than assuming all current manual options exist on every host.
- [Apple launchd guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html): separate login agents from system daemons when implementing availability promises.
- Linux service packaging must be checked against official systemd documentation and the actual supported distributions during the service proof; the documentation fetch in this planning session failed.

No service lifecycle, cross-computer runtime, authentication UX, or production feature parity was validated in this planning session. No application source was changed or tests run.
