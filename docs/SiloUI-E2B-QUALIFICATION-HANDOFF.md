# Silo E2B PoC: investigation and completion handoff

Date: 2026-09-23. This is the execution brief for the next agent. It takes
precedence over the investigation order and unqualified causal claims in the
2026-09-22 reports. Read it completely before changing or starting the PoC.

**Latest handoff, 2026-09-23:** The fresh, final PoC run
`afe75b686e9a47c19e2b83e5c47d30fd` passed all six desktop and three
synthetic Git cases on the separate owned diagnostic VM after the viewer-owner
fix and LCU fixture timing fix. The qualification report SHA-256 is
`d20e173894957db243b031af0570a3fbfe28119543a2e0ed3ae859e8dfc6ca26`;
the credential report SHA-256 is
`eaf0dd8c1d1be176b00909765f1f034bd1582eeac7b2814fa8f9464f0d8f4f68`.
The three run-owned desktops were deleted by exact ID; cleanup receipt SHA-256
is `b81239406f115b2dc6317e206ced2822d243c188852523a35514cb258c001e7c`.
The pinned orchestrator is healthy, with no active run-owned guests. The
historical VM remains untouched. The viewer-owner change also passed a live
two-viewer A-to-B-to-agent transition; see
[viewer readiness](research/e2b-viewer-input-readiness-2026-09-23.md) and the
[fresh-run report](research/e2b-fresh-desktop-qualification-2026-09-23.md).
Native WKWebView typing and guest file readback passed, but native pointer and
save-modifier behavior did not. One observer-input experiment was blocked by
automatic approval review and must be reported as unmeasured, not bypassed.

**Upstream disposition:** D1 and D2 synthetic faults on a captured public
source build showed SDK unaddressability after errors. They do not establish
the historical cause, a source match to the deployed release, or a documented
E2B failure-preservation promise. D3's historical restore panic has no
controlled causal reproduction. No upstream bug report is ready. Read
[D1 report readiness](research/e2b-d1-report-readiness-2026-09-23.md),
[D2 independent review](research/e2b-d2-independent-review-2026-09-23.md),
[D3 report readiness](research/e2b-d3-report-readiness-2026-09-23.md), and the
[release-source mapping](research/e2b-release-source-mapping-2026-09-23.md)
before opening an issue. A narrower exact-ID D1 `ResumeSandbox` call-boundary
patch exists at
[`d1-resume-allocation-exact-id.patch`](../experiments/e2b-local/patches/d1-resume-allocation-exact-id.patch)
but has not been built or run in the VM. It substitutes an error before real
allocation and cannot by itself prove the historical allocator failure.

**Current decision:** The PoC has passing local workflow subsets, not an
all-gates qualification. The current gate matrix is
[e2b-qualification-gates-2026-09-23.md](research/e2b-qualification-gates-2026-09-23.md).
Do not start a Silo cutover or file an upstream bug on the present evidence.
Finish the unresolved causal, native, provider, operational, and platform
checks; if a required external resource is unavailable, state that precise
limit rather than replacing it with a synthetic pass.

2026-09-23 execution update: the separate owned diagnostic VM completed
source-built D1 and D2 failure comparisons with passing unarmed SDK controls;
see the [gate matrix](research/e2b-qualification-gates-2026-09-23.md),
[D1 receipt](research/e2b-d1-post-capture-repro-2026-09-23.md), and
[D2 receipt](research/e2b-d2-rootfs-sync-repro-2026-09-23.md). Neither case
establishes the historical trigger or a lifecycle repair. The pinned
orchestrator is restored healthy with no SDK guests. The historical VM remains
read-only. Full PoC qualification and Silo cutover remain blocked.

Later 2026-09-23 update: a fresh full ARM64 desktop run on the same scratch
candidate passed six workflow and three synthetic Git cases. Browser and
disposable WKWebView rendering passed; this run did not verify a persisted
native file save. See the [fresh-run report](research/e2b-fresh-desktop-qualification-2026-09-23.md)
and current [gate matrix](research/e2b-qualification-gates-2026-09-23.md).
All three run-owned desktops were deleted after evidence collection. D1–D3,
native input, real provider and platform gates remain open.

## 1. Mission and scope

Act as an orchestrator. Finish the reusable E2B PoC by establishing the cause of
each observed failure, fixing the responsible implementation, and qualifying the
remaining workflows. Produce evidence another engineer can reproduce. Do not
assume E2B is broken, do not assume our adapter is correct, and do not declare a
resource guard or an older checkpoint a substitute for fixing a destructive
failure path.

The user wants one Linux execution host containing isolated desktop microVMs;
checkpoints that support both revert and fork; credentials substituted outside
guests; reliable SSH/editors, terminals, files, network access and E2B-style
browser viewing. Silo's UI should stay familiar. Proposed lifecycle, checkpoint,
CPU/RAM/storage or other visible behavior changes require the user's approval.

Computer use is being rewritten. Preserve the LCU integration seam and run only
a basic desktop/readiness smoke check when necessary. Do not refactor LCU, add
computer-use features, compare agents, or make the infrastructure reproductions
depend on LCU. A small non-desktop guest is preferable for lifecycle diagnosis.

This work ends with a qualified PoC and an updated, evidence-based Silo cutover
plan. It does not authorize starting the production replacement or redesigning
Silo's UI. Keep bundled MicroSandbox, Git, guest scripts and `silo-remote` intact
in the shipped app until the qualified integration replaces them. Pre-1.0 means
no migration framework, legacy runtime fallback or compatibility layer is needed
at that eventual cutover.

## 2. Correct the previous interpretation first

There are three observed symptoms, not three isolated, reproduced E2B bugs.

| Incident | Supported observation | Not established |
| --- | --- | --- |
| D1: checkpoint | A checkpoint request failed during a reported fresh-resume allocation failure; its source runtime became unavailable. An older named checkpoint later restored. | That every failed checkpoint deletes data; that all uncheckpointed bytes were erased; the exact deployed code path and independently reproducible trigger. |
| D2: pause | One pause returned an error syncing a rootfs diff, the guest process was absent, and subsequent inventory reported it missing. The stop helper initially refused host shutdown. | That low Mac space caused that particular I/O error; which component terminated the guest/removed routing; whether its artifacts remain recoverable; whether the adapter or cleanup contributed. |
| D3: restore | Another guest was reported paused, but after host restart Firecracker aborted with an invalid virtio-descriptor count. An older named checkpoint restored correctly. | Snapshot corruption, a Firecracker bug, a hardware bug, or a safe cache-reclamation operation. These remain hypotheses. |

