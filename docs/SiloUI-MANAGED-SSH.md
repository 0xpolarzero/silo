# Managed SSH access

Sandbox rows keep Terminal, Editor, Start/Stop, “SSH ▾”, and a more-actions menu
visible. Restart, Edit, Duplicate, and confirmed Delete are in the menu.

The sandbox Overview lists local and remotely managed VM sandboxes with expandable SSH
controls. Independent Local SSH and Network SSH badges remain beside the VM
badge when collapsed; each has a small address-copy button. Enabling network
access keeps the local address available, and expanded controls show both.
Network is reserved for service port forwarding. Controls and
connection commands name the computer that owns the sandbox. A connected Silo
controller can change access on that computer; the owning Silo app runs the
listeners and stores the configuration.

## Using access

1. Expand a sandbox and enable **Allow SSH from COMPUTER**. Silo generates a separate
   Ed25519 connection key automatically. No key setup is required.
2. The initial port is 2222, or the next available port. Edit the connection
   line using **Edit port** or **Edit address and port** in its menu to choose another port.
3. The **Copy terminal command** action in each address’s menu prepares a private key file on the computer running the
   UI and copies a ready-to-run `ssh -i KEY_PATH -p PORT root@ADDRESS` command.
   The **Save key file** action in that menu opens a save dialog for clients that take a key file. Exported
   keys have mode 0600. The copied command's path belongs to this computer;
   download the key when setting up a client on another computer.
4. Enable **Allow SSH from other computers** for LAN/VPN access. A single available interface
   is selected automatically; choose one when the host has several. The address
   can be copied separately for clients such as ZCode.
5. The connection address tooltip includes the host-key fingerprint when available.

Network access requires an authorized key and a route to the selected address.
Silo does not configure internet routing or open a firewall. IPv6 and wildcard
listeners are not supported. Ordinary service port forwarding remains loopback
only. If the selected interface disappears, SSH closes and reports an error;
choose the new interface address to restore access.

Enabled does not mean listening. A stopped sandbox waits for its next start;
connections never start it. Missing keys, occupied ports, missing interfaces, and
unverifiable VM identity produce errors. Closing the window does not Quit Silo.
Disabling access, changing keys, changing the port or network address, stopping
the VM, and quitting Silo on the owning computer disconnect existing managed SSH sessions. Changes restart the
whole sandbox endpoint, including sessions authenticated with other client keys.
Silo preserves previously authorized client keys; its generated connection key is always included when access is enabled.

## Managing a sandbox on another computer

For example, a laptop can manage a sandbox running on an office computer. Connect
the office computer using Silo's existing remote management setup, then expand
its sandbox in Overview. The controls display the office computer's name,
available interface addresses and connection controls.
Updates run in the office computer's Silo app.

The displayed `127.0.0.1` address belongs to the office computer. To connect from
the laptop, enable access on a reachable LAN or VPN address of the office
computer and copy that network address or command. Managing access remotely
does not create a tunnel or make the office computer's loopback address local
to the laptop.

Disconnecting the laptop, removing its saved remote connection, or quitting its
Silo app leaves the office computer's enabled endpoint running. Its lifetime
depends on the sandbox and Silo app on the office computer. Remote management
must be available to read or change settings from the laptop; losing that
connection does not revoke the independently configured SSH access. An
unreachable or incompatible owner reports an error instead of presenting stale
settings as current. Update Silo on both computers if the owner does not support
SSH access management.

## Ownership and persistence

`src-tauri/src/ssh_access.rs` stores configuration atomically as `ssh-access.json`
next to `machines.json`, with mode 0600. Records include the immutable machine ID,
workspace name, enabled flag, port, bind address and public keys. Reconciliation
checks both saved metadata and the runtime's `silo.machine-id` ownership label;
reusing a sandbox name does not inherit another sandbox's access. The child
verifies the expected machine ID again on its captured runtime handle before
connecting, closing the name-replacement race between parent inspection and
child startup.

Generated private connection keys live in `MSB_HOME/ssh/managed-clients/MACHINE_ID`,
separately from the internal editor key. They remain stable across toggles and
port changes. Export requires enabled access and a current sandbox identity.

