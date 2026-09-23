# E2B qualification work log

Date: 2026-09-23. Historical incident resources are preserved and read-only.
The orchestrator alone holds the separate diagnostic scratch VM's mutation
lease.

| Task | Owner / model | Status | Next experiment | Evidence |
| --- | --- | --- | --- | --- |
| P0 provenance and incident inventory | provenance / Luna medium | Source comparison and D1/D2 failure comparisons built; exact release match rejected | Resolve release source and incident-time mapping | `docs/research/e2b-provenance-audit-2026-09-23.md` |
| Credential contract | credentials / Luna high; orchestrator live run | Audit, receipt fixture and fresh synthetic two-workspace Git/LFS suite passed | Rebind current grants after restore; real provider cases need test grants | [Credential audit](e2b-credential-contract-2026-09-23.md), [fresh run](e2b-fresh-desktop-qualification-2026-09-23.md) |
| SSH and viewer boundary | access_viewer / Luna high; orchestrator live run | Local regressions, fresh SSH/PTY, browser rendering and WKWebView rendering passed; native save unverified | Native save/editor, packaged Tauri input and two-viewer ownership | [Access audit](e2b-access-viewer-audit-2026-09-23.md), [fresh run](e2b-fresh-desktop-qualification-2026-09-23.md) |
| Run isolation and lifecycle seam | orchestrator | Local regressions, SDK controls, source-built D1/D2 failure cases and exact-run desktop cleanup complete | Repair lifecycle recoverability and qualify a canonical upload barrier | `experiments/e2b-local/`, [D1](e2b-d1-post-capture-repro-2026-09-23.md), [D2](e2b-d2-rootfs-sync-repro-2026-09-23.md), [fresh run](e2b-fresh-desktop-qualification-2026-09-23.md) |

## Fresh desktop run after the SDK controls

The full ARM64 desktop template built successfully in the same owned scratch
deployment. Fresh run `10e614d143da4ed29187a63c922d970a` passed all six
desktop workflow cases and all three synthetic Git/credential cases on the
same candidate. The browser and disposable WKWebView rendered the desktop;
native typing reached Mousepad, but a persisted native save was not verified.
The run's three desktops were deleted by exact run ID after collection. The
temporary native viewer and port forward were closed. See the
[fresh-run report](e2b-fresh-desktop-qualification-2026-09-23.md) and
[gate matrix](e2b-qualification-gates-2026-09-23.md). The VM remains for
evidence inspection. Post-cleanup Mac Data free space was 18 GiB, so no more
full builds were started. D1–D3 and cutover remain blocked.

## Initial scratch baseline

`silo-e2b-diagnostic-d1` is a separate, owned Lima deployment using host port
13801. The orchestrator alone holds its runtime mutation lease. The historical
`silo-e2b-poc` instance remains read-only. The scratch stack uses the pinned
Compose inputs and reported healthy services; Mac Data free space was 44 GiB
after these controls and 34 GiB at a later 2026-09-23 check. At this initial
stage, no host stop, service restart, fault injection, or full desktop template
run had occurred in scratch.

The SDK-only 512 MiB Debian template was built in scratch. Independent live
controls passed: checkpoint `c4e314f4294748e5abb3ac4a70a0f617`, checkpoint
with process identity `7787b758382647ceaca5f95046492283`, and pause plus
explicit resume `6e61cc0e3d3a4a34afee919afb3a7929`. A fourth checkpoint
`39c4301424464ed6b6ec3828b9695000` restored snapshot
`v4pp3zpfp726lqeu8k8d:default` into a second sandbox. Its original and restored
sandboxes both returned the process-only nonce and fsynced file hash and accepted
a new write. Exact reports are in the ignored
`app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/sdk-lifecycle/`
directory. These success controls do not reproduce D1, D2, or D3.