The inspected source contains a checkpoint implementation that snapshots then
resumes a fresh runtime and cleans up the old runtime even on some errors. It
also contains a pause path with deferred teardown and API-side record removal.
This explains why teardown after failure is plausible. It does **not** prove the
same source ran in the incident, nor imply all failures take those paths.

There is a concrete provenance problem: `poc.py` pins the Compose inputs to
`a065a4ddb3f2c6a4149634d9acb14b62f65839ac`, but that revision's public `.env` selects:

| Component | Selected release |
| --- | --- |
| API | `v0.14.202609170000-908833e4c12` |
| Orchestrator | `v0.16.202609130627-59497eb9134` |
| Envd | `v0.9.202609130627-59497eb9134` |
| Firecracker | `v1.14-0.2.0` |
| Guest kernel | `vmlinux-6.1.177_5008931` |

These are different revision suffixes, not evidence by themselves of an invalid
release combination. The public source URLs using the two short API/orchestrator
suffixes returned 404 during the 2026-09-23 audit. Resolve the actual build
provenance using artifact metadata/release records; do not equate a Compose-file
commit, a Go module import path or a version suffix with a verified source tree.
If exact source cannot be obtained, record that limit and reproduce against an
explicitly source-built revision before attributing a line-level cause.

The historical evidence also needs qualification:

- `evidence/durability.json` was assembled manually from incident observations.
  It is not the output of three independently runnable failure tests.
- `qualification.py resume` retains earlier passing groups and runs the missing
  groups. Its six passes do not constitute one fresh run against one immutable
  final environment.
- Cache reclamation, host disk expansion, log truncation, service restarts and
  code changes occurred between tests. Cache byte equality does not establish
  that every snapshot dependency/header/reference/upload had become durable.
- A restored older nonce/file proves that older recovery point works. It says
  nothing about durability of later writes or the failed latest snapshot.
- Reports and instance IDs describe 2026-09-22. Inspect current state; do not
  assume yesterday's running guest is still running or its timeout has not fired.

Use the terms **process stopped**, **runtime unaddressable**, **catalog entry
removed**, **artifact missing**, **artifact unusable**, and **bytes erased**
separately. Reserve “data lost” for state that recovery investigation cannot
recover, with the scope stated.

## 3. Orchestrator and model policy

Use bounded subagents and keep the dependency graph, integration and final claims
under one orchestrator. Prefer `gpt-6-luna` for workers. Use `medium` reasoning for
inventory, source tracing, bounded implementation and straightforward tests;
use `high` for security boundaries and difficult test design. Do not default to
maximum reasoning.

Escalate to `gpt-6-sol` at `high` for a demonstrated complex problem, such as
cross-process lifecycle cleanup, snapshot lineage, userfaultfd/virtio restoration
or a revocation race. Hand over the reproducer, ruled-out hypotheses and exact
question instead of asking it to repeat discovery. Use `gpt-6-astra` at `high`
only when Sol needs an additional reasoning step or for a final independent
review of a consequential fix. Do not move the whole team to a larger model.

Use agent tools, not new user-owned Codex tasks. When overriding worker models,
use a fresh/bounded context as required by the available spawn API. A normal
assignment has the shape:

```json
{
  "task_name": "checkpoint_repro",
  "model": "gpt-6-luna",
  "reasoning_effort": "high",
  "fork_turns": "none",
  "message": "Read docs/SiloUI-E2B-QUALIFICATION-HANDOFF.md. Own D1 source/provenance analysis and a minimal SDK-only checkpoint reproduction. Allowed files: the assigned reproduction directory and incident note. Do not mutate a host until the orchestrator grants its runtime lease. Return commands, evidence, disconfirmed hypotheses, ownership classification and the smallest next fix. Do not change Silo UI or LCU."
}
```

Currently there are four agent slots: orchestrator plus three workers. Recheck
actual capacity. Queue work instead of creating unbounded nested agents.
Parallelize code reading, fixture design, local unit tests and independent file
changes aggressively. **Only one worker may mutate a given E2B deployment or run
fault injection on its host.** Separate desktops still share the orchestrator,
hugepages, storage and control-plane databases. Credentials, editor or viewer
tests cannot provide clean evidence while another worker restarts or exhausts
that same host. Use a simple declared lease in the work log or a lock file, not a
new scheduling framework.

Give every worker a concrete deliverable, owned files, dependencies, resource
limits, stopping condition and return format. Keep one small work log with task,
owner/model, status, next experiment and evidence path. The orchestrator owns
shared fixtures, the report schema and integration; workers do not overwrite
one another's changes. Preserve uncommitted/untracked work. A new Git worktree
will not automatically include the untracked PoC, so transfer an explicit code
snapshot when isolation is needed. Do not reset or clean the user's checkout.

Suggested waves:

| Wave | Parallel work | Runtime ownership |
| --- | --- | --- |
| A | Luna: provenance/evidence inventory; Luna: existing credential contract; Luna: SSH/viewer/adapter audit | Read-only; orchestrator reserves a fresh diagnostic environment |
| B | One lifecycle investigator; credential fixture/policy implementation; transport/viewer fixture work | Lifecycle investigator exclusively owns fault host |
| C | Complete lifecycle regressions; live credential tests; native editor/viewer tests | Parallel only on independent capacity-qualified hosts, otherwise schedule short exclusive slots |
| D | Remote/platform/resource qualification, clean final integration run, independent review | Orchestrator owns integrated environment and signs off results |

Timebox speculative exploration. If a worker cannot narrow a cause, require an
explicit hypothesis table and a discriminating next experiment; escalate or
reassign while other independent work continues. Do not let repeated broad
reruns replace diagnosis. Do not stop all progress for one missing credential,
second computer or hardware model.

## 4. Read-first map and preservation

Repository root: `/Users/polarzero/code/projects/microsandbox-workspaces`.
Read `AGENTS.md`, the user instructions and this brief. Existing context:

- `docs/SiloUI-E2B-REPLACEMENT-PLAN.md`: intended boundaries and deletion map;
  its UI/export/resource proposals remain unapproved.
- `docs/research/e2b-lcu-qualification-2026-09-22.md`: observations, with the
  provenance and evidence corrections in this brief.
- `docs/research/e2b-local-poc-2026-09-22.md`: earlier template baseline; do not
  combine its successes with the later incident into one release verdict.
