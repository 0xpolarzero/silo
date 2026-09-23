# D1: source-built post-capture checkpoint failure

Date: 2026-09-23. This is one controlled comparison on the owned
`silo-e2b-diagnostic-d1` Linux/ARM64 VM, not a reproduction on the exact
historical release. The historical `silo-e2b-poc` VM was not changed.

## Candidate and test boundary

The public captured source tree has sorted per-file manifest SHA-256
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.
A disposable copy added an exact-ID diagnostic return after
`snapshotAndCacheSandbox` succeeded and before template lookup or
`ResumeSandbox` in `checkpointResumeFresh`. The patch archive SHA-256 was
`a23c5b9019c1685a5f7b46462db6ac8b249025cd6605c0dd5ecad83f9be04e3e`;
the [reproducible patch](../../experiments/e2b-local/patches/d1-post-capture-exact-id.patch)
is kept with the PoC;
the bounded Go 1.26.8 build produced binary SHA-256
`44b6aa54bd0d884db46151f3c2ce20e30e7e7b29e521691c4b4f27c1acc2e172`.
The hook required both a startup diagnostic flag and a host file containing
the exact sandbox ID. That file was absent during the success control and was
written only after creating the failure fixture. The pinned orchestrator
binary, SHA-256
`e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`,
was backed up, then restored after the test; the diagnostic service is healthy
with no trigger or test environment values. The earlier
[provenance comparison](e2b-provenance-audit-2026-09-23.md) showed two module
version differences between the captured source build and deployed release.

The host was Ubuntu 26.04 ARM64 under an M4 Max Lima VM, boot ID
`c5104256-5bc7-4128-9c0f-22b4c2c4bddf`, kernel
`7.0.0-28-generic`, with SDK 2.51.0 and a Debian SDK-only template using one
CPU and 512 MiB RAM. The failure fixture began with 4,096 free 2 MiB
hugepages and 64 GiB guest filesystem space. It used no Silo adapter, browser,
credential broker, desktop template, or LCU.

## Control and observed failure

The first control request, `c2f615ad154a440984f8622ab092a10f`, returned
503 before guest creation. API logs showed zero ready nodes at that request
and a ready local node about 28 seconds later. Docker health alone therefore
did not establish placement readiness immediately after orchestrator restart.
This control is a failed readiness case, not a D1 checkpoint outcome.

Once the API reported the node ready, SDK checkpoint and restore run
`280a431d020147a790a4abf3146ebd67` passed with the trigger absent. Its
source and restored guests returned the process-only nonce and fsynced file
hash, then accepted a new write. Both guests were retired by exact run ID after
the passing report was saved.

The one injected failure run was `a0fdce093ab641698707d9428ac7d531`,
sandbox `in1eqj08gbz6mz4ldz4ep`. At 13:31:38+02:00, the SDK fixture
acknowledged a random value held only by a live process and a separate fsynced
file hash, then wrote that exact sandbox ID to the trigger. The orchestrator
log shows Firecracker returned 204 for `/snapshot/create`; the rootfs overlay
was released and the sandbox lifecycle stopped. The checkpoint RPC then
returned `Internal` with the injected post-capture marker. The API logged its
subsequent kill/removal, marked build
`5936871a-ee75-46f2-9add-3ebb07f36b5a` failed, and returned 500. The SDK
exposed only `500: Error creating snapshot template`, so the first runner
reported `failed-runner` when it expected the internal marker in the SDK
exception. The saved [redacted correlation receipt](../../app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/d1-source-fault/a0fdce093ab641698707d9428ac7d531-correlation.json)
ties this run and sandbox ID to the exact marker in one orchestrator log line
at 11:31:38.139Z and one API log line at 11:31:38.147Z. It also records the
failed build ID and confirms that its catalog reason contains that marker and
sandbox ID. The API response followed at 11:31:38.149Z. The receipt gives
line numbers and SHA-256 hashes for matching private log lines, without
publishing the raw logs. This is a runner assertion error, not an extra
checkpoint failure.

Selected fields from that receipt, with other log fields omitted:

| Source | UTC | Exact-ID finding | Saved line SHA-256 |
| --- | --- | --- | --- |
| Orchestrator line 142 | 11:31:38.139 | `Internal`; `injected D1 failure after snapshot/cache for sandbox 'in1eqj08gbz6mz4ldz4ep'` | `0ca9329f82b0eb0d7b5c2e5b45e78261af524a35f81d5a1b4eb4791650893744` |
| API line 9 | 11:31:38.147 | Same exact marker and sandbox ID; `Internal` | `01bce38fa8cfc7dda954a90c7f4dbe7debe141fe5114de8d755a92239573e5e0` |
| Catalog build row | Checked after operation | Build `5936871a-ee75-46f2-9add-3ebb07f36b5a` is `failed`; reason contains the exact marker and sandbox ID | Read-only SQL result in receipt |

Passive SDK `get_info` returned `SandboxNotFoundException`, run-tagged list
lookup returned no candidates, and no Firecracker process remained. The
catalog still held snapshot row
`18d0a545-e74c-42bf-aad6-e8750f5c4149`, template ID
`isod1l9pjlbj9q1cuhje`, and the failed build/assignment rows. No canonical
directory existed for that build. Four local files remained: 493-byte metadata,
7,448-byte snapfile, 167,772,160-byte memory body, and 147,456-byte rootfs
diff. They were hashed individually and preserved in a root-only archive inside
the diagnostic VM. The archive is 167,936,000 bytes, SHA-256
`e8cabb5f04d67ddce13e0c24c54fb11f961160063761b869efca5eabb939a3eb`.
This archive contains synthetic guest state and is not an off-host backup.

One explicit SDK restore from `isod1l9pjlbj9q1cuhje:default` returned
`404: template 'isod1l9pjlbj9q1cuhje' not found`. Thus the tested SDK path
could not use the failed checkpoint, although local bytes existed. This does
not prove those bytes were erased or that no forensic recovery is possible.

## Evidence and limit

The ignored
`app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/d1-source-fault/`
directory contains the original SDK report, passive after-inspection hashes,
archive receipt, and SDK restore response. The root-only archive and exact
15-second API/orchestrator log window remain inside the owned diagnostic VM at
`/var/lib/e2b/verification/d1-source-fault/`; log SHA-256 values are
`e5332a70f77349adb4b36419c73fc4c30b8f6ff77c6bf3da5702e776fdb485ca`
(API) and `5592140515b23a9085c4c37b6d4c488f3cd2f28699a4a0be9c19e4d5eb1d62ca`
(orchestrator). Raw logs and guest state are not tracked or published.

The injected return has its own side effect: `snapshotAndCacheSandbox`
registers an upload future before the hook fires, and the hook bypasses
`runCheckpointUpload`, the path that normally completes that future. The
future therefore remained unfinished in the temporary diagnostic
orchestrator process until that process was replaced with the pinned binary.
The source also conditionally registers a Redis peer route at this point;
the exact build's peer key was absent at the later read-only check, after the
orchestrator restart. That later check cannot establish whether a route was
ever advertised during the run. This side effect belongs to the injected
post-capture path and must not be assumed for the historical allocation
failure. It does not change the observed SDK and catalog results for this run.

The experiment proves one post-capture error on **this source-built candidate**
stops and unaddresses the original while leaving only local, undiscoverable
checkpoint material. It does not prove the original 2026-09-22 error was this
boundary, that its allocator failed, or that the captured source matches its
deployed binary. The hook ran before the real allocator, so it does not cover
partial allocation cleanup. There is one triggered failure and one passing
checkpoint control after readiness; no causal fix or after-fix series exists.
D1's historical classification and full qualification verdict remain
**unresolved / blocked**.

The next source change must preserve a usable original until replacement is
ready, or publish and verify the captured build as a discoverable recovery
point before reporting failure. Because the original is destroyed during
rootfs export in this fresh branch, simply removing its deferred stop is
insufficient. A local-only artifact must be reported as local-only; upload and
canonical readback failures require separate regressions. The controlled
after-capture case, a real replacement-allocation failure, and an upload
failure must then pass process-memory, fsynced-file, and new-write checks on
fresh fixtures before an upstream report or Silo cutover claim.
