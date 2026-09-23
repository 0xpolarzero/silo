# E2B D1/D2 lifecycle source audit

Date: 2026-09-23  
Scope: static trace of the local upstream source snapshot and PoC adapter. The
source directory is named for Compose/source revision `a065a4d…`; this audit
does not establish that its code or selected releases were running during the
incidents. No tests, SDK requests, host queries, or runtime mutations were made.

## Source provenance boundary

The inspected tree is
`app/SiloUI/src-tauri/target/verification/e2b-local/upstream/full/runtime-a065a4ddb3f2c6a4149634d9acb14b62f65839ac/`.
The earlier P0 inventory found the PoC fetches `compose.yaml` and `.env` from
that revision and validates their static hashes. The `.env` selects the API
release suffix `908833e4c12`, the orchestrator/envd suffix `59497eb9134`, and
sets `RUNTIME_COMMIT=7278c2a380767c9989da73cf4c04b1af1b32da18`. Neither the
Compose revision nor those selectors prove the deployed image digests, feature
flag values, or source corresponding to a running binary. Treat every behavior
below as **what this inspected source specifies**, not incident attribution.

## D1: checkpoint call graph

`CreateSnapshotTemplate` is the API-facing snapshot-template path:

1. `snapshot_template.go:41-68` starts the API `Snapshotting` transition; its
   deferred completion restores `Running` on nil error and leaves the state
   snapshotting on error.
2. `snapshot_template.go:70-87` finds the node, creates the DB snapshot/build
   row and resolves the snapshot-template ID. Failures here occur before the
   checkpoint RPC; the deferred transition restores running.
3. `snapshot_template.go:93-98` issues the orchestrator `Checkpoint` RPC.
4. `sandboxes.go:1045-1098` does envd-version/admission checks and selects the
   strategy. In-place requires all three: `UseSyncWP()`, the
   `in-place-checkpoint` feature flag, and a Firecracker version advertising
   support. Otherwise it calls `checkpointResumeFresh`.
5. `checkpointResumeFresh` at `sandboxes.go:1280-1314` marks the source
   stopping, registers rollback cleanup, and defers both reservation cleanup
   and asynchronous stop of the old sandbox. It snapshots/caches synchronously
   with deferred rootfs export disabled. Once this branch is entered past
   `MarkStoppingReserved`, an error later in the function still schedules stop
   of the source (`1290-1309`).
6. At `sandboxes.go:1316-1353`, it loads the new build and starts a fresh
   sandbox with the same `ExecutionID` but new lifecycle identity. A resume
   allocation error returns while the old source stop and reservation cleanup
   are already armed. A created replacement is added to rollback cleanup.
7. It registers the replacement at `sandboxes.go:1361-1379`, then uploads at
   `1396-1403`. A synchronous upload failure marks the replacement stopping;
   rollback cleanup stops it, while the old source is also stopped. With the
   async upload flag, `runCheckpointUpload` detaches upload and returns before
   that upload finishes (`1110-1181`).
8. On RPC error, `snapshot_template.go:99-150` marks the build failed. Specific
   pre-pause/healthy errors (`FailedPrecondition`, `ResourceExhausted`, and a
   caller-cancelled request) restore API state; other errors complete the state
   transition with error and call `RemoveSandbox(...Kill)`.
9. After RPC success, `snapshot_template.go:153-164` records terminal build
   status and returns the template/build IDs. If that DB status update fails,
   the deferred transition still completes with nil and restores the source API
   row to running.

There is a second API method, `CheckpointSandbox` in
`checkpoint_instance.go:21-140`, that writes a snapshot build to the sandbox's
own snapshot row and has parallel RPC error handling. It documents same
`ExecutionID`, but the precise historical SDK call and handler mapping are not
proven here.