- `experiments/e2b-local/README.md` and the experiment sources.
- `app/SiloUI/src-tauri/src/github.rs`, `github_tokens.rs`,
  `github_personal_token.rs`, `github_http.rs`, `github_live_tests.rs`,
  `secrets.rs`, `secrets_runtime.rs`: current product authorization contract.
- Existing editor/SSH, network, remote-owner and backup modules when deriving
  requirements. Preserve requirements without copying obsolete implementations.

Ignored evidence root:
`app/SiloUI/src-tauri/target/verification/e2b-local/`. Use `rg --files -uu` there;
normal searches can omit ignored evidence. The public source checkout is under
`upstream/full/runtime-a065a4ddb3f2c6a4149634d9acb14b62f65839ac/`.

The historical private Lima instance is `silo-e2b-poc`, with
`LIMA_HOME=/Users/polarzero/.silo-e2b-poc/lima`, ownership marker in its parent,
VM-side files in `/opt/silo-e2b-poc`, gateway `127.0.0.1:3800` in Linux and
`127.0.0.1:13800` on the Mac. Do not use the user's default Docker daemon,
OrbStack, ordinary SSH settings, running Silo instances or other VMs.

Before mutations:

1. Inventory files, versions, state, failed build IDs, process identities and
   available Mac/guest disk, RAM and hugepages. Do not auto-resume while observing.
2. Hash and preserve the incident evidence, code/config revision, cache cleanup
   manifests and the dependency graph of failed snapshots. Copy only the
   necessary artifacts or make a supported cold copy when capacity permits.
3. Freeze the incident environment against automatic cleanup/expiry where
   possible without falsifying its history. Record any unavoidable mutations.
4. Use a new, clearly owned scratch deployment for destructive reproductions.
   Reuse the pinned deployment recipe, adding only a necessary test-root/name
   parameter. Do not build a second orchestration platform.
5. Never fill the Mac disk or ordinary VM filesystem intentionally. Use bounded
   disposable storage/cgroups or a targeted fault hook in a source build, with
   automatic fault removal. Do not induce host-wide OOM. Record the limit and
   independently verify which syscall/allocation actually failed.

Do not run `poc.py test`, `reset-failed-test.py`, `reclaim-cache.py`, global
`pause-all`, prune or snapshot deletion against preserved incident resources.
The current test runner pauses all recorded desktops. Fix run isolation first.

Evidence to locate includes `credentials-lfs-run*.log`, `lcu-host-stop.log`,
`lcu-host-restart.log`, cache manifests and the collected JSON reports. The exact
pause error log was written to `/tmp/silo-pause-failure.log` inside Linux; it may
not survive reboot. Missing raw evidence must be marked missing and recreated
in a new run, not reconstructed as a purported original log. Do not publish
private system logs, VM data, SDK keys or credential fixtures.

## 5. Common reproduction contract

Create small, one-command SDK-only reproducers for D1, D2 and D3. They must work
without Silo, `runtime.py`, the browser gateway, LCU, the desktop template or the
credential broker. Start with one minimal guest and add only what is required
to trigger the failure. Reuse a tiny fixture/capture helper; no plugin framework.

For each run record:

- Run ID, timestamps/timezone and boot ID; source revision and dirty diff/hash.
- Container digests, host binaries and their checksums/build info, SDK version,
  template/build/parent IDs, guest/host kernels, architecture/CPU features, flags,
  memory configuration and storage backend. Capture actual values, not defaults.
- Original sandbox ID, logical ID if an adapter is involved, execution/lifecycle
  IDs, process PID/start time and all replacement/snapshot/build IDs.
- Exact API request shape and response/status, with secrets redacted; client
  timeout, server deadlines, automatic pause/expiry and retries.
- Event timeline: admission, freeze, snapshot/export/seal/dedup, local cache,
  upload, DB/catalog/routing changes, resume, cleanup and process exit.
- Two independent oracles: a fsynced file with random content/hash and a random
  value held only in a live process. Add an acknowledged write/counter immediately
  before the tested operation so an old checkpoint cannot accidentally pass.
- Before/after inventory and artifact manifests; hugepage free/reserved values,
  cgroup limits/OOM events, physical/apparent disk space and errno evidence.

The in-memory nonce must never be initialized from a file that a reboot could
read. Wait for readiness explicitly. Observe passively until the explicit
resume step; `Sandbox.connect` can change state and must not be an observation.
Verify the memory value, durable file and a new write after recovery. Separate
unflushed application writes, guest crash consistency, runtime snapshot integrity
and host-loss backup claims.

Start with one failure and one control. For a deterministic defect, establish
three repeatable failures and three passes after the fix on fresh fixtures. For
an intermittent defect, report the numerator/denominator and the tested bound;
use a small fixed series first and expand only if it distinguishes hypotheses.
Do not claim race freedom from a finite loop or hide flakes by retrying.

Every incident ends with: **our bug / upstream bug / unsupported or misconfigured
setup / mixed causes / unresolved**, supported by reproducible evidence. Fix the
responsible layer. If upstream is responsible, create the smallest regression
and patch there; retain only the unavoidable Silo policy/adapter code.

## 6. D1: checkpoint failure investigation

Answer the user's question precisely: does the deployed checkpoint operation
snapshot then resume/use that snapshot, when does it retire the source, and what
happens at each failure point? Do not confuse explicit Silo revert with E2B's
internal checkpoint implementation.

1. Match deployed artifacts to source. Trace SDK `create_snapshot`, API snapshot
   handler, checkpoint RPC, actual fresh-resume/in-place branch, snapshot upload
   and final API/build status. Inspect the selected flag values and compatibility
   requirements. Compare inspected source with the release actually running.
2. Baseline one guest with ample resources: record whether Firecracker PID,
   sandbox ID, execution ID and lifecycle ID change on successful checkpoint.
3. Inject only the allocation failure implicated in the incident. Determine
   whether it is hugepage reservation, ordinary memory/cgroup OOM, memfd mapping,
   VZ/KVM, or a scheduling quota. Do not call any generic placement 500 an OOM.
4. Compare pre-admission refusal, failure during snapshot creation, failure after
   an artifact exists but before replacement readiness, and failure after resume
   but before the API response. Inspect source/process/artifact survival.
5. Run the same operation directly through the SDK, then through the PoC on a
   fresh equivalent fixture. Record every kill/delete the PoC issues. Disable its
   headroom guard only in the dedicated fault reproducer so it cannot hide the
   failure under investigation. Never add unlimited retry.
