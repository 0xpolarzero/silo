# D1 checkpoint: upstream report readiness

Date: 2026-09-23. Verdict: **historical D1 is unresolved; do not publish an
upstream bug report yet.** A controlled, SDK-only test demonstrates a damaging
post-capture failure mode in one captured-source build. It does not show that
the 2026-09-22 incident used that binary, took the fresh-resume branch, or
failed at the same boundary. The historical report of a fresh-resume allocation
failure is not an observed allocator syscall or errno.

## Evidence that supports the narrower claim

| Evidence | Observation | Limit |
| --- | --- | --- |
| [Local captured-tree audit](e2b-lifecycle-source-audit-2026-09-23.md) | `checkpointResumeFresh` arms old-sandbox stop before `snapshotAndCacheSandbox`; the latter calls `Pause` without `maintainSandbox`, and the rootfs export can already close the source. `ResumeSandbox` and then `runCheckpointUpload` occur later. | The captured tree has manifest SHA-256 `f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`; its directory name is a capture label, not verified Git provenance or incident source. |
| Local captured-tree `snapshot_template.go` traced in the [source audit](e2b-lifecycle-source-audit-2026-09-23.md) | On a generic checkpoint RPC error, `CreateSnapshotTemplate` fails the build and calls `RemoveSandbox(...Kill)`; documented healthy refusal codes have a distinct restore path. | The historical SDK request/handler, returned gRPC code and effective flags are not incident-linked. |
| [Controlled D1 receipt](e2b-d1-post-capture-repro-2026-09-23.md) | After node readiness, unarmed SDK checkpoint/restore passed. An exact-sandbox-ID error inserted after snapshot/cache produced a 500, no addressable source, no Firecracker process, a failed build, local files, no canonical build directory, and SDK restore 404. | The hook returned **before** template lookup and `ResumeSandbox`. It simulated a post-capture error, not allocation failure. One triggered run and one passing control do not establish a population failure rate. |
| [Provenance audit](e2b-provenance-audit-2026-09-23.md) | The current release binary has matching named checkpoint call targets, but the captured build resolves two different dependency versions. The binary exposes a short release label, not a verified full source revision. | Structural similarity is not an incident-time binary, branch, or causal trace. |

The controlled run was `a0fdce093ab641698707d9428ac7d531`, sandbox
`in1eqj08gbz6mz4ldz4ep`, build
`5936871a-ee75-46f2-9add-3ebb07f36b5a`. The SDK surfaced only
`500: Error creating snapshot template`; a saved redacted correlation receipt
links the exact node marker to the API error and failed build. The runner's
`failed-runner` label came from incorrectly expecting that private marker in
the SDK exception. Independent after-inspection and an explicit SDK restore
request establish the failure outcome. The local snapshot files were preserved
under the owned diagnostic host; their presence prevents any claim that all
bytes were erased. The injected return also skipped `runCheckpointUpload` and
left its process-local future unfinished. That side effect is specific to this
hook and cannot be assigned to the historical allocation failure.

The [public orchestrator source at the Compose acquisition revision](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/server/sandboxes.go)
and its [API handler](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/snapshot_template.go)
are primary-source starting points. Their URL revision alone does not certify
the captured tree or the deployed binary.

Historical D1 records only a checkpoint failure described as fresh-resume
allocation pressure, loss of access to its source runtime, and successful
restore of an *older* named checkpoint. The older checkpoint does not preserve
work acknowledged after it. The handoff correctly leaves the latest bytes and
incident cause unknown.

## Reproduction boundary and expected result

The smallest executed comparison used an isolated Linux/ARM64 diagnostic host,
Go 1.26.8, SDK 2.51.0, a one-CPU/512-MiB guest, and ample free hugepages. It
did not use Silo, LCU, credentials, or the historical VM. These commands
describe the existing diagnostic patch; they are **not a safe command to run on
an active host**. They require a fresh, owned deployment and source copy, and
the exact-ID trigger must be absent for the control:

```sh
# In a disposable copy of the captured public runtime tree:
patch -p1 --dry-run < /path/to/experiments/e2b-local/patches/d1-post-capture-exact-id.patch
patch -p1 < /path/to/experiments/e2b-local/patches/d1-post-capture-exact-id.patch
cd packages/orchestrator
GOWORK=off CGO_ENABLED=1 GOMAXPROCS=1 GOFLAGS=-p=1 \
  go build -mod=readonly -o /owned/scratch/orchestrator .
```