| D1 point in inspected source | Source behavior | What remains unknown for the incident |
| --- | --- | --- |
| API transition/node/upsert rejected before node RPC | Deferred API transition returns to running (`snapshot_template.go:45-79`). | Which API method, status code, and error occurred. |
| Orchestrator admission/envd check/start-slot refused | RPC returns before selecting/entering checkpoint branch (`sandboxes.go:1045-1075`); API restores running for the source-documented refusal codes (`snapshot_template.go:108-121`). | Actual feature-flag result and whether this rejection path occurred. |
| Fresh branch cannot mark source stopping | Returns before deferred stop registration (`sandboxes.go:1280-1289`). | Whether deployed branch was fresh or in-place. |
| Fresh branch snapshot/cache fails | Old source stop is already deferred; snapshot operation returns error (`sandboxes.go:1290-1314`). | Whether the snapshot artifact/cache is complete or recoverable. |
| Fresh-resume allocation fails after snapshot | Old source stop remains armed; no replacement is committed (`sandboxes.go:1316-1353`). API treats generic error as fatal and removes/kills API state (`snapshot_template.go:141-150`). | Actual allocator/syscall failure, surviving source process, artifact durability and deployed code. |
| Fresh replacement created, later registration/upload fails | Rollback stops replacement; source stop remains armed (`sandboxes.go:1353-1403`). API normally removes state for generic errors. | Whether the incident's failure was before/after replacement process creation, and upload mode. |
| In-place artifact-only failure | Source says `Pause` cleanup resumes the same VM and RPC returns `FailedPrecondition` (`sandboxes.go:1226-1253`); API restores running (`snapshot_template.go:108-118`). | Whether in-place was enabled/eligible or whether cleanup successfully resumed. |
| In-place final VM resume fails | `Pause` closes the sandbox and reports `ErrSandboxLost` (`sandbox.go:2251-2265`); in-place handler returns `Internal` (`sandboxes.go:1229-1244`); API removal follows. | Whether this occurred and which exact failure point. |
| RPC success but API build-status persistence fails | Handler returns error after RPC; deferred API state restoration is still success-shaped (`snapshot_template.go:153-164`). | Whether client observed an ambiguous response or a committed snapshot. |

The local source therefore has a concrete destructive failure sequence **for
the fresh-resume branch**: once source teardown is armed, a later allocation
failure schedules source stop even if the checkpoint RPC fails. This is a
source-level observation only. The exact error being “fresh-resume allocation
failure,” its allocation class, and whether this deployed source version ran
are not established by the local tree.

## D2: pause call graph and failure boundary

1. API `RemoveSandbox` starts the transition and creates a detached bounded
   pause context (`delete_instance.go:32-46,127-132`). It deletes the local
   routing catalog entry before calling the node (`delete_instance.go:300-349`)
   and, except on the special refusal-restore branch, removes the API sandbox
   record in a defer (`delete_instance.go:141-149`).
2. `pauseSandbox` upserts the snapshot/build row and calls the node RPC
   (`pause_instance.go:29-79,82-121`). It records build failure on node error.
3. `Server.Pause` may refuse during admission before teardown (`sandboxes.go:
   880-900`). It then marks the sandbox stopping, checks whether it is
   persistable, sets its stop reason, and arms asynchronous sandbox stop before
   snapshot/export begins (`902-959`).
4. `snapshotAndCacheSandbox` invokes `sbx.Pause`, adds all produced snapshot
   components to local cache, and registers upload (`sandboxes.go:1474-1544`).
   If any of these operations errors, `Server.Pause` returns an RPC error but
   its stop defer remains armed.
5. After local cache and upload registration succeed, `Server.Pause` starts
   background upload and returns success without waiting for remote completion
   (`sandboxes.go:962-1004`). The upload goroutine detaches from request
   cancellation and retries; errors are logged, and completion is signalled
   (`sandboxes.go:1590-1629`). A graceful server drain is separately described
   as waiting for that work.
6. In `sandbox.Pause`, a failing operation runs registered cleanup
   (`sandbox.go:1927-1934`). It waits for prior rootfs and memory seals before
   pausing (`1947-1975`), stops checks, then pauses Firecracker and creates a
   snapshot (`1977-1985,2044-2167`). The rootfs export can be deferred only on
   supported storage; otherwise it takes the synchronous `pauseProcessRootfs`
   path (`3181-3283`). A sync export error returns with context at
   `3181-3187,3267-3282`; the lower diff creator's errors are wrapped at
   `3285-3303`. These paths can explain where a rootfs sync error would
   propagate, but do not identify the incident's errno or syscall.