The scratch deployment initially had SDK-only guests outside the PoC desktop
registry; they were later retired by exact report ownership. Do not use
`poc.py stop`, `shutdown.py`, or global pause as cleanup.
The source's pause RPC returns while upload is in flight; Compose permits 60
seconds for orchestrator stop while the source upload retry budget is two hours.
`shutdown.py` now refuses a host stop before side effects until a verified
per-snapshot durability barrier exists. The full PoC run and D3 host restart
remain gated by that barrier.

The SDK-only `sdk-host-restart-probe.py` records passive, run-owned guest
inventory but blocks before pause. Its post-restart verifier is gated on a
trusted canonical-object readback attestation, which the current SDK and
inspected runtime status do not provide. Five synthetic probe tests pass. No
scratch guest or host was changed by this probe.

After syncing only PoC source files into scratch (without restarting services),
the passive prepare probe selected SDK pause run
`6e61cc0e3d3a4a34afee919afb3a7929`. It wrote
`evidence/sdk-lifecycle/restart-preflight-2026-09-23.json` with status
`blocked`, `pause_attempted=false`, and `restart_authorized=false`: its tagged
512 MiB guest was already passively observed `paused`, consistent with timeout
auto-pause after the earlier control. No connect, pause, resume, or host stop was
performed by this probe. Even a running guest would next meet the missing
canonical readback barrier, so this observation is not a restart qualification.

Three disposable 512 MiB SDK-only transport fixtures then passed:
`5920a981ac2f4408a344967ccd72205a` and
`956c676257bc4a83952c9589eeef7c41`, followed by the final manifest-bearing
run `73a8de760d5849dca4e8f6252ab0e863`. Each observed PTY output with
nonzero exit code 17, a streamed 256 KiB binary file matching its SHA-256,
an upload producer interruption reported as `WriteError`, and a cancelled
download followed by a matching full retry. The second fixture measured
65,536 bytes left in the remote file after the interrupted upload; the final
run confirmed the same result and recorded SDK 2.51.0, Linux boot ID, kernel,
architecture, template ID, script hash, resources, and exact create request.
Callers must not assume atomic file writes. All run-owned guests were deleted
only after successful reports were saved. Reports are in ignored
`evidence/sdk-transport/` inside scratch. PTY network loss and lifecycle
interruption remain unrun.

A later read-only resource snapshot found the scratch Lima directory using
17 GiB physical Mac storage, with 28 GiB Mac Data free; Linux reported 61 GiB
free in its 77 GiB guest filesystem and 4096 free 2 MiB hugepages after the
disposable guests were deleted. `docker stats --no-stream` reported about
1.31 GiB for ClickHouse and 460 MiB for orchestrator, with smaller API,
dashboard, Vector, Postgres, Redis and proxy containers. These are one-time
observations with paused SDK guests and background services, not a capacity
curve or a supported minimum host profile.

The adapter now journals create intent and offers explicit recovery after an
ambiguous response; fresh qualification reports carry run IDs and manifests;
failed-run cleanup derives IDs from the run-tagged registry. A default mutating
`poc.py` invocation cannot select the incident VM. SSH framing is capped at
65,537 bytes, and paired half-close behavior is tested. The local focused suite
passed 42 tests on 2026-09-23 using the disposable loopback-enabled Python
environment. No shipped SiloUI code changed.

The later integrated local suite passed 73 deterministic tests after revert
recovery, viewer-session changes, and the credential receipt fixture. These
use fake SDKs and loopback fixtures; they do not prove live E2B, native viewer,
or guest durability behavior.

A bounded source-built comparison then ran on the same scratch VM without
replacing or restarting the E2B services. The captured public tree transferred
with matching archive hash and built under Go 1.26.8 Linux/ARM64 in a 3 GiB,
two-CPU container after reducing compiler parallelism to one worker. Its
orchestrator SHA-256 is
`22f8b1acc6efdd74ec72389055a64ebcc9da10e872cc5266063848600a247e79`.
Three focused checkpoint/admission/upload tracking Go tests passed. The
source-built and deployed binaries each list 241 Go dependencies, but
`gofrs/uuid/v5` and `sumup/typeid` resolve to different versions. This rejects
an exact release-build match for the captured source/dependency set; it does
not classify any historical incident. The source-build commands, raw concise
logs and metadata are preserved under ignored
`deployments/diagnostic-d1/`; [the provenance audit](e2b-provenance-audit-2026-09-23.md)
records hashes and limits. The VM had 59 GiB filesystem free and the Mac 26
GiB physical free after the comparison.

