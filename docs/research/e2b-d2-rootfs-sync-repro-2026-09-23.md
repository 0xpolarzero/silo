# D2: source-built rootfs sync failure

Date: 2026-09-23. This is one controlled SDK-only comparison on the owned
`silo-e2b-diagnostic-d1` Linux/ARM64 VM. The historical `silo-e2b-poc` VM was
not changed. No SiloUI product code changed.

## Candidate and boundary

The [captured public source](e2b-provenance-audit-2026-09-23.md) has sorted
per-file manifest SHA-256
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.
The disposable D2 copy differs in five files: `sandbox.go`,
`build/local_diff.go`, its focused test, and one new hook plus its focused
test. Archive SHA-256 is
`5285ba3a569fc0b2b5ffe59fa3a07c25fda1199ce6391855486c7a2e1aa773d6`.
The [reproducible patch](../../experiments/e2b-local/patches/d2-rootfs-sync-eio-exact-id.patch)
is kept with the PoC.
The Linux Go 1.26.8 candidate binary SHA-256 is
`29470ef6d74a2b7055003442cbe347f573ae16ce32e947cfd090df8e5557d819`.
Two focused Go tests passed. The tested source and dependency set still
differs from the deployed release at two module versions; this is not an exact
historical binary.
The ignored focused-test and build logs have SHA-256 values
`019a9281c01af591d52919f12c14ff5f51a16eaa74c079c2dbea3297c343a4b7`
and `c84df58de105abce2d33f6e3c75d7fd5ddc65a36203b6790e38b14decfa63efa`.

The hook required a private trigger directory and a one-shot file naming one
exact sandbox ID. It fired only on the synchronous destroy-path rootfs export,
after the diff write and at `LocalDiffFile.CloseToDiff`'s sync boundary. The
candidate returned a synthetic `PathError` with `EIO` in place of calling
`File.Sync` for that one diff. This tests the Go error path and cleanup. It
does not produce a kernel writeback failure or determine the cause of the
historical EIO.

The fixture used SDK 2.51.0, the existing one-CPU/512-MiB Debian template,
and independent process-only nonce and fsynced-file oracles. It used no Silo
adapter, desktop, browser, credential broker, or LCU. The original pinned
orchestrator was backed up and restored afterward; SHA-256
`e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`.

## Control and fault result

The first unarmed control request, `3d0eac7eb817467aa5c0e4a0bac43fdd`,
received 503 before guest creation while API placement readiness lagged
Docker health. The next unarmed pause/resume control,
`d7af6d2e5a714287b88dba00ecda21ac`, passed: both oracles survived and a
new write succeeded. Its exact run-owned guest was retired after saving the
report.

The armed run `5ca23681b9ae451da8c713b8e5ea9837` created sandbox
`iy5y0c74qsqjmi1l2pscb`. Its oracles were acknowledged immediately before
the exact-ID trigger was written. The trigger was consumed once. The
orchestrator logged lifecycle stop at 12:05:35.907Z, then the rootfs sync EIO
at 12:05:37.939Z. The pause RPC returned `Internal` with the same sync error;
the SDK exposed only `500: Error pausing sandbox`. The catalog has snapshot
row `2f097f02-c9b8-4ebd-b397-853c34529a8d` and failed build
`d47bcdef-89a9-4839-8b87-a9d7c07cca07`. The build reason contains the sync
error and EIO. The [ignored after-inspection receipt](../../app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/d2-source-fault/5ca23681b9ae451da8c713b8e5ea9837-after.json)
records exact log-line numbers, timestamps, SHA-256 values, catalog rows,
process state and file inventory.

SDK `get_info` and run-tagged list found no original sandbox, and no matching
Firecracker process remained. At 12:07:58.842Z, about two minutes after the
error, the checked local build, local template and canonical template paths
contained no files for the failed build. One exact
SDK `Sandbox.connect` returned `SandboxNotFoundException`; creating from the
failed snapshot ID `1a1r05qb5e6nj6i70071:default` returned 404. The
[ignored SDK receipt](../../app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/d2-source-fault/5ca23681b9ae451da8c713b8e5ea9837-sdk-recovery.json)
records both responses. These tested SDK paths could not recover the original
or the failed snapshot. The file inventory was taken after the error;
it does not establish that no other copy of the bytes exists.

The exact 13-second API and orchestrator log windows remain root-only inside
the diagnostic VM at `/var/lib/e2b/verification/d2-source-fault/`. Their
SHA-256 values are
`11cd6de3368b5f8e19e5c9a0a7183bbec73ac6bf8e9a8d9aa32f07397d5e3d70`
and `0335c2b552cab40db51d5bcea65c3e09d6d308316689c6e16309151ff3006503`.
Raw logs are not tracked or published. After the check, the pinned
orchestrator was restored healthy and the SDK inventory was empty.

## Limit and next proof

This one synthetic boundary failure reproduces the historical *shape* of D2:
source stop before rootfs sync EIO, failed build, API removal and SDK recovery
rejection. It does not prove the historical storage/host cause, exact deployed
source identity, or an upstream repair. The targeted hook also substitutes an
error for the sync call, so it cannot establish physical writeback behavior.
No before/after fix series exists. D2's historical cause and full
qualification gate remain **unresolved / blocked**.

The next upstream change must keep a usable original or an independently
verified recovery point through rootfs export failure. A subsequent regression
must fault the real storage/writeback layer at this sync boundary and separately
test space exhaustion and upload failure. Each case needs process-memory,
fsynced-file and new-write checks, exact catalog/routing state, and canonical
artifact readback before a lifecycle guarantee is claimed.