6. If a newer release or in-place checkpoint path is a candidate fix, change one
   variable at a time and verify the exact supported configuration. A feature
   flag is not a fix merely because the success path is different. Rerun fault
   cases, fork and resume from the resulting artifacts.

Inspected source starting points (not yet deployed-binary proof):
`packages/api/internal/orchestrator/snapshot_template.go`,
`packages/orchestrator/pkg/server/sandboxes.go` (`Checkpoint`,
`checkpointResumeFresh`, `checkpointInPlace`, `snapshotAndCacheSandbox`),
`packages/shared/pkg/featureflags/flags.go`.

Exit: a version-specific sequence diagram, an independently runnable reproducer,
precise survivor/recoverability results, causal classification and a fix with
regression. For a recoverable resource failure, the source remains usable or a
complete, discoverable, verified resumable state preserves the acknowledged
pre-operation state. Returning failure while deleting the only recoverable state
fails the Silo contract. Older checkpoint availability alone does not pass.

## 7. D2: pause failure investigation

Separate two questions: **why did fsync return an error?** and **what terminated
or made the runtime unreachable afterward?** They can have different owners.

1. Correlate the original pause request with exact source/build/PID identifiers.
   Recover the raw errno and time ordering before accepting the manual summary.
2. Trace SDK pause through API state transition, routing removal, node pause,
   rootfs/memory export, async work, catalog deletion, orphan reconciliation and
   teardown. Audit host shutdown and adapter cleanup separately.
3. With ample storage, run pause then immediate resume and verify nonce/file.
   Repeat with a known deferred export/upload and after an explicit completion
   condition. Establish what the API's “paused” response actually guarantees.
4. Inject ENOSPC and EIO separately at the relevant owned snapshot storage
   operation. Test an upload failure separately from local fsync failure. These
   faults are not interchangeable. Avoid process killing as a substitute for an
   I/O error. Verify the injection affected the intended operation only.
5. After failure, inspect live PID, route, SDK inventory, storage objects and
   snapshot/build status before any cleanup. If a process survives but loses its
   route, distinguish orphan eviction from immediate teardown. If bytes survive,
   attempt recovery from a protected copy using supported operations.
6. Repeat without `shutdown.py`, `/api/pause-all`, mode changes, test cleanup or
   viewer/editor connections. Add them individually only if direct SDK passes.
7. Compare behavior for client cancellation, timeout auto-pause and explicit
   pause. Expiry or an unrelated cleanup job must not be blamed on the request.

Starting points: API `delete_instance.go`, `pause_instance.go`, snapshot build
status writes and routing cleanup; orchestrator `Server.Pause` and its actual
sandbox snapshot implementation; artifact uploader; Compose launch/stop scripts.
The inspected source has async upload and deferred teardown, so API state plus
zero Firecracker PIDs is insufficient proof that every artifact is durable.

Exit: reproduce the relevant fault, identify the error's origin and the teardown
owner, inventory recoverable artifacts, fix the responsible failure path and
verify that an unsuccessful pause cannot be advertised as a safely saved guest.
Define the required host-shutdown drain/completion check from the runtime's real
contract rather than an arbitrary sleep.

## 8. D3: failed latest-state restore investigation

Preserve the failing latest snapshot. An earlier named checkpoint is a control,
not a replacement for this evidence. The observed panic was:

```text
Firecracker panicked at src/vmm/src/devices/mod.rs:34:9
The number of available virtio descriptors 41919 is greater than queue size: 256!
```

1. Build an artifact manifest for the exact failed restore: snapshot metadata,
   device state, memory/rootfs headers and bodies, parent lineage, chunk maps,
   file sizes/hashes, CPU/kernel/Firecracker/envd versions and storage locators.
   Trace all referenced ancestors, not only the top-level file.
2. Establish whether “pause succeeded” preceded export/dedup/upload completion.
   Check whether host shutdown waited for that work and whether the snapshot
   was restored from local cache or canonical storage.
3. Run a minimal matrix, with unchanged versions and healthy capacity first:

   | Control/change | What it isolates |
   | --- | --- |
   | Immediate resume, no restart, no cleanup | Snapshot creation and local restore |
   | Wait for documented durability, resume | Async completion race |
   | Orchestrator restart only, no cleanup | Process-local cache/metadata dependence |
   | Clean Linux host reboot, no cleanup | Shutdown drain, storage and host state |
   | Fresh cache through an upstream-supported path | Artifact completeness vs local cache |
   | Our cache reclamation on a separate clone only | Whether our repair discarded required state |
   | No pressure vs bounded storage/memory fault | Pressure-dependent corruption/failure |
   | Quiet guest vs bounded network traffic | Virtio state capture under activity |

4. Include our own interventions as first-class hypotheses: wrong artifact
   selected, stale metadata, incomplete upload, inconsistent parent/header/body,
   premature shutdown, unsafe cache classification, or mismatched runtime build.
   `filecmp` equality of a cache body and one storage file does not rule them out.
5. Capture the Firecracker version/source location, relevant device/queue state
   and memory restore path. Use hashes and bounded diagnostics before dumping
   private memory. Distinguish corrupted saved bytes from incorrect memory
   reconstruction/dirty tracking and from a virtio/KVM restore defect.
6. Escalate to Sol for kernel/userfaultfd/virtio analysis if a direct minimal
   reproduction still fails. Use a fresh source-matched build or another host
   only when that comparison can discriminate a hypothesis. Astra is available
   for a narrow unresolved causal question or final review.
7. Do not “fix” this by silently cold-booting, restoring an older checkpoint,
   changing versions, dropping memory, or deleting the failed artifact. A
   disk-only rescue can be investigated separately on a copy and must explicitly
   report that process state was not recovered.

Exit: failing vs passing control differ in a known causal variable; a root-cause
fix passes the original failing snapshot where applicable and new snapshots
across the relevant boundary. If historical evidence is insufficient, state
that; establish a fresh reproduction or report the exact tested negative result.
Do not invent an explanation to close the ticket.

## 9. Repair the PoC's own lifecycle and evidence gaps

These are code-audit findings or hypotheses, not established causes of D1–D3.
Add failing behavior tests at the relevant seam before changing implementation.
Use a fake SDK for deterministic lost-response/crash cases, then a small live
test for the actual runtime contract. Do not write tests that merely repeat the
implementation's internal calls.