A disposable copy of that source then added an exact-sandbox-ID return after
fresh-checkpoint snapshot/cache completion. The five earlier paused SDK
controls were retired only after their passing reports and ownership tags were
checked. The test binary ran only on the now-empty scratch orchestrator; the
trigger file was absent during a fresh passing checkpoint/restore control
`280a431d020147a790a4abf3146ebd67`. An immediate earlier create control
`c2f615ad154a440984f8622ab092a10f` had received 503 while the API node
was still unhealthy after Docker health turned green. API logs showed the node
ready about 28 seconds later. Both passing control guests were then retired
by exact run ID.

One targeted failure run `a0fdce093ab641698707d9428ac7d531` reached the
post-capture hook. The API removed the original, the build failed, passive SDK
lookup found no sandbox, and its SDK snapshot restore ID returned 404. Four
local files remained, with no canonical build directory. The local synthetic
guest bytes and exact 15-second service logs were preserved root-only inside
the owned VM. [The D1 reproduction note](e2b-d1-post-capture-repro-2026-09-23.md)
records run IDs, hashes, timeline, missing proof and the remaining fix. The
pinned orchestrator binary was restored and verified healthy; no test trigger,
test environment values or guests remain. No historical VM or shipped SiloUI
code changed.

An independent review of the D1 report found a missing structured correlation
receipt and an injected-hook side effect. The saved redacted receipt now ties
the exact run, sandbox, RPC marker, API response and failed catalog build to
hashed private log lines. The hook had registered an upload future before
returning and bypassed its normal completion; the temporary process was later
replaced. A conditional peer route was not present at the later read-only
Redis check, which cannot prove whether it existed during the run. These
limits are recorded in the D1 note.

A separate disposable D2 source copy added one-shot exact-sandbox EIO at the
rootfs diff sync boundary. Two focused Go tests passed and a bounded Go 1.26.8
Linux/ARM64 build produced binary SHA-256
`29470ef6d74a2b7055003442cbe347f573ae16ce32e947cfd090df8e5557d819`.
The first unarmed SDK control got the known placement-readiness 503 before
creation; the next pause/resume control
`d7af6d2e5a714287b88dba00ecda21ac` passed and its guest was retired by
exact run ID. The armed run `5ca23681b9ae451da8c713b8e5ea9837` stopped
and unaddressed the source before returning a rootfs sync EIO. Its build
failed, the checked build paths held no files, and exact SDK reconnect and
snapshot-create recovery calls were rejected. Raw 13-second service logs are
preserved root-only in the scratch VM; redacted catalog and log-line receipts
are in ignored local evidence. The [D2 reproduction note](e2b-d2-rootfs-sync-repro-2026-09-23.md)
states the synthetic fault's limits. The pinned orchestrator was restored
healthy, with no SDK guests. No historical VM or shipped SiloUI code changed.

The local revert path now journals intent before source pause. If the pause
response is lost, explicit recovery checks the source state without connecting
or deleting it; a `running` read leaves the intent unresolved. An
accepted-but-not-yet-visible replacement keeps its operation pending, rather
than clearing the only evidence needed to find it. Focused
revert tests cover both crash boundaries. This is a local adapter correction;
it does not repair the upstream fresh-checkpoint failure path.

Independent review found two further revert crash cases: a `running` read may
precede completion of an accepted pause, so recovery now retains the intent
until the source is observed paused; and replaying the exact journaled cleanup
accepts SDK `SandboxNotFoundException` after an earlier successful kill. The
evidence endpoint also distinguishes local case reports from integration
qualification: matching source/template/SDK/kernel/architecture/boot fields can
set `local_case_status=passed`, while overall `status=blocked` until deployed
runtime identity and remaining gates are established.

