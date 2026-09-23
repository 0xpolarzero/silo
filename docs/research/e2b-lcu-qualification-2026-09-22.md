# E2B + LCU qualification, 2026-09-22

**2026-09-23 correction:** this is a historical observation report, not proof of
three independently reproduced upstream bugs. The
[investigation and completion handoff](../SiloUI-E2B-QUALIFICATION-HANDOFF.md)
supersedes its investigation sequence. The Compose commit inspected below does
not establish the exact source of its selected API/orchestrator binaries; the
durability JSON was manually assembled, feature passes span resumed runs, and
cache cleanup/shutdown interventions remain possible contributors. Computer use
is now under rewrite and is outside the critical investigation path.

**Decision: continue the PoC; do not cut Silo over yet.** LCU, SSH and synthetic
credential brokering worked in real ARM64 microVMs. During checkpoint and pause
failures, source runtimes became unavailable; the cause and recoverability of
their latest state were not established. An earlier named checkpoint
recovered after a host reboot; the latest pause did not. Passing feature tests
are not a rollback guarantee.

This extends the [initial desktop experiment](e2b-local-poc-2026-09-22.md) and
updates the [replacement plan](../SiloUI-E2B-REPLACEMENT-PLAN.md). No production
Silo UI or backend changed. Proposed UI changes still need user approval.

## The execution model

```text
Mac Silo / another controller
  → Silo owner and credential authority
    → private Linux execution host
      ├─ E2B API, scheduler, storage, guest ingress
      ├─ credential broker and current authorization, outside snapshots
      ├─ workspace A: Firecracker → Xfce/X11/D-Bus + LCU + OpenSSH
      └─ workspace B: Firecracker → Xfce/X11/D-Bus + LCU + OpenSSH

Shared template: install Xfce + LCU + SSH once during image construction.
Each created microVM: its own kernel, filesystem state, desktop and LCU process.
Human viewer: noVNC → authenticated E2B route → that microVM's desktop.
Agent: existing LCU MCP tools → that microVM's X11/D-Bus session.
```

LCU cannot run once on the outer host and automatically see isolated guest
accessibility trees. Its process belongs beside the guest desktop. The image
contains shared program bytes; that does not make the running desktop sessions
or writable state shared. E2B's computer-use library is not used.

A Silo workspace UUID is separate from an E2B sandbox ID. Revert replaces the
runtime binding after readiness, while retaining the workspace UUID. Fork creates
a new UUID. The PoC journals revert intent, discovers an accepted but unrecorded
candidate by owner/operation metadata, and retires the old runtime only after
committing the replacement. New guests get fresh SSH host keys, cleared login
keys and reset LCU sessions. Current credentials live outside these snapshots.

## Exact evaluated stack

- M4 Max with 64 GiB physical memory; private Lima 2.2.0 VZ VM, nested KVM.
- Ubuntu 26.04 ARM64 execution host, 8 CPUs, 16 GiB RAM. Its hugepage pool is
  4096 × 2 MiB, or 8 GiB. This pool is part of the host's 16 GiB allocation.