| D2 point in inspected source | Process / route / catalog consequence | What remains unknown for the incident |
| --- | --- | --- |
| API upsert or node lookup fails | Local route may already be deleted; API record removal still runs for generic error. Node pause may never have run. | Whether original fsync preceded or followed API route deletion and DB upsert. |
| Pause admission retry refusal | Node returns before `MarkStopping` (`sandboxes.go:880-907`). With API refusal-restore flag off, generic refusal path may remove record and kill/leave routed state depending edge; with flag on, restoration is conditional (`delete_instance.go:137-193`). | Actual flag value and whether the original error was admission refusal. |
| `EnsurePausable`, FC pause, snapshot, rootfs export or local-cache registration fails after node arms stop | Node schedules stop (`sandboxes.go:911-959,1727-1741`); API generic error path removes the record, and the route was already deleted. | Actual operation, source process exit timing, edge/orphan behavior, and whether artifacts remain. |
| Local snapshot/cache succeeds; upload continues | Node returns pause success while upload is outstanding (`sandboxes.go:962-1004,1590-1629`). | Whether API success or failure was observed and whether shutdown drained that exact upload. |
| Rootfs export deferred and later fails | Pause may have returned after setup; completion failure is asynchronous and does not mean `pauseProcessRootfs` failed in the request (`flags.go:276-284`; `sandboxes.go:949-977,1590-1629`). | Whether defer flag/provider path was active and whether the observed error was this async seal or synchronous fsync. |

This code distinguishes the sync error from teardown ownership: source describes
local sync/export failure in `sandbox.Pause` and separate API route/record
cleanup plus node stop scheduling. It does not prove those were the components
or ordering in the incident deployment.

## PoC adapter behavior

`experiments/e2b-local/runtime.py` adds distinct SDK-level actions:

- `lifecycle(..., "pause")` calls `handle(sid).pause(keep_memory=True)`, removes
  the cached handle, sets status to paused, and saves (`runtime.py:246-266`).
- `checkpoint(sid)` checks the hard-coded hugepage headroom guard before
  calling `sandbox.create_snapshot()`, then stores the returned snapshot ID and
  advances the record epoch (`runtime.py:268-290`). Its own comment states the
  guard is not an atomic reservation or upstream fix.
- `create_snapshot()` is **not** the same as this inspected Go API's
  `CreateSnapshotTemplate` or RPC `Checkpoint`; the SDK request mapping and
  deployed SDK version were not traced here. No SDK source was present in the
  inspected PoC module.
- On revert, the PoC pauses a running source first, journals the old runtime,
  creates a candidate from checkpoint, prepares it, commits the candidate ID,
  then kills the retired runtime (`runtime.py:184-234`). It has an explicit
  recovery path, separate from upstream internal checkpoint.

## Unknown flags/build provenance

The source defaults show `in-place-checkpoint=false` and `use-sync-wp=false`
(`flags.go:199-209`), `peer-to-peer-async-checkpoint=false`
(`272-274`), `defer-rootfs-export=false` (`276-284`),
`pause-admission-grace-milliseconds=-1` and
`pause-refusal-restore=false` (`460-471`). Defaults do not prove runtime
values; feature-flag service overrides and process build identity are not in the
static source. The handoff's `.env` pins Firecracker version `v1.14-0.2.0`, but
that alone does not prove a running guest used sync write protection or that
the feature flag enabled in-place checkpoint.

## Discriminating experiments for unresolved questions

These are next-step proposals only; none ran in this audit.