Historical D3 read-only follow-up located the exact failed latest-state build,
its catalog row, orchestrator upload-success marker, panic log, and six canonical
file hashes. See `docs/research/e2b-d3-artifact-audit-2026-09-23.md`. Header
parsing closed a 23-build dependency graph; all 46 current canonical body files
and 92 sidecars exist and were hashed. This establishes current existence and
identity only, not pre-failure integrity or causal correctness. The separate
earlier sandbox/build must not be mixed into that graph.

A read-only canonical verifier then inspected the *separate passing* D2
pause/resume control's exact build `f5664a02-f7aa-4960-928f-3890ad4a3cb9`
in scratch. It parsed and hashed a closed V3 graph of 7 builds, 42 required
objects and 1,570,630,655 bytes. The final manifest SHA-256 is
`f467437439aa1e13ea18c1ba217bf8e9108d0606251743bb6563f6edc0518ccf`.
See [the readback note](e2b-canonical-readback-2026-09-23.md). This adds a
current-file control, not a past upload completion signal or a restart result.
The original SDK restart and desktop host-stop probes remain guarded.

One fresh SDK-only run `64a196437b254295af1a4282b506327c` then used the
pinned diagnostic runtime and a single 512-MiB guest. After each exact pause,
the upload-success marker, catalog build, `sync -f` and full canonical
readback were checked. Its orchestrator-only restart restored process memory,
fsynced file and a new write from build
`feb009cc-1190-4c85-80ba-faa413b05119`. A second pause produced build
`8f493210-9422-46b2-b152-95a60de57548`; an exact-run guard rechecked the
54-object canonical closure before a clean Linux host stop. The boot ID
changed on restart, the same manifest hash matched, and explicit SDK restore
passed the three oracles. The guest was retired by exact run ID. See
[the controlled restart note](e2b-d3-controlled-restarts-2026-09-23.md).
These controls leave the historical D3 cause and fresh-cache path unresolved.

Historical D2 read-only follow-up found the exact EIO line in retained Docker
logs, the failed snapshot catalog row, and process stop before the error reply.
The current failed-build body/cache is absent; original raw `/tmp` log is
absent. See `docs/research/e2b-d2-error-audit-2026-09-23.md`. The source of EIO
and recovery immediately after failure remain unresolved.
A later read-only journal check found a retained-log gap spanning the exact
18:53 CEST incident; no kernel entry survives for 18:52–18:55 CEST.

Runtime lease: orchestrator alone may operate the new `silo-e2b-diagnostic-d1`
scratch VM. The historical `silo-e2b-poc` deployment remains read-only. The
local tool sandbox could not read its host-agent socket, so its `limactl` status
of `Broken` was not evidence of actual VM failure; an unsandboxed read-only query
reported `Running`.

Before scratch setup, Mac physical free space was 59 GiB on the Data volume;
the existing owned Lima directory allocated 52 GiB. The Mac has 64 GiB RAM.
The existing Linux VM reported 23 GiB filesystem free, 16 GiB RAM, 4096 total
and 4084 free 2 MiB hugepages, 63 reserved at that pre-scratch check. These
were point-in-time values, not a validated capacity model. Scratch setup had
to stop before physical space fell below a safe margin; no fault test could
fill the Mac disk.

## Current state after D1/D2 diagnostics and controlled restarts

The owned scratch VM remains running after one guarded clean restart. Its
orchestrator was restored to pinned
SHA-256 `e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`
and Docker health is `healthy`. The later exact-run guest was retired and no
Firecracker process remained. The historical VM was inspected read-only only;
its journal has no kernel entries in the original D2 failure window. No desktop
host stop, full desktop
template, native editor/viewer session, second-computer run, or Silo cutover
occurred in this diagnostic series. The local deterministic suite passed 88
tests after the host-control additions. The full gate matrix remains blocked.

## Fresh desktop follow-up and upstream report review