- Host disk grew from 64 to 80 GiB sparse capacity during qualification.
- E2B runtime inputs pinned to
  [`a065a4d`](https://github.com/e2b-dev/runtime/tree/a065a4ddb3f2c6a4149634d9acb14b62f65839ac),
  Python SDK 2.51.0, Firecracker `v1.14-0.2.0` in the observed deployment.
- Template `silo-arm-desktop-lcu`: Debian 13, Xfce/X11/Xvfb, Firefox ESR,
  Mousepad, Git/LFS, OpenSSH, Python 3.13 and LCU.
- [LCU v0.2.1 ARM64 release](https://github.com/0xpolarzero/lcu/releases/tag/v0.2.1),
  SHA-256 `fd619f2a23cfb937bf414c9d4c309a3a9520651915d468cd644c4d9053dcddd3`.
  Its [installation contract](https://github.com/0xpolarzero/lcu/blob/main/docs/INSTALLATION.md)
  requires a Linux graphical session and recent Python. The PoC installs the
  release in the template and uses `lcu-session --user user` to attach to X11
  and D-Bus. The upstream [verification procedure](https://github.com/0xpolarzero/lcu/blob/main/docs/VERIFICATION.md)
  informed the semantic desktop tests.

The physical resources measured here are not acceptable defaults for every M3
machine. M3 hardware, lower RAM profiles, Linux x86-64 and a second physical
computer have not been qualified by this run.

## Executed results

The automated runtime report contains six passing groups accumulated across
resumed runs. The credential report contains three passing groups. The manually
assembled durability report records three failed preservation/recovery
observations; it is not a runnable fault-test suite. All are retained; the
gateway reports the overall failure. These reports are not one fresh integrated
run against an immutable final deployment.

| Area | Executed evidence | Limit |
| --- | --- | --- |
| LCU semantic editing | AT-SPI discovery; exact `Café 日本語 🐧` text saved through a GTK UI and read independently from disk; another window untouched; second VM cannot see the window/file | This verifies a controlled GTK fixture, not every desktop application |
| LCU state | Persistent JavaScript variable survives pause/resume; reset clears it; restore reconnects to desktop and resets the tool session | Full host restart of the latest paused state failed later |
| Guest isolation/network | Kernel hostname mutation isolated; guest files/windows isolated; three private-address probes blocked; MMDS reports each actual runtime ID | Selected probes are not hostile-guest security certification |
| Browser/viewer | Firefox local page observed through LCU; JPEG screenshot; native WKWebView renders noVNC and saves a Mousepad file | Actual packaged Tauri app, physical keyboard layouts, clipboard/DPI/drag matrix remain unrun |
| Input ownership | Human ownership rejects agent requests with 409; return to agent disconnects the native interactive viewer; fresh observer cannot modify the saved file | Already-running guest processes continue; this is not process cancellation |
| SDK PTY | Resize 24×80 → 41×103, Unicode, Ctrl+C interrupts child, clean exit | Network interruption/backpressure stress remains |
| SSH/SFTP | 2,097,170 binary bytes round-trip exactly; uploaded/downloaded file hash matches; stdin EOF preserves final output; stderr and exit 17 survive; revocation closes active connections; per-VM host keys differ | Guest bridge currently targets only localhost:22; it is not a qualified general TCP publication feature |
| Native editor | VS Code 1.137.0 with Remote SSH 0.128.0 connected through the relay and started its ARM64 server | Native GUI edit/save not completed: automation selected another Code instance, which was left untouched |
| Checkpoint fork/revert | Same process-only nonce and saved file restored; source/fork writes independent; stable workspace UUID gets a new runtime ID; SSH host identity renewed; LCU reconnects | Does not establish safe checkpoint failure |
| Synthetic credentials | TLS Bearer and Git Basic placeholders replaced outside guests; independent upstream verifies credential digest; read A/write B/deny C; destination/identity/auth negatives; reflection blocked | Controlled origins and synthetic values only |
| Git/LFS | Actual Git smart-HTTP push and clone; upstream commit independently checked; read-only push denied; 64 KiB LFS upload/download SHA-256 matches | Real GitHub App grants, gh and GraphQL remain unqualified |
| Rotation/revocation | Next request sees rotated value; revoked grant denied; guest home scan contains neither real synthetic value; old checkpoint does not revive SSH reverse-tunnel authority | Scan covers `/home/user`, not every RAM page or log; no universal encoded-reflection guarantee |
| Owner tests | 17 passing unit tests cover ownership, input serialization, path boundaries, revert commit/failure/crash recovery, narrow retry and low-headroom refusal | Mocked tests do not override live durability failures |

Native WebKit saving used noVNC's on-screen Control button followed by `s`.
The automation's direct Control chord did not forward correctly. This is an
unresolved automation/keyboard-mapping observation, not proof that a human's
physical Control key fails.

VS Code initially failed before connection because the isolated profile's Unix
socket path exceeded macOS's 103-character limit. A short profile under
`/private/tmp` resolved startup. The test did not edit the user's normal editor
settings or SSH configuration. Its isolated process was stopped after testing.

## Credential mechanism and what remains

The pinned Embed implementation explicitly reports no BYOP support in its
[TCP firewall proxy](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/tcpfirewall/proxy.go).
An SDK option alone therefore does not supply Silo's credential enforcement.

The tracer uses one host listener and one host-established SSH reverse tunnel
per workspace. A guest sends `$SILO_GITHUB` through that tunnel. The host broker
terminates fixture TLS, checks destination/repository/operation against a current
host grant, and sends the credential to the controlled TLS upstream. Only the
public fixture CA certificate enters the guest. The private key and credential
stay outside. A guest header cannot select another workspace's grant.

This is approximately the required trust boundary, not the finished GitHub
policy engine. The implementation deliberately denies GraphQL and unsupported
request shapes. It handles bounded HTTP/1.1 bodies, not arbitrary streaming,
WebSockets or all HTTP semantics. Production work must qualify real GitHub
installation tokens, repository permissions, Git/LFS redirects, gh/GraphQL,
revocation races and hostile responses. Reuse Silo's existing policy where it is
still necessary; do not turn this fixture's path rules into a production API
allowlist by changing two hostnames.

## Blocking failures and operational costs

### 1. Source runtime unavailable after checkpoint failure

With several 2 GiB guests and an 8 GiB hugepage pool, a checkpoint request failed
during a reported fresh-resume allocation failure. The source runtime then
became unavailable. Recovery from a prior named checkpoint succeeded. This does
not establish that all latest-state artifacts were erased or unrecoverable.

The inspected source contains a plausible teardown path: the orchestrator's
[`checkpointResumeFresh`](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/server/sandboxes.go#L1280)
always stops the old sandbox after the attempt. The API's
[snapshot failure path](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/snapshot_template.go#L141)
removes the sandbox after an internal error. This source revision has not been
matched to the deployed binaries. The in-place path exists, but the
[relevant flags default to false](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/shared/pkg/featureflags/flags.go#L193).
Enabling a different path is not a fix until its failure behavior is tested.

The PoC now rejects checkpoints below 2560 MiB of unreserved hugepage headroom
for its fixed 2 GiB profile. A unit regression verifies refusal before the source
is touched. This check is not an atomic resource reservation, and does not cover
I/O errors. Revert retries only the explicit failed-placement response with a
bounded delay; it never retries an ambiguous accepted create blindly.

Required preservation result: failure leaves the source live, or leaves a complete,
discoverable, resumable paused artifact. Test allocation failure, disk failure,
client disconnect and process crash independently. A previous checkpoint being
available does not satisfy preservation of work done since that checkpoint.

### 2. Pause failed, then the latest paused state could not resume

During a session that also experienced outer-disk pressure, workspace B's pause
failed with the following recorded error. The specific cause of the I/O error
was not isolated; temporal association does not establish causation.

```text
synchronous rootfs export failed:
failed to sync file: ...rootfs.ext4...: input/output error
```

Its Firecracker process was gone and the API later reported the runtime missing.
The shutdown helper rejected the stop sequence. Workspace A was reported paused,
but its latest paused state failed to resume after the host reboot:

```text
Firecracker panicked at src/vmm/src/devices/mod.rs:34:9
The number of available virtio descriptors 41919 is greater than queue size: 256!
```

This restore had ample free hugepages. The exact cause of this latest snapshot's
invalid device state is not isolated. It followed disk pressure, custom cache
reclamation and host restart, and preceded a successful restore from an older
named checkpoint. Investigate our own interventions as well as upstream restore
behavior; do not describe this as a proven independent Firecracker bug or a
proven disk-corruption mechanism.

The earlier named checkpoint `f5qw3zn8ykwa7hf8ys7i:default` restored into a separate
VM after reboot. Its process nonce, checkpoint file and LCU desktop matched the
pre-reboot reference. The later pause/host-recovery test remains **failed**.
Neither original failed state nor unmatched snapshot output was deleted.

### 3. Capacity and health need product work

Repeated template builds filled the original 64 GiB Linux disk. The orchestrator
failed while its container still appeared healthy. An unbounded ClickHouse log
then consumed about 18 GiB. The repair retained diagnostics, reclaimed cache
bodies found byte-identical to storage bodies, grew the sparse disk to 80 GiB and applied Docker
log limits of 10 MiB × 3 per service.

A later offline reclamation removed 44 duplicate cache files occupying
7,975,485,440 bytes. Canonical templates/checkpoints and unmatched failed output
were preserved according to that script's classification. Its safety for the
complete snapshot dependency graph remains unqualified. This manual repair is
not a supported snapshot-retention design.
The owned VM's physical disk footprint exceeded 60 GiB during this work; retained
history and caches dominate, so this is not the incremental cost of one desktop.

Preflight must account for both the Linux filesystem and physical Mac free space.
A large sparse virtual disk does not reserve that space. Health must exercise
an actual runtime operation, not just a container or HTTP liveness check. Add
bounded logs, snapshot retention/reference accounting and safe cache reclamation
before proposing an installed footprint or a minimum machine specification.

## Reproduce and inspect

Use [the PoC README](../../experiments/e2b-local/README.md) for setup and commands.
`poc.py test` now runs the LCU/SSH/checkpoint suite and credential suite. The old
xdotool-based acceptance runner and its one-off handoff verifier were removed;
useful isolation, browser and metadata checks were ported to the current suite.
`poc.py collect` retrieves reports, never `state/sdk.env` or credential fixtures.

Evidence lives under ignored
`app/SiloUI/src-tauri/target/verification/e2b-local/`:

- `evidence/qualification.json`: six passing feature groups, with earlier failed
  attempts archived separately.
- `evidence/credentials.json`: three passing synthetic credential/Git/LFS groups.
- `evidence/durability.json`: manually assembled preservation/recovery incidents.
- `evidence/lcu-host-restart.json`: failed latest-state recovery.
- `evidence/named-checkpoint-recovery.json`: successful earlier-checkpoint recovery.
- `evidence/native-viewer.json` and `evidence/native-editor.json`: qualified scope
  and explicit gaps for each native surface.
- `lcu-host-stop.log`, `lcu-host-restart.log`, template build logs and retained
  private runtime diagnostics: exact observations for upstream reproduction.

The PoC control page is <http://127.0.0.1:13800>. It is loopback-only and trusts
local users; it is not a multi-user server. Guest-controlled assets on its API
origin require a separate trust-boundary test. The recovered named-checkpoint
desktop was available at the end of that run; inspect current state before
assuming any guest is still running. Other desktops were paused or missing
according to the failed run, rather than silently recreated.

## Next implementation sequence

1. Follow the [corrected handoff](../SiloUI-E2B-QUALIFICATION-HANDOFF.md): establish
   binary provenance, reproduce checkpoint/pause/restore outside our adapter,
   attribute each cause, then fix our implementation or report/fix upstream
   defects according to the evidence. Use disposable workspaces and bounded faults.
2. Finish production credential-policy qualification against disposable GitHub
   grants; finish native editor save/reconnect and viewer input/clipboard tests.
3. Verify snapshot retention, disk pressure, runtime upgrades, cold restart,
   remote-owner flows on two computers and feasible hardware/resource profiles.
4. Present concrete lifecycle/checkpoint/resource UI proposals for approval.
5. Move proven PoC modules into their single production homes and delete their
   replaced MicroSandbox implementations in the same cutover work.

The next action is evidence preservation and source-matched, SDK-only durability
reproduction. More Silo UI implementation would get ahead of the evidence.