| Area | Investigation and smallest required correction |
| --- | --- |
| Create acceptance | `runtime.py` calls SDK create before durable logical registration. Test server acceptance followed by response loss, process death and preparation failure. Record operation identity before creating; attach sufficient owner/operation metadata to reconcile an accepted runtime without duplicating it. |
| Preparation failure | Test failed preparation followed by failed cleanup/pause. A record must not stay indefinitely `preparing` while reconciliation skips it. Preserve the original failure and the runtime/artifact identity. |
| Revert ordering | Inspect the interval between pausing the source and recording revert intent. Kill the adapter at each actual side-effect boundary, including candidate accepted but unrecorded and replacement committed but old runtime not retired. Recover one authoritative binding without killing the only recoverable state. |
| Status reconciliation | Distinguish unavailable owner/API, missing route/catalog entry, absent process and failed artifact. A timeout is not proof of deletion. Reads must not implicitly resume a paused guest. Reconcile pending operations after restart. |
| Shutdown | `shutdown.py` currently skips records classified `missing`. A retry must not turn a previous failed save into successful shutdown by skipping that workspace. Track unresolved preservation failures and verify the runtime's actual durability completion before stopping storage/control-plane services. |
| Concurrency | Test checkpoint vs pause/delete/revert, host shutdown vs create, and two independent workspaces. Inspect the shared `RLock`; serialize conflicting operations per workspace and host shutdown without blocking all unrelated work unnecessarily. Introduce no distributed lock framework. |
| Session epochs | Determine which authority each epoch revokes. Viewer ownership, SSH identity and credential reverse tunnels currently share lifecycle machinery. Test whether switching viewer mode unintentionally drops editors or the credential broker. Separate lifetimes only where the required behavior demands it. |
| Cleanup | Test runner cleanup must act only on IDs carrying its run/owner metadata. No global `pause-all`, deleting the incident state or reclaiming another run's artifacts. Failed runs keep their evidence. |
| Reports | A fresh run has a new run ID and immutable code/template/runtime manifest. Preserve resumed-run provenance per case, but never present a mixture of old and new passes as a clean integrated run. Generate results from assertions, not hand-written verdicts. |

The stable Silo workspace ID remains separate from the disposable E2B runtime
ID. Preserve a small, explicit operation journal only for real crash boundaries.
Do not mirror the upstream runtime database or add a generic workflow engine.

## 10. Credentials and GitHub: prove substitution and current authority

The desired contract is: supported clients use placeholders inside the guest;
the trusted broker checks the current workspace grant and substitutes the real
credential outside the guest. Snapshot restore must never restore old authority.
The outer execution host/owner remains trusted. Guest root, snapshot contents
and guest-provided headers do not.

First read current Silo GitHub and generic-secret policy. Write a short matrix
of existing supported clients, destinations, operations and permissions. Port
that contract; do not invent a new authorization product or a broad API parser.
Audit whether the PoC's host-established reverse SSH tunnel is the smallest
reliable delivery seam after lifecycle tests. Prefer a supported upstream seam
if it demonstrably meets the same contract. The existing controlled HTTP/1.1
broker is a test tracer, not production policy obtained by changing hostnames.

### Controlled fixture qualification

- Use unique synthetic secrets and independent upstream recording of the
  received credential digest. Prove the guest sends a placeholder, the allowed
  upstream receives the correct credential, and unrelated headers/body remain
  correct. An HTTP 200 alone is not a substitution oracle.
- Test two simultaneous workspaces with different grants and a third denied
  repository. A guest cannot select another workspace by changing headers,
  paths, proxy addresses, runtime IDs, placeholder names or forwarded identity.
- Cover Bearer, Git Basic, supported environment/file placeholders and the
  actual clients in Silo's contract. Exercise curl, Git smart HTTP and Git LFS;
  add gh against a realistic API fixture and then the real provider.
- Enforce destination, scheme, port, hostname and repository scope. Test
  redirects, alternate upload/download hosts, DNS changes, IPv4/IPv6, direct
  egress, CONNECT and TLS verification/trust-store behavior where applicable.
  Unsupported shapes must fail explicitly, without forwarding credentials.
- Test malformed/conflicting authentication, duplicate headers, request/body
  limits, truncation, slow clients, cancellation and concurrent requests.
  Ensure supported Git/LFS sizes and streaming behavior fit the implementation;
  retain a bound with a clear error instead of implementing unused protocols.
- Inspect guest files, process arguments/environment, supported client caches,
  logs, error bodies and fixture memory/process observations for known canaries.
  Exercise redirect/reflection/error responses. A home-directory scan alone is
  not proof that no credential entered the guest. A cooperating upstream can
  encode and return a credential, so do not promise universal protection against
  arbitrary malicious allowed origins. State the supported trust boundary.
- Revoke and rotate while idle, during concurrent requests and during a stream.
  Specify exactly when revocation takes effect and whether active streams end.
  Fail closed when the owner/policy service is unavailable. Do not leak a real
  token through retry diagnostics or preserve it in the guest snapshot.

### Snapshot, fork and identity qualification

1. Establish an allowed request and independent upstream receipt.
2. Checkpoint; change/revoke the host grant; revert and fork from the old state.
3. Verify the old grant is denied by the current authority. Inspect upstream
   receipt to ensure no request was sent with the old token.
4. At the same time, make a new allowed control request from the restored guest
   through the same broker path. A transport failure cannot count as a policy
   rejection. The historical replay test accepted either transport failure or
   403; tighten that oracle.
5. Verify that fork receives a distinct workspace identity, host key and grant;
   source and fork cannot share authority through a restored reverse tunnel or
   cached session. Prove the authority mapping is enforced before restored
   processes can use egress, not merely after desktop readiness.
6. Repeat across owner/broker restart, host restart, lost connection and token
   expiry. Determine whether the existing shared epoch breaks a still-authorized
   broker tunnel during ordinary viewer handoff.

### Real GitHub qualification

Use explicitly authorized disposable repositories and narrowly scoped test
grants. Keep real secrets in the existing secure owner-side storage. Do not
change normal user repositories or print token/config values. If accounts,
grants or permissions are unavailable, record the specific missing input and
continue fixture/transport work; do not simulate a real-provider pass.

- Exercise the current GitHub App installation/token flow and personal-token
  mode if Silo currently supports both. Verify refresh, expiration and
  installation/repository permission changes.
- Prove read repository A, write repository B, deny repository C: clone/fetch,
  push to a disposable ref, gh API operations, and LFS upload/download with
  independent commit/object verification. Attempt equivalent denied operations.
- Resolve gh/GraphQL explicitly. The PoC currently rejects GraphQL. Determine
  what actual supported workflows need, and prefer provider-issued repository
  and permission scopes to a home-built GraphQL policy engine. Do not silently
  broaden permissions to make a command succeed.