The full ARM64 desktop template subsequently built on the owned scratch VM.
Two fresh run-owned desktop/Git suites passed, including the strengthened
current-grant-after-revert case in run
`7d468e5fb97f450abcc4aba0707518b3`. See the
[fresh-run report](e2b-fresh-desktop-qualification-2026-09-23.md) for report
hashes, exact guest-file readback, viewer input findings and exact-run cleanup.
The original 88-test count above belongs to the earlier diagnostic series; a
new receipt regression was added after it.

Independent [D1](e2b-d1-report-readiness-2026-09-23.md),
[D2](e2b-d2-report-readiness-2026-09-23.md), and
[D3](e2b-d3-report-readiness-2026-09-23.md) reviews separated historical
incident evidence from source-built fault results. A second
[D2 review](e2b-d2-independent-review-2026-09-23.md) narrowed the candidate
claim to tested SDK unaddressability after a synthetic sync error. The
[release-source mapping](e2b-release-source-mapping-2026-09-23.md) found no
verified exact public source for the pinned API/orchestrator artifacts. No
upstream bug issue was filed: D1 lacks an allocator-boundary reproduction, D2
lacks an actual failing sync and a demonstrated upstream preservation contract,
and D3 lacks a reproducible queue-state failure from verified artifacts.

The original viewer session model gave every refreshed viewer the writable
port while a desktop was in human mode. An owned live run observed a second
browser viewer change the guest editor buffer during native human control.
The PoC now records a taking viewer instance, signs an explicit ticket role,
and routes only that role to the interactive VNC server. Ninety-one local
regressions passed. A second fresh run, `8c17677f1fc4417ba6a0ef22ed08f40c`,
showed A control/B observer, then A observer/B control after explicit takeover,
then both observer after return to agent. The exact run-owned guest was deleted
after its report was saved. See the [viewer input note](e2b-viewer-input-readiness-2026-09-23.md).

The first full qualification after this change hit a fixture timing race:
Target appeared before Other, but the test waited only for Target. Both windows
were present on later inspection. The failed report was preserved, the wait was
changed to require both, and its two run-owned desktops were retired. Fresh run
`afe75b686e9a47c19e2b83e5c47d30fd` then passed all nine desktop/synthetic
Git checks on the updated PoC. The endpoint reported local cases passed while
overall qualification remained blocked. Its three run-owned desktops were
retired after both reports were collected.

## Late session: causal upgrades, Gate A/R live checks, upstream issue 3658

The deterministic suite was re-verified at 91 passing tests before any live
work. The pinned orchestrator was confirmed healthy (`e5052cb5…`) with zero
Firecracker processes and no SDK guests; the historical VM was queried
read-only once (`docker exec env`/`ls` of its orchestrator container) to
compare cache configuration.

The unexecuted `d1-resume-allocation-exact-id.patch` was built in the scratch
VM (focused Go test passed; candidate binary `7746aa50…`) and run through a
new `d1-resume-orchestrator-switch.sh` deploy/restore cycle. Unarmed control
`16f2d77d9cc14dc8892ad0b5f514cc2c` passed checkpoint and restore with both
oracles; its two guests were killed by exact ID. Armed run
`29f28a3dbd1741cdb11a475ba34cf90d` consumed the one-shot trigger at the real
`ResumeSandbox` call site and reproduced the full preservation failure with
the marker in the catalog reason. Local artifacts, log windows and the
`.fired` marker were preserved root-only; the pinned binary was restored and
re-verified.