| Question | One discriminating experiment |
| --- | --- |
| Was D1 fresh-resume or in-place, and when did source retirement occur? | On a new owned deployment with actual image digests and flag values captured, make one SDK-only checkpoint with a process-only nonce and fsynced file; record source/replacement Firecracker PID, sandbox/execution/lifecycle IDs at each RPC boundary. |
| Did a failed fresh resume retire the only live source while leaving a usable artifact? | On a new owned fresh-branch fixture, inject a bounded failure only at replacement allocation after snapshot cache completion; before cleanup, inventory source/replacement process IDs, build state and complete artifact lineage, then exercise only supported recovery from a protected copy. |
| What exact component produced D2's rootfs sync error? | On an equivalent new owned fixture, instrument the underlying rootfs diff export/write/fsync and preserve errno plus syscall/file identity; separately inject ENOSPC and EIO on a bounded disposable filesystem. |
| What caused D2 teardown/catalog loss after the sync failure? | With that one controlled export fault, trace API route/catalog transition, orchestrator process state, stop/close and adapter cleanup timestamps; compare direct SDK pause with the PoC pause on separate fresh equivalent fixtures. |
| Did `pause` success imply durable remote artifacts? | On a fresh fixture with a deliberately gated upload, return from pause while the upload is blocked, then inspect the exposed pause response and upload completion state; compare a controlled clean server drain against a bounded crash on disposable state. |
| Was any source branch actually deployed in the incident? | Preserve a read-only deployment capture associating incident request/process IDs with image digests, binary build info, resolved redacted config, effective feature flags and template/parent IDs; source-build comparison is the fallback if mapping is unavailable. |

Stop condition met: source tracing only. No files outside this audit note were
edited for this task.

## D1 source-built comparison plan (initial audit)

The inspected orchestrator module declares Go `1.26.8` and replaces the
clickhouse and shared modules with sibling source trees
(`packages/orchestrator/go.mod:1-8`). The workspace also pins `go 1.26.8`
(`go.work:1`). Its Docker builder uses `golang:1.26.8-bookworm`, enables CGO,
and deliberately keeps glibc at Debian bookworm 2.36 for Ubuntu 24.04 host
compatibility (`packages/orchestrator/Dockerfile:1-11,38-48`). A direct
Linux/arm64 build therefore needs Go 1.26.8, an arm64 Linux build host or
compatible cross compiler, CGO, and the GNU C toolchain/headers; cold module
caches may require network access. The source tree itself is a local captured
tree, and its parent Git root is not evidence of that tree's upstream commit.

From the captured tree root, build the orchestrator only (do not use the
Makefile, whose first two lines include environment configuration):

```sh
SRC="$PWD/app/SiloUI/src-tauri/target/verification/e2b-local/upstream/full/runtime-a065a4ddb3f2c6a4149634d9acb14b62f65839ac"
cd "$SRC/packages/orchestrator"
GOWORK="$SRC/go.work" CGO_ENABLED=1 GOOS=linux GOARCH=arm64 \
  go build -o /tmp/e2b-orchestrator-linux-arm64 \
  -ldflags "-X=main.commitSHA=<explicit-source-tree-label>" .
```

This follows the Docker/Make build shape (`Dockerfile:40-43`,
`Makefile:85-90`) while avoiding private `.env` inclusion. The placeholder must
be an explicitly recorded label; the directory suffix
`a065a4ddb3f2c6a4149634d9acb14b62f65839ac` is a capture label, not verified
Git provenance. Record the source tree digest, Go version, toolchain/container
digest, command, and output digest alongside any comparison.

### Narrow fresh-resume failure injection

The smallest useful server seam is immediately after
`snapshotAndCacheSandbox` succeeds and immediately before
`ResumeSandbox` in `pkg/server/sandboxes.go:1309-1329` (the intervening template
lookup is at 1316-1323). A test-only injected error at that boundary exercises
the fresh replacement allocation failure after a snapshot artifact has been
created without provoking host resource exhaustion. The regression must assert
that the original is already stopped, then verify that the completed snapshot
is uploaded and retained as a discoverable recovery point, or that an earlier
non-destructive design leaves an addressable original. Merely removing the stop
defer cannot satisfy that assertion; the follow-up below traces the destructive
rootfs export. The concrete factory (`pkg/sandbox/sandbox.go:1170-1179`) also
means a broad mock abstraction would not be a narrow test seam. This injection
tests error-path ownership, not whether a real hugepage or kernel allocation
failure has identical behavior.

Any source-built result remains a comparison against this captured source
tree. It does not identify the historical deployed binary: the active service
image digest has no OCI revision label, and source behavior cannot be inferred
from an image tag or this build command. The discriminating deployment evidence
remains an incident-linked binary build identity and effective runtime flags.

## Shutdown durability finding