- Test the actual GitHub redirect and LFS object-host behavior without sending
  GitHub credentials to unrelated destinations. Explain any supported client
  setup needed for certificates, proxy settings and placeholders.
- Revoke/rotate, restore the old snapshot, then repeat allowed and denied
  controls. Validate both authorization and working connectivity.

Exit: an auditable matrix of real and synthetic cases with exact token scope,
server-side receipt, negative controls and explicit limitations. E2B team keys,
owner signing material and real provider credentials never enter guest/editor/
viewer configuration through the implemented delivery path.

## 11. SSH, native editors, terminals, files and networking

### SSH transport and identity

The current `tcp-bridge.py` reaches guest `127.0.0.1:22`. It is not yet a generic
TCP publisher. Test the framing and lifetime contract before generalizing it.

- Verify binary data, stderr, exit status and both directions of half-close.
  Include a peer that emits its final output only after stdin EOF, a peer that
  closes output first, a slow reader and a disconnect during a large transfer.
  Inspect `FIRST_COMPLETED` handling: finishing one direction must not silently
  discard the other direction's remaining bytes.
- Bound buffering/frame sizes, including WebSocket `max_size=None` paths.
  Test malformed frames, duplicate EOF, truncation, oversized messages, timeout
  and cancellation; assert bounded memory and no leaked processes/sockets.
- Use per-workspace keys and host-key verification. Test wrong key, wrong
  workspace, stale endpoint, source/fork identity separation and revocation of
  an established session. Do not make host-key warnings disappear by disabling
  verification. Document deliberate host-key changes on revert/fork.
- Reconnect after pause, revert and owner/host restart. A retry must not create
  duplicate sessions or resume a guest merely because an inventory screen polls.
  Inspect editor subprocess arguments/environment for privileged credentials.

### Native editors

Complete an actual visible file edit/save with the supported Zed and VS Code
flows, using isolated profiles, temporary SSH configuration and an owned guest.
The earlier VS Code result proves connection and server startup only.

For each supported editor: open the intended remote folder, edit Unicode text,
save, verify bytes independently through SSH/SDK, use its integrated terminal,
exercise a needed development-server forward, disconnect/reconnect, pause/resume
and revert. Verify the editor targets the new runtime after rebinding and cannot
continue accessing a revoked or different workspace. Check supported guest CPU
architecture and remote-server installation on a fresh template.

Use a short temporary profile path on macOS to avoid the earlier Unix-socket
length failure. Before UI automation, identify the exact process/window and
ownership. Never touch an unrelated editor instance. If physical input must be
verified by the user, record the exact remaining manual case; connection alone
must not become a native editing pass.

### SDK PTY and files

- PTY: resize, Unicode, Ctrl+C/signals, terminal exit, long output, backpressure,
  network loss, cancellation and child/process cleanup. Preserve exit status;
  do not report a disconnected command as successfully completed.
- Files: small/large binary hashes, permissions, missing paths, symlinks and
  path boundaries consistent with existing Silo behavior. Test interrupted
  writes, uploads/downloads during lifecycle changes and stale runtime bindings.
  Require atomicity only where the product contract promises it; surface partial
  results otherwise. File inspection must not unexpectedly resume a guest.

### Network publication and isolation

Derive protocols from current Silo use cases. Test HTTP/HTTPS and WebSocket with
a development server and bidirectional traffic. Prove raw TCP separately with a
small binary/half-close fixture for existing TCP publication needs; do not call
SSH-only success generic TCP support. Do not add UDP or a new network product
without an existing requirement.

Test create/remove publication, active-connection revocation, stale URLs,
wrong-workspace routing and reconnection after revert. Keep E2B API/envd/owner
control endpoints private and master credentials out of browser/editor URLs.
Exercise permitted internet access plus denied sibling, outer-host, control-plane
and metadata destinations with positive controls. Include DNS and IPv6 where
enabled; a few blocked IPv4 probes do not establish guest isolation. Inspect
actual host firewall/routes and reachable listening services.

Exit: real editor save/reconnect plus bounded transport tests, SDK terminal/file
tests and protocol-specific networking evidence. Report unsupported protocols as
unsupported, not as a reason to build a universal tunnel layer.

## 12. E2B-style viewer: usability, input ownership and browser trust

Keep E2B's browser/noVNC desktop approach. A native webview harness tests whether
Silo can embed that approach; it does not preserve the old native viewer or
authorize a production UI redesign. Use a simple fixed desktop fixture, not the
LCU rewrite, for these tests.

1. First test the browser, then the existing isolated WKWebView harness, then a
   minimal isolated Tauri harness using the intended webview configuration.
   Verify an actual rendered desktop and saved file, not an HTML loading screen.
2. Test normal keys and physical modifiers, Unicode/layouts, focus changes,
   scrolling, drag, resize/DPI, reconnect and plain-text clipboard both ways.
   Use controlled clipboard content and restore user clipboard state where
   possible. Test file transfer only if offered by the chosen viewer flow.
3. Separate automation key mapping from viewer behavior. The historical test
   used noVNC's on-screen Control button successfully; direct automated Control
   did not work. Compare the same action in browser and webview with an input
   event/visible buffer oracle before attributing the fault.
4. Prove human/agent ownership: an interactive human session accepts input;
   changing ownership ends or demotes all existing interactive sessions; an
   observer cannot inject input even with client-side `view_only` disabled or
   a crafted WebSocket message. Test two simultaneous viewers and stale sessions.
5. Use a visible buffer or guest-side input-event counter as the denial oracle,
   with successful positive input before/after. An unchanged saved file can
   simply mean the edit was never saved; it is insufficient proof of rejection.
   Do not equate input ownership with killing already-running guest processes.
6. Verify that changing viewer mode has the intended effect on editor, SSH,
   credential and PTY sessions. Do not accidentally revoke all channels through
   a shared epoch or promise cross-channel cancellation that was never designed.

There is also a concrete trust-boundary hypothesis to test: the PoC serves
guest-provided noVNC assets under the same loopback origin as its control API.
Same-origin custom headers do not authenticate guest-controlled JavaScript.
On an owned fixture, replace an asset with benign code that attempts an unrelated
workspace control action; independently observe whether it succeeds. Test
viewer URL/session reuse, path traversal, service-worker persistence and attempts
to reach privileged Tauri IPC. Do not run this against another user's workspace.