External authorized keys live in `MSB_HOME/ssh/managed-access/MACHINE_ID.authorized_keys`.
Neither `MSB_HOME/ssh/authorized_keys` nor Silo's internal client private key is
read or modified by this feature. Keys are structurally validated as Ed25519
OpenSSH public keys; duplicate identities with different comments are rejected.
The existing sandbox `ssh/host_ed25519` host key is reused, with shared editor
helpers for private files and OpenSSH fingerprint generation.

Each endpoint owns a `Child` running:

```text
msb ssh serve NAME --no-start --no-inactivity-timeout \
  --exit-on-stdin-close --authorized-keys ISOLATED_STORE \
  --expected-machine-id MACHINE_ID --host EXACT_IPV4 --port PORT
```

The parent retains the child's stdin writer. EOF ends the child even when Silo
crashes and cannot run Rust `Drop`. Normal teardown kills and waits for each
owned child. No PID file, guessed PID cleanup, or surviving detached listener is
used. A network-enabled sandbox owns two children: loopback and the selected
interface, on the same port. Both must bind successfully; partial startup is
rolled back. `SILO_SSH_READY` is flushed only after authorization preparation and
successful bind, so an unrelated process on that port cannot be mistaken for
Silo's listener.

The bundled MicroSandbox patch exposes the existing authorized-key-path option
on the CLI, ties TCP serving to owner-pipe EOF, and observes the original guest
agent transport's closure. Losing that transport ends the listener and active
sessions without reconnecting to a replacement VM. `--no-start` refuses a stopped
VM, and `--no-inactivity-timeout` disables the existing SSH inactivity timer.

## Reconciliation

Silo reconciles after normal starts, restarts, temporary `exec` starts/stops,
start-at-launch, deletes, and each restart in backup's separate stop/restart path. Stop/restart/
remove close managed SSH first. Quit closes listeners under the runtime mutation
lock before stopping local VMs; the shutdown admission flag prevents reopening.
Final app Exit also closes listeners.

A background monitor reconciles every two seconds when it can obtain the runtime
mutation lock. This covers app startup with already-running VMs, external stops,
process failures, interface loss, and recovery from occupied ports. The child
itself observes VM transport closure, independently of that polling interval.
Corrupt or unreadable saved state closes all managed SSH listeners. Configuration
commands share the runtime mutation lock with lifecycle changes.

`src-tauri/src/remote_ssh_access.rs` carries `ssh.access.state` and
`ssh.access.save` requests through the existing remote management bridge.
Requests pin the immutable owning-host ID and sandbox ID. The owner resolves the
sandbox ID and reads or changes SSH settings under its runtime mutation lock,
using the same persistence, validation, and reconciliation as local controls.
Ordinary state and save responses contain public keys only. An explicit
`ssh.access.connection` request transfers the isolated private connection key
through the authenticated management bridge to the controlling Silo app. The
private key never enters frontend state. The controller writes a mode-0600 key
under `MSB_HOME/ssh/connections/` and returns a command, or exports it using a
native save dialog. Remote management must be enabled and both immutable IDs
must match. The controller creates no SSH listener process.

## Verification

Ordinary Rust tests use a disposable TCP echo runtime, not a VM. They check
actual socket/session teardown, owner-pipe EOF, readiness under port collision,
key-change restart, reuse of unchanged listeners, rejection of stopped/disabled/
unverified/keyless configurations, interface validation, private settings,
symlink rejection, duplicate keys, and preservation of internal authorization.
Frontend fixtures cover collapsed badges, the named host, both connection
commands, switches, port and interface validation, key paste/import/removal,
errors, and stale status. Existing lifecycle, backup and shutdown tests remain
part of the ordinary suite. Remote regression coverage should verify host and
sandbox identity rejection, owner-name/address preservation, remote save routing,
errors from unavailable or older owners, and independence from controller
disconnect. These deterministic checks do not establish reachability between
two physical computers.

