# Local E2B desktop proof of concept

One Linux host VM runs E2B Embed. Each desktop is a separate ARM64 Firecracker
microVM, with Debian 13, Xfce, LCU, OpenSSH, Firefox ESR, Mousepad and a noVNC viewer. The control
page exposes screenshot, mouse, keyboard, shell and file operations, human
takeover, memory-and-disk checkpoints, forks, pause, resume and reconnect.

This experiment is separate from the shipped Silo application. It exercises the
backend and interaction model before a Tauri backend migration.

Executed on an M4 Max: LCU accessibility/Unicode editing, kernel and file
isolation, Firefox, SDK PTY, SSH/SFTP, checkpoint fork/revert, synthetic TLS
credential substitution, Git/LFS, rotation/revocation and native WebKit viewing.
The historical run records 17 focused unit-test passes. **Cutover is blocked:**
source runtimes became unavailable after checkpoint/pause errors, and a latest
paused-state restore failed. Causes and recoverability remain unestablished.
The [fresh 2026-09-23 desktop run](../../docs/research/e2b-fresh-desktop-qualification-2026-09-23.md)
passed six workflow and three synthetic Git cases on one owned scratch
candidate. It does not repair those lifecycle failures or qualify native save,
real-provider grants, two computers or release packaging.
Read the [investigation and completion handoff](../../docs/SiloUI-E2B-QUALIFICATION-HANDOFF.md)
before running or changing this experiment. It supersedes causal claims and the
investigation sequence in the [historical qualification report](../../docs/research/e2b-lcu-qualification-2026-09-22.md).
The [initial baseline](../../docs/research/e2b-local-poc-2026-09-22.md) records the
older template's 14 checks and successful clean host restart separately.

## Run on Apple Silicon

Preserve the historical `incident` deployment. Mutating driver commands require
an explicit `SILO_E2B_DEPLOYMENT`; use a new scratch name and its own host port.
Qualification reports have per-run IDs and cleanup checks run tags. Historical
report passes are not a fresh final run.

Requires M3 or newer, macOS 15+, Python 3.11+, and sufficient free resources for
an 8-CPU, 16 GiB Linux VM with an 80 GiB sparse disk. Check both Mac and guest free space before builds
or live tests; a large sparse capacity does not reserve physical Mac space.
This experiment exceeded 60 GiB of physical disk after repeated builds and
retained snapshots. It has no automatic snapshot retention policy. Run from the repository root with a separate scratch deployment:

```sh
export SILO_E2B_DEPLOYMENT=diagnostic-d1
export SILO_E2B_HOST_PORT=13801
python3 experiments/e2b-local/poc.py up
python3 experiments/e2b-local/poc.py deploy
python3 experiments/e2b-local/poc.py serve
python3 experiments/e2b-local/poc.py status
python3 experiments/e2b-local/poc.py collect
```

The separate viewer forward requires a Lima instance created from the updated
two-port config. Start with a new scratch deployment name; `up` refuses to
silently reuse an older instance without guest port 3801. It never rewrites the
historical or an existing scratch VM's network configuration.

`serve` opens the scratch gateway at the selected host port. `build` creates the
full desktop template. `test` creates two run-tagged desktops and a fresh report,
then runs the credential suite using the same run ID. These commands create real
resources and remain unqualified as a final integrated run. Do not run them
while using a PoC desktop interactively. Native viewer/editor checks are separate.

The private Lima installation and logs are under
`app/SiloUI/src-tauri/target/verification/e2b-local/deployments/<deployment>/`.
Scratch VM state is under `~/.silo-e2b-<deployment>/lima/`, with an ownership
marker. This persists across reboots
and keeps SSH socket paths short. Set `SILO_E2B_VM_HOME` to choose another short,
durable directory before the first run. The driver refuses to adopt another
experiment's directory. Its length check includes OpenSSH's temporary suffix.

### Canonical snapshot file readback

`verify-canonical-snapshot.py` inspects a build already present in the canonical
local storage tree. Run it where that tree is mounted, with the exact storage
root and build UUID:

```sh
python3 experiments/e2b-local/verify-canonical-snapshot.py \
  --storage-root /var/lib/e2b/storage \
  --build-id f5664a02-f7aa-4960-928f-3890ad4a3cb9
```

It reads `templates/<build-id>/` for the requested build and every build named
by either header's base ID, mapping, or V4/V5 build table. For each build it
requires `metadata.json`, `snapfile`, both headers, and the data bodies named
by those headers. Compressed V4/V5 bodies use `.zstd` or `.lz4` and require
their local `.uncompressed-size` sidecars; a V4/V5 zero-size diff has no body.
The sidecar may exceed the header's build size because it records the full
source file size while a sparse frame table can cover fewer bytes.
It accepts metadata version 2 and header versions V3/V4/V5, refuses headers
marked as pending upload, checks embedded build IDs, and reports the byte
count and SHA-256 of every required file. It streams bodies,
refuses symbolic links, checks file identity, size and timestamps around each
read, and stops after 1,024 builds or
16 TiB of data. The JSON report is printed only when the entire closure passes.

This is a point-in-time file inventory. The hashes have no independently
trusted expected values and do not prove that upload finished before a past
shutdown, that bytes match a prior state, that `snapfile` contains a valid
Firecracker device state, or that a restore will succeed. The command does not
connect to a VM or alter the restart probe's existing guard.

The control page forwards to `127.0.0.1:$SILO_E2B_HOST_PORT`; the viewer uses
the next host port. With the example above, control is `127.0.0.1:13801` and
the separate viewer origin is `127.0.0.1:13802`. Keep both loopback-only.
`poc.py` derives and validates the pair; do not expose either port on a LAN
interface.

```sh
# Inspect the selected scratch experiment and sync changed code.
python3 experiments/e2b-local/poc.py status
python3 experiments/e2b-local/poc.py sync
python3 experiments/e2b-local/poc.py serve
```

`stop` currently fails closed before pausing guests: the runtime returns from
pause before its asynchronous snapshot upload finishes, and this PoC has no
per-snapshot durability barrier. Do not bypass this guard with Lima or Docker
stop for state you need to preserve. `up` runs Compose reconciliation after boot.
Individual desktop deletion is explicit in the control page. Checkpoints remain
after deletion.

An SDK-only controlled host restart uses `stop-sdk <exact-run-id>`
after a separately prepared, read-back snapshot. Its guest-side guard checks
the one run-owned paused guest, upload marker, catalog build, pinned runtime and
canonical manifest again before stopping the owned scratch VM. The matching
`up-sdk <exact-run-id>` restarts that same VM with its existing Lima config;
it does not create a VM or add viewer forwarding. See the
[controlled restart evidence](../../docs/research/e2b-d3-controlled-restarts-2026-09-23.md).

## Control API

The control gateway runs inside the VM at `127.0.0.1:3800`. A second process on
`127.0.0.1:3801` serves only guest-proxied noVNC assets and its WebSocket; Lima
forwards them to separate Mac loopback ports. The control app has no guest asset
or viewer WebSocket route. This keeps guest-controlled noVNC JavaScript off the
control page's origin. The viewer process reloads the control-owned desktop
registry so mode and lifecycle epochs still invalidate old viewer sockets after
mode changes, pause/resume, and revert. The control page mints a ten-minute,
HMAC-signed viewer ticket scoped to one desktop ID and epoch. The ticket appears
in that viewer session's path, is renewed by reloading the iframe after eight
minutes, and cannot authorize another desktop. The 32-byte signing key is a
mode-0600 host-side file in the private experiment state directory, independent
of E2B credentials and registry owner IDs. The viewer service disables access
logs so ticket paths are not written to the journal.

The PoC stores E2B credentials inside the VM with mode 0600. Control mutations
require `X-Poc-Request: 1` and same-origin browser requests. That header is not
authentication; this gateway trusts local users, has no multi-user authentication,
and must stay bound to loopback rather than a LAN interface or public address.

```sh
curl -fsS http://127.0.0.1:13801/api/state
curl -fsS -H 'Content-Type: application/json' -H 'X-Poc-Request: 1' \
  -d '{"name":"My desktop"}' http://127.0.0.1:13801/api/desktops
```