If reproduced, fix the demonstrated boundary with the smallest effective design:
trusted host-served viewer assets, appropriately scoped short-lived sessions,
and origin/capability separation as required by the threat model. Do not add an
identity platform. No guest content should inherit host-control API privileges
or broad Tauri capabilities; no viewer receives the E2B master/team credential.

Exit: browser and intended webview pass the same defined input/session cases,
including deliberate client bypass attempts. Mark any remaining physical/manual
cases unrun. Document the embed contract without changing Silo's product UI.

## 13. Resources, storage, host lifecycle and deployment qualification

Resource guards are useful admission checks. They do not fix incorrect cleanup
or establish rollback guarantees. Keep diagnosis and prevention distinct.

### Measure the actual capacity model

For the chosen profiles, record idle host/control-plane costs; first template;
first/second running desktop; pause/checkpoint peak; fork/revert peak; retained
snapshot cost; and deletion/reclamation. Record CPU, Linux RAM, reserved/free
hugepages, swap if any, Linux filesystem usage, logical file size and physical
Mac allocation/free space separately. A sparse 80 GiB disk is not 80 GiB of
reserved physical capacity, and shared template bytes are not free guest RAM.

Use bounded concurrency to determine where allocation fails and whether
admission needs a reservation or an operation queue. Test competing creates and
checkpoints so two requests cannot both rely on the same stale headroom check.
Choose the smallest mechanism supported by evidence. Do not claim a fixed
2560 MiB guard is correct for every profile or implementation path.

Determine what CPU/RAM/disk changes the selected runtime actually supports:
live change, recreate from a disk/template, or unsupported. Memory checkpoints
may impose CPU/device/memory compatibility constraints. Do not present a cold
reboot as preserving a running process or assume cross-architecture restoration.
Record proposed Silo resource-control changes for later user approval.

### Storage lifecycle and cleanup

- Reproduce template-build/log growth and qualify bounded logs, useful health
  checks and failed-build cleanup. A healthy container can contain a failed
  orchestrator; probe the real dependency/operation contract without resuming
  arbitrary user workspaces. Measure startup and time-to-ready separately.
- Establish snapshot/template lineage and supported retention/deletion APIs.
  Delete a checkpoint with a live fork and prove the fork and other checkpoints
  remain usable. Delete source/fork in both orders. Test active references,
  interrupted deletion and failed builds without orphaning required ancestors.
- Prefer upstream-supported reclamation. The current byte-equality cache script
  is an unqualified intervention, not a production storage design. Do not port
  it unless complete dependency/durability semantics and regressions justify it.
- Run ENOSPC/EIO tests on bounded disposable storage only. Exercise preflight
  refusal as well as faults after acceptance. Keep diagnostic logs bounded and
  preserve the failing output before repair.
- Distinguish a local checkpoint from a backup surviving execution-host loss.
  Determine supported export/import or off-host artifact requirements through
  a bounded spike. Do not silently remove backup guarantees or build a new backup
  format; bring any missing product capability to the user as an explicit
  decision after presenting the evidence.

### Host lifecycle and clean deployment

Qualify fresh setup, interrupted setup/build, retry, health/readiness, clean
shutdown and restart, and recovery after a controlled crash. Isolate one failure
boundary at a time. A successful pause response or absent Firecracker process
alone is not a durability barrier. Demonstrate that host shutdown waits for the
necessary artifacts and reports each failed workspace without erasing its
unresolved status on retry. Do not stop a host containing unpreserved user state.

Pin and checksum the deployed inputs; validate architecture, required host
capabilities and exact service versions. Qualify the chosen runtime update path
against existing checkpoints on an owned copy before proposing it. Record
compatibility requirements; do not invent format migration or backward support
for pre-1.0 Silo data. Verify cancellation/failed download does not replace a
working owned deployment with a half-installed one.

E2B Embed calls itself an evaluation deployment. Record the concrete gaps between
its tested launch recipe and Silo's required private install: artifact integrity,
privileged services, exposed endpoints, persistent state, health and shutdown.
Solve only those gaps needed for the chosen deployment, without reimplementing
E2B's control plane or operating a multi-tenant cloud service.

### Hardware and remote-owner matrix

Keep the proven M4 Max nested ARM64 configuration as the initial baseline.
Separately record tests on M3-class hardware, lower-memory configurations,
Linux ARM64 and Linux x86-64 as required by the proposed support matrix.
Distinguish documented compatibility from an executed hardware test. Do not
claim x86 images or memory snapshots run unchanged on Apple Silicon.

Use two actual computers for remote-owner qualification, including the intended
Linux execution-host path when available: create, terminal, files, editor,
viewer, credentials, checkpoint, disconnect/reconnect and owner restart.
Exercise a controller disconnect while work continues, current owner-side grants,
lost authorization and stale sessions. Local app shutdown must not implicitly
stop a remote execution host or its workspaces. Do not copy controller secrets
to a remote machine merely to make parity tests pass.

Unavailable hardware/second-computer access is an explicit unrun gate. Continue
independent work; request only the exact missing input when necessary. A second
guest on the same Mac does not establish two-computer behavior.

## 14. Attribution, minimal fixes and upstream reports

For each failure, assign one of: **our implementation**, **upstream defect**,
**unsupported/misconfigured deployment**, **mixed**, or **unresolved**. Attach the
evidence, not a vote or intuition. A failure only on nested ARM64 still needs
triage; it is not automatically an E2B defect or an acceptable limitation.

When it is our code: fix the responsible seam, add the regression, delete the
obsolete workaround when no longer needed and rerun the minimal case plus its
affected integration cases. Do not hide a bug behind retries, swallowed errors,
automatic cold boot, older-checkpoint fallback or an optimistic status badge.

For a confirmed upstream problem:

1. Map the failing binary to source, or reproduce on an explicitly source-built
   revision. Inspect existing upstream issues/changes and compare a relevant
   current release/fix on a protected copy. Change one variable at a time.
2. Package a minimal SDK-only command with a tiny guest/template, fixed workload,
   bounded fault trigger and independent state-preservation assertions. Include
   architecture, nested/bare-metal distinction, kernel/KVM/Firecracker/SDK/API/
   orchestrator versions, relevant flags and artifact digests.
3. Supply expected vs actual behavior, the exact error, timeline, deterministic
   reproduction frequency and recovery outcome. Clearly label historical
   observations, reproduced symptoms and established causal findings.
4. Include the narrow failing upstream test and smallest causal patch when
   feasible. Compare baseline and patched runs under the same fault. Prove
   success behavior still works and a different failure is not merely hidden.