Run from the repository root, using the native test configuration described in
[Silo releases](SiloUI-RELEASES.md#local-setup):

```sh
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml ssh_access::tests
npm --prefix app/SiloUI test -- src/features/application/pages/ssh-access-panel.test.tsx
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
```

For opt-in live verification, `scripts/test-managed-ssh-live.py` creates a
disposable VM in its own temporary `MSB_HOME`, using the bundled guest image.
It does not use the installed application's VM state. Supply a patched runtime
that can run VMs on the host (signed with the required entitlement on macOS):

```sh
SILO_RUN_MANAGED_SSH_LIVE=1 python3 app/SiloUI/scripts/test-managed-ssh-live.py \
  --msb /absolute/path/to/msb --library /absolute/path/to/libkrunfw \
  --guest-image /absolute/path/to/guest-image \
  --output app/SiloUI/src-tauri/target/verification/managed-ssh-live
```

Add `--network-address HOST_IPV4` to verify simultaneous loopback and selected
interface listeners. The test checks authorized and rejected keys, host-key
pinning, 65 seconds of idleness with keepalives disabled, ownership-pipe EOF,
key replacement, the stopped-VM guard, identity pinning, and VM-stop cleanup.
This exercises the runtime on one host; it does not prove firewall reachability
from a second physical computer.

Loopback tests require permission to bind local TCP sockets. Runtime CLI and
agent transport tests are also included in the maintained MicroSandbox patch.
A fixture test or successful build does not prove a live VM, a second physical
computer, or an installed application's behavior.

## Primary implementation sources

The maintained patch applies to MicroSandbox commit
`5eca4de8bf233e57f114140f8c076ea8c96f21ab`. Relevant upstream source:

- [SSH CLI](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/crates/cli/lib/commands/ssh.rs): TCP/stdio serving and inactivity flags.
- [SSH SDK](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/sandbox/ssh.rs): isolated authorized-key store and persistent sandbox host key.

Repository patterns reused: `src-tauri/src/editor.rs`, `network.rs`,
`remote_network.rs`, and `runtime/shutdown.rs`. The runtime preparation script
verifies the additional CLI capabilities before accepting a bundled runtime.

### Verified on 2026-09-15

The results below describe the initial local-owner implementation. They do not
establish live remote-controller behavior; record remote verification separately.

The full frontend and ordinary Rust suites passed. Final focused checks passed
11 SSH UI tests and 9 managed-SSH Rust tests. Typecheck, lint, 31 release-tooling
tests, 12 runtime-preparation tests, the packaged patch hash check, and patched
runtime tests (7 SSH CLI, 7 SSH SDK, 9 agent-client) also passed.

The opt-in live test passed against a freshly compiled, ad-hoc hypervisor-signed
runtime at `app/SiloUI/src-tauri/target/verification/managed-ssh-runtime/msb`.
It used a disposable VM and verified all cases above, including simultaneous
loopback and the host's selected LAN address. Evidence is in
`app/SiloUI/src-tauri/target/verification/managed-ssh-runtime/live-final/live.log`.
The test VM was stopped and its isolated home removed. The UI was visually
checked with deterministic fixtures. No installed Silo bundle was rebuilt or
inspected, and no second physical computer was used.

### Remote-control verification

After adding remote management, the ordinary Rust suite passed 371 tests with
10 opt-in tests ignored. Focused native tests exercise the same owner-side
settings handler with a disposable TCP runtime: remote enable persists without
starting a stopped VM, the owner restores access after start, returning the
controller reply leaves its listener alive, identical settings preserve active
sessions, and remote disable closes listener and session. Replaced identities,
malformed settings, wildcard binding, private-key input, disabled management,
wrong host identity, and incompatible protocol versions are rejected.

The full frontend suite passed 785 tests across 86 files, and typecheck and lint
passed. Frontend regressions cover immutable host/VM routing, aggregation across owners,
healthy-host isolation from offline hosts, stale-key response suppression,
unsupported owner versions, disabled stale controls, main-window permissions,
and owner-specific address labels. These are deterministic controller/owner
fixtures, not a live test between two physical computers. The remote-control
extension does not change the previously live-tested MicroSandbox runtime.

### Compact controls verification

The compact layout passed typecheck, lint, and 19 focused SSH/copy-button tests.
The macOS debug bundle was rebuilt, its signature verified, and the exact app at
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app` reopened. Native UI
inspection confirmed the disabled sandbox's expanded row shows only its named
SSH toggle and collapsed Keys/Advanced sections. No access settings were changed.
The local sandbox was stopped before restart; the remote Linux sandbox remained
running. Linux's updated frontend also built, but its final native build still
requires authorization to transfer the private GitHub build configuration.