| Route | Purpose |
| --- | --- |
| `POST /api/desktops` | Create from the desktop template or a recorded checkpoint |
| `POST /api/desktops/:id/agent/{lcu,shell,read,write,type,key,click}` | LCU MCP tools and SDK operations |
| `GET /api/desktops/:id/screenshot` | LCU JPEG screenshot |
| `POST /api/desktops/:id/mode` | `{"mode":"human"|"agent","viewer_instance":"<UUIDv4>"}`; human takeover records that viewer, release requires the same instance |
| `POST /api/desktops/:id/viewer-session` | Mint an observer or owner-specific control session for `{"viewer_instance":"<UUIDv4>"}` |
| `POST /api/desktops/:id/checkpoint` | Capture disk and process memory |
| `POST /api/desktops/:id/revert` | Replace runtime from `{"checkpoint":"…"}` while keeping logical ID |
| `POST /api/desktops/:id/recover-revert` | Reconcile an interrupted revert journal |
| `POST /api/desktops/:id/recover-create` | Explicitly reconcile an accepted create whose response was lost |
| `POST /api/desktops/:id/ssh-key` | Install one public key; empty revokes and closes active sessions |
| `WS /ssh/:id` | Binary SSH relay used by `ssh-proxy.py` |
| `POST /api/desktops/:id/lifecycle` | `pause`, `resume`, or `delete` |
| `GET /api/evidence?run_id=<id>` | Aggregate only matching fresh-run reports; without a run ID, incomplete |
| `GET /api/resources` | Linux host memory and allocated disk |

The viewer origin serves `GET /session/:ticket/viewer/:id/:asset` and `WS
/session/:ticket/viewer/:id/websockify`. Both require the same current
workspace-and-epoch ticket; missing, expired, cross-workspace and stale-epoch
tickets are denied. It exposes no control API. Viewer routes return 404 on the
control origin.

Input handoff is serialized with agent operations. In agent mode the gateway
routes to a separate `x11vnc -viewonly` server; it does not rely on a browser
checkbox for enforcement. Changing modes invalidates existing WebSockets.
In human mode all agent routes return HTTP 409; the screenshot endpoint remains available. Shell commands can launch
background processes; takeover does not cancel autonomous work already started
inside the guest. This is an input handoff, not a process scheduler.

Guest file paths refer to the sandbox, never the Mac. The convenience file API
accepts paths under `/home/user`; shell access intentionally allows broader
guest operations. The path check is not a guest security boundary against
symlinks or an agent with shell access.

## Reproducibility and source decisions

- Lima 2.2.0 and the Ubuntu 26.04 ARM64 host image are checksum pinned in
  `poc.py` and `lima.yaml`.