5. Prepare a sanitized issue/report with no real credentials, private runtime
   files, user data or complete memory dumps. The user requested upstream
   reporting for confirmed E2B bugs; file a focused report when evidence supports
   it and record its URL. Use one report per independent root cause, not one
   speculative “E2B loses data” issue. Do not contact unrelated people/services.
6. If a temporary pinned patch is necessary, make it reproducible and remove
   only the workaround it actually supersedes. Keep its upstream reference and
   explicit removal condition. Avoid maintaining a forked platform indefinitely.

A minimal fault hook can prove a failure-handling bug even if the original
natural trigger remains uncertain. State both facts separately. If a historical
incident cannot be reconstructed, retain it as unresolved and report the exact
fresh cases that did and did not reproduce. Do not claim complete qualification
while a required preservation failure remains unexplained and unaddressed.

## 15. Integration gates and deliverables

Use separate fields for investigation status and execution status. A case can be
`reproduced / upstream-reported` and still `failed`. Allowed execution verdicts
are `passed`, `failed`, `not run` and `blocked`, with a concrete reason. An
expected injected error can pass a preservation test only when its independent
postconditions pass. A request returning 500 is not by itself the test result.

| Gate | Required deliverable and acceptance |
| --- | --- |
| P0: provenance | Exact deployment/code/template manifests, preserved incident inventory, known missing evidence and source mapping or an explicit source-built comparison. |
| D1: checkpoint | Minimal reproducer, cause classification, causal fix or documented unresolved result, and failure preservation checks without relying on an older checkpoint. |
| D2: pause | Origin of sync failure and teardown traced; recoverability assessed; verified failure handling and a real durability/shutdown barrier. |
| D3: restore | Protected failed artifact graph; controlled restart/cache matrix; cause/fix or clearly unresolved historical case plus reproducible new evidence. |
| A: adapter | Crash/lost-response/concurrency regressions, stable workspace identity, truthful status and shutdown, run-scoped cleanup. |
| C: credentials | Synthetic and real-provider allowed/denied controls, substitution verified upstream, current grants after revert/fork, no privileged keys delivered to guests. |
| T: access | Binary/half-close/buffering regressions; native editor edit/save/reconnect; SDK PTY/files; protocol-specific publication and revocation. |
| V: viewer | Browser and intended native webview evidence, real input or explicit manual gaps, server-enforced observer behavior and guest-content trust-boundary tests. |
| R: operations | Measured resource/peak/retention costs, bounded logs, meaningful health, safe shutdown/restart, fresh deployment and chosen update path. |
| H: platforms/remote | Executed two-computer and required architecture/hardware cases, with unavailable combinations explicitly unrun. |
| I: integration | One fresh run on one identified final candidate; all required cases linked to raw evidence and no inherited historical passes. |
| S: scope/review | Minimality and standards review, updated cutover/deletion map, and concrete unresolved UI/product decisions for user approval. |

Before integration, choose one candidate runtime, template and PoC revision.
Run fast deterministic tests, the three applicable lifecycle regressions, then
the live workflow suite on fresh run-owned fixtures. Add one bounded repeated
lifecycle/concurrency run with a preset resource/time budget to expose leaks.
Do not loop broad test suites after success without a new change or hypothesis.
Keep optional live/provider/platform tests separate from ordinary unit tests.

Every report must include commands, run IDs, versions, host/profile, fixture vs
real provider/native application, timestamps and evidence paths. Save only
redacted summaries in tracked docs; keep raw private evidence under the ignored
verification directory. Preserve failed attempts. A final screenshot, unit-test
count, compilation or successful retry is not proof of guest durability.

Have an independent agent review the causal evidence and dangerous boundaries,
then review scope/repository compliance separately. Use Astra only if this
review needs the additional reasoning capacity; straightforward review can stay
on Luna or Sol. Review findings must have an actionable failure scenario. Fix
material findings and rerun only the affected checks plus necessary integration.

The orchestrator's final handoff contains:

1. What caused each incident, what remains unknown and which layer was fixed.
2. Minimal reproduction commands and before/after evidence; upstream report or
   patch URLs for confirmed defects.
3. A complete test matrix with failures, blocked/unrun cases and their impact.
4. The chosen deployment and measured resource/footprint constraints.
5. The small set of PoC modules ready to move into Silo, their production homes
   and old implementations to delete in the later cutover. No duplicate adapter.
6. Concrete UI/product proposals for approval, each stating the current flow,
   proposed flow and evidence requiring the change. No silent feature cuts.

## 16. Scope and deletion discipline

Keep the smallest code that proves and implements the required behavior. Prefer
one official SDK adapter, standard SSH and the E2B viewer path. Reuse existing
Silo authorization and owner concepts where they remain necessary. Require two
real implementations before introducing an abstraction between providers.

Delete superseded PoC scripts and duplicate tests after preserving their useful
behavior/evidence. Do not port diagnostic fault hooks, ad hoc cache repair,
manually assembled green reports or broad retry wrappers into production.
Do not add provider selection, backward compatibility, migration, a new backup
format, a credential plugin framework, a custom VM scheduler, an unrelated UI
redesign or LCU rewrite work. Keep live credentials/hardware requirements
explicit rather than expanding the project to avoid requesting a missing input.

Update the existing replacement plan to reflect validated decisions. Production
deletions happen with the approved replacement, not while these gates are open.
If a requirement proves impossible with the selected runtime, state the smallest
concrete tradeoff and bring that decision to the user; do not redefine “done.”

## 17. Primary references and first action

These source links are investigation starting points. The `a065a4d` files are
the inspected Compose/source revision, not verified source for every deployed
binary. Read current primary documentation only for a specifically identified
comparison; do not substitute moving `main` behavior for the incident version.

- [Compose release pins](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/embed/compose/.env).
- [Orchestrator checkpoint and pause paths](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/server/sandboxes.go).
- [API snapshot failure path](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/snapshot_template.go).
- [API removal/pause orchestration](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/delete_instance.go).
- [API pause implementation](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/pause_instance.go).
- [Feature-flag defaults](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/shared/pkg/featureflags/flags.go).
- [Embed deployment scope](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/embed/README.md).
- [Open-source firewall proxy boundary](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/tcpfirewall/proxy.go).
- [Existing replacement plan and product documentation links](SiloUI-E2B-REPLACEMENT-PLAN.md).

Start by preserving the incident evidence and pinning the actual binaries; in
parallel, assign Luna workers the credential-contract and access/viewer audits.
Then run the smallest SDK-only lifecycle baseline on a fresh owned deployment.