The prepared D2 strace preflight passed in a disposable container. Mechanism
probes rejected directory-scoped `-P` (strace 6.19) and per-thread `when`
counting, then validated attach with `-f` plus exact-file `--inject`. A new
watcher-based runner attached the injection to the pause's own diff file on
the **pinned release binary**: runs `bf19ecc9a6bc423ba010df4032d2a8d9` and
`4dcd6f6049ef45cb8aed058d91ad3f39` each produced one INJECTED fsync EIO, the
exact historical error chain, an unaddressable source, a failed build,
removed artifacts, and rejected SDK recovery (2/2). The narrow release-binary
claim was filed as
[e2b-dev/runtime#3658](https://github.com/e2b-dev/runtime/issues/3658).

D3 work established the deployment cache topology (`ENVIRONMENT=local`, no
persistent chunk cache, per-open staging under `/orchestrator/template`,
bodies from canonical `file://` storage) and ran one activity control
`82a4e34f141645eeb6a59dca23f72946` under disk, memory and network load:
upload marker, catalog row, canonical closure readback, orchestrator restart
and resume all passed. The historical closure copy stays blocked on free
disk capacity.

Gate A live checks ran on one run-tagged desktop: the first attempt
(`f07a5e10…`) captured adapter-crash survival but used a wrong lifecycle
field for pause/delete; the corrected run (`352e5538…`) showed concurrent
checkpoint+pause serializing with truthful status, successful resume, and
delete-by-exact-ID producing a tombstone with the sandbox gone. Gate R
measurement `f239e3a34cf34364985ba74172fec8e9` recorded pause returning in
0.1 s with ~156 MiB uploading afterward, hugepage release at pause, retained
snapshot bytes after deletion, and the idle control-plane footprint.

Gate V was not rerun: the scratch VM lacks the 13802 viewer forward and
re-establishing it requires a VM-affecting change; the rejected
observer-input experiment stays unmeasured. Gate C real-provider work stays
blocked on an explicitly authorized disposable repository and narrowly
scoped grant; the local `gh` session is the user's normal account and was
not used. Gate H remains not run (no second computer or alternate hardware).
The gate matrix and replacement plan §5C were updated; no Silo cutover
started.

## Late session addendum: root-cause identification for D1–D3, issues 3658/3659

After spare disk was confirmed available, the 23-build / 12.01 GiB closure of
the failed D3 snapshot was protected-copied from the historical VM (read-only
source) and every body hash verified against the incident-time manifest
(46/46). A V3 chunk-map assembler rebuilt the flat 2 GiB guest image, and a
manual Firecracker run proved the snapfile parses (the fork rejects
file-mapped restore of hugepage-backed snapshots and demands uffd).
Placing the verified bodies into the diagnostic deployment's canonical
storage plus a replicated catalog chain made `Sandbox.create` restore the
exact snapshot through the production path: the 41919-descriptor panic
reproduced 3/3, byte-identical to the incident; the previous generation
(18:11 capture, build `8210f23d`) restored cleanly and ran guest commands.
Root cause: capture-time corruption at 18:53, inside the documented
full-disk window (journal ENOSPC wall from 17:56, which also explains the
journal gap; a loopback-ext4 probe excluded plain ENOSPC as the EIO
mechanism for D2). Filed as
[e2b-dev/runtime#3659](https://github.com/e2b-dev/runtime/issues/3659).

D1 was upgraded to release-binary strength: bounded hugepage exhaustion
(anonymous `MAP_HUGETLB`, fully released afterward) made the pinned binary's
checkpoint fail at the real replacement-allocation call with a genuine kernel
`ENOMEM` (`mmap memfd: cannot allocate memory`), followed by the full
preservation failure. D2's physical context (storage exhaustion) was posted
with it as a comment on
[#3658](https://github.com/e2b-dev/runtime/issues/3658#issuecomment-5799997670).

Operational notes: the API's negative template-alias cache is sticky across
restarts of callers and the snapshots-insert trigger forces
`envs.source='snapshot'`, which `active_envs`-based lookup rejects — the
working recipe (insert, then set `snapshot_template`, then use a never-
queried env id) is documented in the D3 root-cause note. `Sandbox.connect()`
on a stopped sandbox auto-creates a new runtime (observed live; sandbox
killed by exact ID). Firecracker snapshot-editor binaries were built from
vanilla v1.14.0 and v1.14.4 (both reject the fork's vmstate; E2B's fork
source is private). All synthetic catalog rows, the copied closure and every
run-owned sandbox were removed afterward; the pinned orchestrator was
re-verified healthy (`e5052cb5…`) with zero Firecracker processes.