- [E2B runtime](https://github.com/e2b-dev/runtime/tree/a065a4ddb3f2c6a4149634d9acb14b62f65839ac)
  Compose files are pinned to this commit; their `.env` pins component releases.
- Python direct dependencies are version pinned in `requirements.txt`.
- LCU v0.2.1 ARM64 is checksum pinned in `template.py`, installed once into the
  shared template, and runs separately inside each guest's X11/D-Bus session.
  `lcu-bridge.py` transports its existing MCP tools; it does not reimplement LCU.
- `tcp-bridge.py` exposes only the guest's loopback OpenSSH port through E2B's
  authenticated ingress. Editors never receive the E2B team credential.
- The credential broker is a controlled-origin tracer using synthetic values.
  It is not a production GitHub, GraphQL or general outbound proxy implementation.
- The desktop uses the native ARM64 Debian package repositories. It does not
  import the AMD64-only Chrome/VS Code repository settings in the
  [upstream desktop recipe](https://github.com/e2b-dev/desktop/blob/17ddc44f31080af9f2d0fa0fa767525fefd9882c/template/template.py).
- Debian's image tag and apt packages currently follow their maintenance
  channels. Builds are reproducible operationally, not byte for byte. Save the
  build log/package versions with each evaluated template.
- E2B's template start command launches the desktop before the template is
  snapshotted. Restoring a checkpoint uses the ordinary Sandbox API so it does
  not attempt to start a second X server over a restored desktop.
- Embed seeds a 512 MiB build working-space quota. `fix-build-quota.sql` raises
  that dedicated tier to 4096 MiB. `Template.build(min_free_disk_mb=4096)` alone
  does not fix this: that parameter applies after package installation. See
  [the API's separate build-space and free-space inputs](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/handlers/template_start_build_v2.go).

## Tests and limits of the evidence

```sh
python3 -m venv /tmp/silo-e2b-tests
/tmp/silo-e2b-tests/bin/pip install -r experiments/e2b-local/requirements.txt
/tmp/silo-e2b-tests/bin/python -m unittest discover -s experiments/e2b-local -p 'test_*.py' -v
```

`qualification.py` verifies kernel/guest isolation, selected blocked private
network destinations, per-guest metadata, LCU semantic Unicode editing,
screenshots, Firefox, takeover gating, persistent LCU state, SDK PTY resizing and
signals, SSH/SFTP binary integrity, EOF/exit status/revocation, and checkpoint
fork/revert memory and disk semantics. `credential-qualification.py` exercises
real guest curl/Git/LFS through a host TLS broker to a controlled upstream. Its
old-checkpoint replay check accepts transport failure as denial, so it does
not establish usable current authority after restore. The local
`test_credential_receipts.py` adds fsynced, digest-only upstream receipts for
synthetic Bearer and Git Basic controls plus a denied request.
A passing historical report does not override a later durability failure.

Do not resume an old report by combining its passes with a later run. Start a
new run ID for each full qualification. The host-restart probe is suspended
until the per-snapshot upload completion and storage dependency barrier is
verified. A pause response and zero Firecracker processes do not satisfy that
barrier. `host-restart-probe.py` still requires an exact run ID when this gate is
eventually reopened; it does not simulate power loss.

`sdk-transport-repro.py` is a separate one-command, non-desktop live fixture
for the owned scratch host. Run it there with
`sudo /opt/silo-e2b-poc/.venv/bin/python /opt/silo-e2b-poc/sdk-transport-repro.py`.
It records the run ID, SDK/host/script identity and assertions under
`evidence/sdk-transport/`. It deletes only its own guest after a complete pass;
on failure it keeps the guest ID in the report for inspection. A streamed
upload interrupted after 65,536 bytes returned an error while leaving those
bytes in the remote file. Callers must handle that partial result.

For the native viewer test, compile `viewer-harness.swift` into a disposable
AppKit/WKWebView app and open the workspace noVNC URL on the separate viewer
origin using a fresh session URL minted by the control page. Its absolute
WebSocket path includes the `/session/<ticket>/viewer/<logical-id>/websockify`
prefix. The historical harness saved an independently
verified file through noVNC's on-screen Control key. Direct automated Control
chords remain unqualified. This harness has no Silo IPC capability.

Reports are collected under
`app/SiloUI/src-tauri/target/verification/e2b-local/evidence/`. Repeated tests retain
snapshots and grow disk use. `reclaim-cache.py` is an offline repair helper, not
snapshot retention: with Firecracker and orchestrator stopped, it deletes only
cache files that byte-match canonical retained artifacts. It preserves all
canonical artifacts and unmatched failed snapshot output. Normal use should not
need this repair; automatic capacity management remains an adoption gate.

E2B Embed is an evaluation deployment. The outer VM and E2B control plane are
shared trust and failure boundaries. Its own control ports stay inside the VM;
the VM has no shared Mac folders, SSH keys or forwarded SSH agent. Guest egress
denies common private IPv4 ranges, and guest ingress requires an E2B
traffic token. Public internet egress remains available.

Firecracker's local MMDS service at `169.254.169.254:80` intentionally remains
available inside each microVM. It is served by that VM, independently of host
egress rules. The live suite verifies that it returns the correct sandbox ID
for each guest; its presence is not evidence of access to host cloud metadata.

Snapshots restore local memory and files. They do not reverse external requests,
protect against host disk failure, provide database transaction consistency, or
constitute exported backups. WebSocket connections reconnect after snapshots.
The live tests retain state for inspection; none of these results establishes
production readiness or support for M1/M2 Macs.
