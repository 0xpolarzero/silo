# D2 upstream report readiness: rootfs sync EIO after source teardown

Date: 2026-09-23. Scope: read-only analysis of preserved D2 evidence, the
captured public E2B source, and the already completed source-built diagnostic.
No VM, service, artifact, or incident record was changed for this note. D1
checkpoint and D3 restore are separate failures.

## Decision

**Reproducible source-built SDK recovery failure: yes. Ready to label and
publish as an upstream bug: no. Historical release attribution: not proven.**
The [independent review](e2b-d2-independent-review-2026-09-23.md) found that
the injected error tests one Go branch, not a real failing sync operation or a
documented E2B promise to preserve an addressable source after a failed pause.
On the tested public-source candidate, a pause
that reports a rootfs sync error has already stopped the original guest. The
failed snapshot is not SDK recoverable, and the API removes the original
sandbox record. The trigger can be a storage error of unknown origin; the
destructive handling after that error is a separate, reproducible code-path
problem for a workload that expects a failed pause to preserve its last
acknowledged state. This is a scoped upstream report candidate, not a claim
that E2B caused the physical I/O error or that every failed pause loses bytes.

The public SDK describes `pause()` as pausing a sandbox and `connect()` as
resuming a running or paused sandbox. A failed pause followed by neither an
addressable original nor a usable new snapshot violates the preservation
invariant required by Silo. Upstream may have a different documented failure
contract; the report should ask maintainers to state it rather than assert an
undocumented guarantee. [Python SDK source](https://github.com/e2b-dev/E2B/blob/main/packages/python-sdk/e2b/sandbox_sync/main.py),
[runtime architecture](https://github.com/e2b-dev/runtime/blob/main/docs/ARCHITECTURE.md).

## Exact observations and boundaries

| Evidence | Observation | Limit |
| --- | --- | --- |
| Historical D2, sandbox `ihuji71ivqwchwhlzmd7s` | Pause RPC began 2026-09-22 16:53:30Z; Firecracker paused 16:53:32.341Z; full snapshot created 16:53:33.040Z; lifecycle stopped 16:53:33.141Z; rootfs diff sync reported `input/output error` at 16:53:37.555Z; gRPC Pause returned `Internal`. | Preserved orchestrator log, not a syscall trace. The original `/tmp` log and relevant kernel journal interval are unavailable. [Audit](e2b-d2-error-audit-2026-09-23.md). |
| Historical catalog and files | Snapshot `naa4djgwyr0zwl7ns8d2`, build `2d5669c0-ca9c-4815-bffb-0621fc738f59`, terminal `failed`; exact build diff and canonical template directory absent at later inspection. | Later absence does not prove bytes were erased at failure time or rule out another recovery copy. [Audit](e2b-d2-error-audit-2026-09-23.md). |
| Source-built control | SDK pause/resume on `d7af6d2e5a714287b88dba00ecda21ac` preserved both process nonce and fsynced file; a new write worked. | This is an unarmed control on the diagnostic VM. [Receipt](e2b-d2-rootfs-sync-repro-2026-09-23.md). |
| Source-built one-shot EIO, sandbox `iy5y0c74qsqjmi1l2pscb` | Rootfs sync hook fired once for the exact sandbox ID. Lifecycle stopped 12:05:35.907Z, synthetic EIO logged 12:05:37.939Z, Pause failed; failed build `d47bcdef-89a9-4839-8b87-a9d7c07cca07` remained. SDK get/list, exact `connect`, and create-from-failed-snapshot could not recover it; no matching Firecracker process remained. | The hook returned `PathError(EIO)` *instead of invoking* `File.Sync`; it proves propagation and cleanup, not a kernel writeback fault. The after-inspection file inventory was about two minutes later. [Receipt](e2b-d2-rootfs-sync-repro-2026-09-23.md), [patch](../../experiments/e2b-local/patches/d2-rootfs-sync-eio-exact-id.patch). |

The exact historical error chain was:

```text
error snapshotting sandbox: error while post processing:
synchronous rootfs export failed: failed to convert rootfs diff file to local diff:
failed to sync file: sync /orchestrator/build/2d5669c0-ca9c-4815-bffb-0621fc738f59-rootfs.ext4-ov20x5xsxt75ubtxkaxx: input/output error
```

This is evidence of Go `os.File.Sync` returning a `PathError` with EIO on that
path, not evidence of the particular Linux syscall, device, filesystem, disk
pressure, or writeback cause. Linux `fsync(2)` can report EIO for writeback
errors and distinguishes it from ENOSPC. [Go `File.Sync` contract](https://pkg.go.dev/os#File.Sync),
[Linux `fsync(2)` errors](https://man7.org/linux/man-pages/man2/fsync.2.html).

## Code path and teardown owner

The captured public tree at `a065a4ddb3f2c6a4149634d9acb14b62f65839ac`
shows four distinct actions:

1. API `removeSandboxFromNode` deletes the local route before the node Pause
   RPC; its outer `RemoveSandbox` defer removes the sandbox store record for a
   generic error. Only a special retryable refusal restoration can preserve
   that record. [API removal source](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/delete_instance.go).
2. Node `Server.Pause` marks the sandbox stopping and arms
   `defer stopSandboxAsync(...)` before snapshot/export. An export error returns
   `Internal` while the stop defer remains armed. [Node pause source](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/server/sandboxes.go).
3. The synchronous destroy-path `pauseProcessRootfs` supplies `s.Close` as
   `RootfsDiffCreator.closeHook`. Both direct and NBD provider export paths
   stop or close the sandbox and wait for the writable overlay to be released
   before exporting the diff. Only *after* export does
   `LocalDiffFile.CloseToDiff` call `File.Sync`. The original cannot simply be
   resumed after a sync error in this order. [Rootfs path](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/sandbox/sandbox.go),
   [NBD exporter](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/sandbox/rootfs/nbd.go),
   [direct exporter](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/sandbox/rootfs/direct.go).
4. On sync error `CloseToDiff` removes its partial cache file. The snapshot
   cleanup then runs; API marks the new build failed. These cleanups are
   sensible for preventing a corrupt snapshot from being presented as valid,
   but no discoverable recovery point is committed in the observed run.
   [Diff source](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/sandbox/build/local_diff.go),
   [API pause source](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/api/internal/orchestrator/pause_instance.go).

The source-built diagnostic ties these actions to a concrete outcome. The
historical deployed binary has matching named call targets for `Server.Pause`,
`pauseProcessRootfs`, `LocalDiffFile.CloseToDiff`, `os.File.Sync`, and
`os.Remove`, which supports structural similarity. It does not prove all
branch conditions, feature flags, or build provenance for the incident.
[Provenance audit](e2b-provenance-audit-2026-09-23.md).

## Deterministic next reproduction and preservation oracle

The existing [exact-ID hook](../../experiments/e2b-local/patches/d2-rootfs-sync-eio-exact-id.patch)
is the fast control for the Go error branch. The next discriminating test must
make the *actual `File.Sync` syscall boundary* return EIO and record its syscall
result. A small [Linux syscall probe](../../experiments/e2b-local/d2-report/run-sync-probe.sh)
is prepared as a one-command preflight. It makes an unarmed `File.Sync` control,
then launches the same Go helper under `strace -P <exact-target-path>
--inject=fsync:error=EIO:when=1`. A second file's sync must succeed in the
armed run. The probe keeps stdout, stderr and syscall traces in a private,
run-owned directory. It has **not been run**, because this checkout is macOS
and no diagnostic VM was operated for this analysis. The [strace manual](https://man7.org/linux/man-pages/man1/strace.1.html)
documents combining path filtering and injection, and its [internals](https://github.com/strace/strace/blob/master/doc/INTERNALS.md)
describe matching FD paths. The preflight must prove that the installed
Linux/ARM64 strace version actually targets Go's `fsync` on that file; otherwise
the proposed service-level injection is rejected.

Preparation checks on macOS: `sh -n` passed for the runner, `gofmt` produced
no further changes, and `GOOS=linux GOARCH=arm64 go build` succeeded for the
small probe. The Linux syscall/control assertions have not run.

For the lifecycle repro, launch only the disposable diagnostic orchestrator
under the tracer or attach to its verified PID. The build diff filename has a
[random suffix](https://github.com/e2b-dev/runtime/blob/a065a4ddb3f2c6a4149634d9acb14b62f65839ac/packages/orchestrator/pkg/sandbox/build/diff.go),
so a narrow pre-sync diagnostic gate must announce the exact
path/FD and wait for the tracer to attach before `CloseToDiff` calls
`File.Sync`; an occurrence count without that path match is insufficient.
Arm one exact sandbox ID, release the gate once, capture the strace line with
FD path and injected `EIO`, and verify the node `PathError` names the same
file. First run an unarmed SDK pause/resume control; after the armed run inspect
state before cleanup and automatically disarm the gate. This is a syscall
return fault, **not** a physical writeback failure: strace skips the actual
kernel sync and substitutes EIO. It establishes error handling after a real
Go-to-kernel syscall boundary. A separate bounded, test-controlled FUSE
filesystem can later return EIO from its `fsync` handler to test the kernel
filesystem path; confirm the exporter works on that filesystem unarmed first.
Neither experiment identifies the historical Mac/Linux storage cause. No
whole-host disk fill, process kill, global pause, or historical VM access is
part of this test.

The preservation oracle is stronger than “a previous checkpoint still
works.” Before pause, record a fresh process-only nonce, a newly written and
guest-fsynced file nonce, the guest acknowledgment times, sandbox execution
ID, source build lineage and exact artifact hashes/paths. After the fault and
before any test cleanup, capture process identity/state, route, API record,
build/snapshot rows, local rootfs/snapshot/cache objects, remote object
presence and hashes, and retention references. Attempt exact SDK `connect`
and create-from-failed-snapshot. A pass requires either the same original
guest restored with both nonces and a new write, or a separately discoverable,
verified recovery point containing the acknowledged filesystem nonce and,
for a memory-preserving pause, the process nonce. No claim of byte erasure is
made solely from SDK `NotFound` or an empty later directory. Run ENOSPC at the
same boundary and an upload failure as separate cases; their invariants and
timing differ.

## Fix candidate and evidence required to publish

One unvalidated design hypothesis is to **retain a recovery object before allowing the
last live source and its backing COW state to be discarded**. In the
synchronous destroy path, preserve the ejected writable cache and snapshot
inputs under a run/build-owned, restart-discoverable recovery record until
rootfs diff sync, metadata, and canonical artifact verification succeed; on
failure, expose a supported recovery path rather than a failed build with no
original record. API route/catalog removal must correspond to that outcome.
An NBD-specific option is to copy or seal the COW cache to independently
durable storage before `ejectAndStopSandbox`; the direct provider needs its
own verified retention point because it cannot export in place. A mere retry
of `fsync` after EIO, clearing the deferred stop, or retaining only a failed
database row cannot restore a source already closed. This is a fix candidate,
not an implemented or validated patch. A physical EIO may also prevent sealing
that cache; the actual-sync test must establish which objects can be durably
retained before treating this as a repair.

Before publishing an incident-attributed upstream issue, obtain the precise
release source/build mapping and the syscall-level reproduction above, plus a
before/after fix run with the preservation oracle and canonical artifact
readback. Current `.env` selects orchestrator
`v0.16.202609130627-59497eb9134`; the currently hashed orchestrator binary
is `e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`
and embeds linker commit `59497eb913`. The public source archive used for the
diagnostic requests two dependency versions that differ from the release
binary; the release suffix is not a public source commit proof. The public
`/commit/59497eb9134` URL returned 404 on 2026-09-23. E2B documents that
the public runtime is a Copybara mirror of its internal release monorepo and
does not host its release tags. Request the orchestrator and API build records
or source export corresponding to the exact artifact digests, and confirm
which incident-time binaries handled D2. [Release procedure](https://github.com/e2b-dev/runtime/blob/main/docs/RELEASING.md),
[provenance audit](e2b-provenance-audit-2026-09-23.md).

For a preliminary upstream issue that avoids historical attribution, use:

> **Expected:** If `pause()` returns an export error, the acknowledged
> pre-pause state remains reachable, or a supported, verified recovery point
> is exposed. **Actual in source-built diagnostic:** one exact-ID rootfs sync
> EIO after export stopped the guest; Pause returned 500, API and SDK no
> longer listed the sandbox, exact connect returned NotFound, and the failed
> snapshot ID returned 404. An unarmed pause/resume control passed. The
> injected EIO replaced Go `File.Sync`, so the physical EIO origin remains
> unknown. Reproducer patch, build/source hashes, timestamps, and redacted
> receipts are available; no customer data or VM artifact is attached.

One action: build the bounded actual-sync EIO test and preservation oracle on
an owned diagnostic deployment. If it reproduces the same SDK outcome and the
intended failure contract is established, submit the scoped source-built report
with historical release attribution explicitly unresolved.