The disposable orchestrator must then be installed with
`SILO_D1_FAULT_AFTER_SNAPSHOT=1` and `SILO_D1_FAULT_TARGET_FILE` pointing to
an owned initially absent file. The controlled run used the pinned exact binary
hash `44b6aa54bd0d884db46151f3c2ce20e30e7e7b29e521691c4b4f27c1acc2e172`.

Run a direct SDK success control with the trigger file absent, then create a
fresh SDK sandbox and acknowledge two independent oracles: a live-process-only
nonce and a separately fsynced file hash. Write that sandbox's exact ID to the
owned trigger file and call `Sandbox.create_snapshot()` once. Verify the node
log's exact-ID marker, source PID/route, build status, local and canonical
artifact inventories, `Sandbox.get_info()`, and one explicit SDK restore from
the new snapshot ID. The saved diagnostic runner and receipts are under the
ignored `app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/`
directory; its host paths and expected binary hash are specific to that owned
deployment, so it is not a portable one-command repro. Do not replay its
service-switch script against another host.

**Expected preservation contract:** if the checkpoint fails, the original
sandbox remains usable with both acknowledged oracles, or a complete,
discoverable snapshot restores both oracles. **Actual in the one controlled
run:** source `get_info` returned `SandboxNotFoundException`; no run-tagged
candidate or Firecracker process remained; the new build was failed and SDK
restore returned 404. Only local snapshot material remained. This falsifies
that contract for the injected post-capture boundary on the tested candidate.
It does not establish the real allocator boundary or off-host durability.

## Regression and fix candidate

First make a failure-preservation regression at the **actual**
`ResumeSandbox` allocation call, with a one-shot exact-sandbox-ID fault that
returns the same typed failure as a real resource allocation rejection. Run it
on a disposable source build, after a passing unarmed control. Assert the
source process and routing state, build state, upload completion, canonical
object readback, discoverable recovery ID, and restoration of both oracles.
An API 500 plus local bytes fails. A 404 restore fails. An older checkpoint
fails. Include a second test where the upload itself fails; it must not report
durable recovery. This is an integration regression requiring real Firecracker,
storage, catalog, API, and SDK behavior. The existing lightweight Go server
fixture lacks a template cache and a concrete sandbox capable of this path;
mocking the whole factory would test the mock rather than preservation.

Candidate repair for the captured fresh path: after destructive capture, treat
the new build as an owned recovery artifact even if replacement allocation or
registration fails. Finish its upload, verify every canonical object and
ancestor required for restore, retain a discoverable build/template relation,
and expose an explicit stopped-but-recoverable result with its recovery ID.
If upload/readback fails, report that durability is unproven and preserve local
material for diagnosis. Merely removing the deferred stop is invalid: the
destroy-path rootfs export may already have closed Firecracker. A resource
preflight only narrows one trigger and cannot repair later registration or
upload failures. The stronger live-source guarantee needs a genuinely
non-destructive capture design and its own failure tests.

No source patch or regression was made here. The captured source differs from
the release binary, and an honest regression needs the full integration seam
and a bounded owned host. A local unit test with substituted interfaces would
not prove the required recovery contract. The [current public architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md)
describes in-place checkpointing as the current operation; it is not evidence
that this incident took that branch or that the historical release is fixed.

## Exact evidence required before an upstream report

1. A request-linked capture of the **incident-time** API and orchestrator
   binary hashes/image digests, release build records or exact source mapping,
   effective `use-sync-wp` and `in-place-checkpoint` flags, Firecracker version,
   sandbox/execution/lifecycle IDs, and the SDK route to the API handler.
2. The original failure's node/API log window with request and build IDs,
   exact gRPC code, allocator call and errno or resource-denial result, and
   source/replacement PID timeline. This must distinguish pre-admission
   refusal, snapshot failure, replacement allocation, registration, upload,
   and response failure.
3. An SDK-only reproduction on that exact release or a clearly labeled
   source-built candidate with a real allocation-boundary injection, an
   unarmed control, separate memory/file oracles, catalog/artifact inventory,
   and a supported restore attempt. Report the candidate as such if exact
   incident mapping remains unavailable.
4. A tested repair with the above failure-preservation regression, including
   failed upload and restore of the newly captured state. Verify fork and
   resume from the resulting artifact; do not accept a local header or an
   older checkpoint as a durability proof.

**Next action:** obtain the incident-linked binary/flag/log mapping before
assigning D1 to upstream or drafting a public issue.