The inspected `Server.Pause` calls `uploadSnapshotAsync` and returns before
remote upload completes (`sandboxes.go:962-1004`). The upload retry budget is
two hours (`sandboxes.go:59-65`), and a successful upload is logged by the
background task (`sandboxes.go:1590-1629`). `Server.Close` waits for its upload
wait group only until the shutdown context is canceled (`main.go:322-366`),
then logs that uploads remain in flight and returns. The pinned Compose file
gives the orchestrator 60 seconds to stop (`embed/compose/compose.yaml:274`).
The API's `pauseSandbox` marks the snapshot build successful after the node's
pause RPC returns (`pause_instance.go:61-78`), before the background upload has
necessarily completed. Thus SDK state `paused`, no Firecracker PID, and a
successful build status are each insufficient as a per-snapshot durable-upload
barrier. This is a source-specific contract and a concrete risk for the PoC's
old `shutdown.py` sequence; a failing historical D3 upload is not established.

## Follow-up: focused regression attempt (2026-09-23)

No source or test files were changed. Inspection shows the proposed boundary
cannot safely prove source preservation with the existing lightweight server
test fixture: `checkpointResumeFresh` depends on a concrete
`*sandbox.Factory`, a real `*Sandbox`, `templateCache`, storage-backed
`snapshotAndCacheSandbox`, and Firecracker-backed pause/resume behavior. The
existing duplicate-create test server has no template cache or persistence
(`pkg/server/create_duplicate_test.go:375-385`). Adding injectable interfaces
for the whole checkpoint path would exceed a narrow regression seam.

There is also a semantic gap in the earlier regression proposal: the fresh
path calls `SnapshotUseCasePause` with `maintainSandbox=false` from
`snapshotAndCacheSandbox` (`pkg/server/sandboxes.go:1309,
1477-1511`). `Sandbox.Pause` takes the destroy path: it pauses the guest,
records it stopped, and does not run the in-place resume path
(`pkg/sandbox/sandbox.go:2144-2150`, `2235-2240`). Therefore merely removing
the unconditional source stop defer would leave the old guest paused and
unroutable; safely restoring it needs a supported resume-and-reregister path
with snapshot resource ownership understood. I stopped without implementing
that behavioral change or a broad abstraction.

Focused test not run: this host has Go `go1.25.0 darwin/arm64`, while the
module/workspace require Go `1.26.8` and the candidate test file is Linux-only
(`pkg/server/create_duplicate_test.go:1`). `GOTOOLCHAIN=auto` is configured,
but fetching/building another toolchain was outside the bounded “without huge
downloads” condition. Exact source digest, computed as SHA-256 over the sorted
per-file SHA-256 manifest for all 2,568 files in the captured tree:
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.

Result: neither failing-before nor passing-after regression evidence exists.
The next discriminating step is a disposable Linux/arm64 fixture with Go
1.26.8 and a narrowly injected failure at `ResumeSandbox`, plus assertions
covering the actual paused-source recovery and re-registration path. That
fixture must first settle whether and how the captured snapshot permits safe
resumption of the original guest after the fresh allocation error.

## Independent D1 recovery design review

A separate source review traced rootfs export more deeply. On the fresh branch,
the NBD export path ejects the writable overlay cache and invokes
`closeSandbox`, waiting for device release (`pkg/sandbox/rootfs/nbd.go:84-120`);
the direct provider also stops the sandbox (`rootfs/direct.go:75-111`). The
destroy-path rootfs diff creator is passed `s.Close`
(`pkg/sandbox/sandbox.go:3267-3282`). Thus the original Firecracker process
can already be gone when `ResumeSandbox` allocates the replacement. This
supports the correction above: clearing a deferred stop or trying an in-place
resume after this point is not a valid repair.

The captured snapshot is added to the local template cache and an upload
object is registered (`sandboxes.go:1513-1544`), but upload is not run until
after replacement registration (`1396-1403`). A replacement allocation failure
can therefore strand a stopped original and a local-only snapshot while the
API marks its build failed and removes the sandbox record. The smallest
post-boundary recovery would upload and verify that build, retain its
discoverable snapshot/catalog relation, and expose an explicit stopped but
recoverable state and recovery ID. If upload fails, the state must say that
only a local artifact may remain; it cannot claim durable recovery. Reserving
replacement capacity before pause narrows one allocation failure but leaves
later registration and upload failures unresolved. A non-destructive capture
design may be required for a stronger no-loss guarantee.

