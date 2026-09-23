# D1 disposable ResumeSandbox-boundary fault

Date: 2026-09-23. This is an **unexecuted diagnostic patch**, not an upstream
repair or evidence about the deployed D1 release. The patch is
[`d1-resume-allocation-exact-id.patch`](../../experiments/e2b-local/patches/d1-resume-allocation-exact-id.patch),
SHA-256 `f068209f3ce5d901603074050ed9c51d2f285f1670d7534f508a212254ccf21f`.
It applies only to a disposable copy of the captured public tree whose sorted
per-file manifest SHA-256 is
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.
The captured tree is not mapped to the historical binary; see the
[release-source audit](e2b-release-source-mapping-2026-09-23.md).

## Exact seam and effect

`packages/orchestrator/pkg/server/sandboxes.go`, in
`checkpointResumeFresh`, calls `snapshotAndCacheSandbox` with
`maintainSandbox=false` at baseline line 1309, gets the resulting template at
1316–1323, then calls `s.sandboxFactory.ResumeSandbox` at 1329. The patch
checks an exact sandbox ID **after template lookup and immediately instead of
that call**. When armed, it supplies one synthetic error to the existing
`if err != nil` branch without changing its telemetry, gRPC `Internal` return,
API build failure, or old-source cleanup. This is closer to an immediate
`ResumeSandbox` return error than the earlier
[post-capture hook](e2b-d1-post-capture-repro-2026-09-23.md), which returned
before template lookup and skipped the common resume-error branch.

It does **not** call `ResumeSandbox` on the armed request, allocate memory,
exercise a hugepage/memfd/cgroup/Firecracker failure, or test the factory's
partial-allocation cleanup. Its error text is a diagnostic marker, not an
observed `ENOMEM`. A real factory error can occur after resources have been
created; a result from this patch cannot be generalized to those stages.

The one-shot trigger uses `SILO_D1_RESUME_FAULT_DIR`, a mode-0700 directory
owned by the orchestrator's effective UID. An owned mode-0600 regular file
`<sandbox-id>.trigger` must contain exactly `<sandbox-id>\n`. A successful
rename to `.fired` consumes it before the error. With no env variable, file,
or exact content, the source path is unchanged. Do not combine this patch
with the older D1 post-capture patch or the D2 patch.

## Reproduce on a new owned SDK-only fixture

The commands below are for a disposable Linux/ARM64 source copy with Go
1.26.8 and an independently owned E2B deployment. No command in this section
was run against a VM for this note. Start from the captured tree, not the
diagnostic copy that already contains another fault patch:

```sh
cd /owned/disposable/runtime-copy
patch -p1 --dry-run < /absolute/path/to/experiments/e2b-local/patches/d1-resume-allocation-exact-id.patch
patch -p1 < /absolute/path/to/experiments/e2b-local/patches/d1-resume-allocation-exact-id.patch
cd packages/orchestrator
GOWORK=off CGO_ENABLED=1 go test -mod=readonly ./pkg/server -run '^TestD1ResumeAllocationFaultTargetsOneSandboxOnce$' -count=1
GOWORK=off CGO_ENABLED=1 GOMAXPROCS=1 GOFLAGS=-p=1 go build -mod=readonly -o /owned/disposable/orchestrator .
```

Record the built binary SHA-256 and install it only in that owned deployment.
Start the orchestrator with
`SILO_D1_RESUME_FAULT_DIR=/owned/private/d1-resume-fault`, where the directory
is empty, owned by its effective UID, and mode 0700. Verify the node is
placement-ready **through the API** after restart; an earlier control got 503
while Docker health was already green. Record the active binary hash, image
digests, effective checkpoint flags, Firecracker version, template and run ID.

Use SDK 2.51.0 directly, without Silo or the PoC adapter:

1. With no `.trigger` file, create one small sandbox and run
   `Sandbox.create_snapshot()`; restore that new snapshot through the SDK.
   Compare a process-only nonce, a separately guest-fsynced file hash, and a
   new write. Retire only that exact control sandbox after saving results.
2. Create a fresh sandbox with a new run ID in metadata. Acknowledge the same
   two independent oracles and save its sandbox ID, execution ID, lifecycle
   ID, source Firecracker PID, and guest file hash. While it remains running,
   atomically write **only its exact ID plus newline** to
   `/owned/private/d1-resume-fault/<sandbox-id>.trigger`, mode 0600, then fsync
   the file and directory. Do not arm the control or another sandbox.
3. Call `sandbox.create_snapshot()` exactly once. Expect an SDK error (the API
   may hide the node marker). Correlate one `.fired` file, one node log marker
   `injected D1 replacement allocation failure for sandbox '<id>'`, the
   build ID, and the API failure. If no `.fired` marker appears, the fault did
   not run and the outcome is not a valid test.
4. Before cleanup, record source/replacement Firecracker PIDs, SDK `get_info`
   and run-tagged list, API route/store row, node lifecycle map, build and
   snapshot status, upload future, local cache files, canonical objects and
   hashes. Attempt exactly one SDK restore from the **new** snapshot ID; if it
   succeeds, verify both oracles and a new write. Preserve the raw error and
   artifact manifest before any service restart or retirement.

**Preservation oracle:** after a failed checkpoint, the original is usable
with both oracles, or the newly captured state is complete, discoverable and
restorable with both oracles. A failed build, local-only bytes, or an older
checkpoint does not pass. The expected result from the *captured source
control flow* is source teardown and a generic API failure; the SDK and
artifact outcome of this new hook has **not** been measured. The earlier
post-capture run is comparison evidence, not a substitute for this test.

## Verification completed without a VM

`patch -p1 --dry-run` passed against the untouched captured tree for all
three patch paths. `gofmt` formatted the modified files in an isolated
temporary copy. A host-side Go 1.25 test of the standalone trigger function,
with only its Linux build tag removed in a temporary copy, passed the
exact-ID/one-shot assertions. This is a trigger-safety check, not the required
Linux Go 1.26.8 package test or a failure-preservation regression. The full
server test and source build were not run; this Mac host has Go 1.25, and no
VM/service lease was used.

A narrow Go test that claims to model **real** placement failure is not
available at this seam: `ResumeSandbox` takes a concrete `*sandbox.Factory`
and builds network, memory, rootfs, cgroup and Firecracker resources. A mock
return at the call site would simply restate this hook. The first honest
preservation regression is the SDK integration case above, followed by a
separate fault in the exact resource allocation operation once an incident
errno and source mapping identify it.

**Next action:** run the unarmed control and exact-ID SDK case on one new owned
deployment, preserving pre-cleanup source/artifact state before interpreting
the outcome.