This is a falsifiable source design, not an implemented fix or historical cause
classification. A Linux fixture must inject failure after snapshot/cache and
before `ResumeSandbox`, then verify source process exit, upload/catalog
promotion, and a later restore of both independent oracles. A separate upload
failure must refuse durable-success status. The captured tree still lacks a
verified correspondence to the deployed incident binary.

## Shutdown barrier design review

The node has a build-ID keyed upload future (`pkg/sandbox/build_upload.go:136-153`,
`pkg/sandbox/uploads.go:90-105`). Its async upload task completes the future
only after upload retries finish (`pkg/server/sandboxes.go:1590-1629`), but the
future is process-local and expires after three hours (`uploads.go:32-40,
70-83`). The pause response exposes scheduling metadata only
(`orchestrator.proto:214-216`); the SDK returns a boolean. API build `success`
is recorded when the pause RPC returns, before upload completion. No exposed
value is a restart-stable canonical-storage attestation.

A local verifier would need privileged, read-only access to the pause build ID
and to every canonical metadata, snapfile, header, body and referenced ancestor
object, with a trusted readback manifest. A header is insufficient: V3 uploads
headers alongside bodies (`pkg/sandbox/build_upload_v3.go:17-130`), while V4
data-before-header ordering still leaves metadata and snapfile uploads
concurrent (`build_upload_v4.go:81-139`). The smallest upstream seam to test is
an authenticated per-build completion operation that waits for upload and
performs canonical readback, or writes and verifies a completion manifest last.
A fake storage-provider test should hold one upload and readback pending while
the local cache remains populated, then prove that completion stays pending or
fails. The current source tree has neither this patch nor a running test, so
the PoC shutdown and host-restart probes remain fail closed.

A bounded implementation review stopped before modifying upstream source: no
single-blob or header-only fake-provider test would establish the required
barrier. `Upload.Run` fans out multiple object uploads concurrently, and the
existing process-local `Uploads.Wait` can resolve through local cache or a peer
(`pkg/sandbox/uploads.go:109-163`). `StorageProvider` exposes object opens but
no atomic multi-object receipt (`pkg/shared/pkg/storage/storage.go:75-85,
190-210`). The first honest source edit is a build-scoped expected-object
manifest populated from actual upload paths/checksums, finalized after every
upload completes, then verified through canonical-provider readback including
ancestors. A fake provider must hold one canonical object missing while cache
and peer paths are healthy. No such patch or Go test exists yet; the source
requires Linux Go 1.26.8, unavailable in this local macOS test environment.

## Later scratch-host build result

The owned Linux/ARM64 scratch VM subsequently built this captured tree with Go
1.26.8 in a bounded container. Three existing checkpoint admission, cleanup
and upload tracking tests passed. The resulting binary's module metadata
differs from the deployed release artifact at two dependency versions, so this
build does not establish the exact historical source. It also does not exercise
the after-capture failure or canonical readback barrier above. See the
[provenance audit](e2b-provenance-audit-2026-09-23.md) for hashes and limits.

The subsequent [post-capture D1 experiment](e2b-d1-post-capture-repro-2026-09-23.md)
injected one exact-ID return at the planned boundary. It observed a stopped,
unaddressable source, a failed API build, local-only artifact files, and SDK
restore rejection. It does not establish the real allocator errno or a fix.

The later [D2 rootfs sync experiment](e2b-d2-rootfs-sync-repro-2026-09-23.md)
used a separate disposable source copy and a one-shot exact-ID `EIO` return at
`LocalDiffFile.CloseToDiff`. Its unarmed pause/resume control passed. The
triggered pause stopped and unaddressed the source, failed its build, and left
neither checked build files nor an SDK recovery path. The hook substitutes the
sync error; it does not exercise an actual kernel writeback fault or prove the
historical EIO cause. The pinned orchestrator was restored afterward.
