# Canonical snapshot readback: passing SDK control

Date: 2026-09-23. Scope: a read-only file inventory in the owned
`silo-e2b-diagnostic-d1` VM after a successful SDK pause/resume control. The
historical `silo-e2b-poc` VM was not changed. No SiloUI product code changed.

## Exact control and result

The unarmed source-built D2 pause/resume control
`d7af6d2e5a714287b88dba00ecda21ac` passed its process-only nonce,
fsynced-file, and new-write oracles. Its sandbox was
`ior8h61cgdt1cbn731wrl`; catalog inspection linked its successful snapshot
template `quxmcqenpu269pg038qy` to canonical build
`f5664a02-f7aa-4960-928f-3890ad4a3cb9`. The guest was retired by exact
run ownership after its report was saved. A read-only SELECT joined the exact
`snapshots.sandbox_id` through `env_build_assignments` to `env_builds`; its one
selected row reported build status `success` and finish time
`2026-09-23 12:04:49.620077+00`. The selected ID/status fields are saved in
ignored `evidence/sdk-lifecycle/canonical-catalog-f5664a02-f7aa-4960-928f-3890ad4a3cb9.tsv`
under the diagnostic deployment, SHA-256
`49a70c9509299e678401cfb230aa625af2bea9fa930bc9b84248312f26d5450f`.
Catalog success does not establish upload completion.

The read-only verifier ran in the scratch VM against
`/var/lib/e2b/storage/templates/` for that exact build. It followed the
memory and rootfs header references through **7 V3 builds**, opened and
SHA-256-hashed **42 required canonical objects**, and read **1,570,630,655
bytes** without a missing object or parse error. Each build had metadata,
snapfile, memory and rootfs headers, and both body files. The complete private
JSON manifest has SHA-256
`f467437439aa1e13ea18c1ba217bf8e9108d0606251743bb6563f6edc0518ccf`
at ignored path
`app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/sdk-lifecycle/canonical-readback-f5664a02-f7aa-4960-928f-3890ad4a3cb9.json`.
The same manifest is preserved in the scratch VM under
`/opt/silo-e2b-poc/evidence/sdk-lifecycle/`.

The command used the tracked
[`verify-canonical-snapshot.py`](../../experiments/e2b-local/verify-canonical-snapshot.py)
and [`inspect-snapshot-header.py`](../../experiments/e2b-local/inspect-snapshot-header.py)
copied into `/tmp` in the scratch VM:

```sh
sudo timeout 180 python3 /tmp/verify-canonical-snapshot.py \
  --storage-root /var/lib/e2b/storage \
  --build-id f5664a02-f7aa-4960-928f-3890ad4a3cb9
```

At execution, the verifier and parser SHA-256 values were respectively
`28ff0a766dfe9a69c82bb4c7a4029538df836f7b02fc59527203c4884f3efde1`
and `3973a42c9216710c116adc31fa384accebf8cb0a9b06e0013dfed37f43c23b67`.
The tracked verifier subsequently gained only a comment explaining the sparse
sidecar bound; its runtime logic is unchanged.

The verifier reads the transitive memory/rootfs build closure, checks
metadata and header IDs and formats, rejects a pending-upload header, opens
regular files without following symbolic links, and detects a file changing
during its read. It emits file lengths and hashes, not guest memory or disk
contents. V4/V5 compressed bodies require a size sidecar. The captured public
source writes that sidecar from the source file size in
`packages/shared/pkg/storage/storage_fs.go`; it can exceed the header's
build byte count for sparse frame data in
`packages/orchestrator/pkg/sandbox/build_upload_v4.go`.

## Interpretation and next gate

This result establishes that all files required by the inspected V3 header
graph were readable **at the time of inspection**. The hashes have no
independent expected pre-pause values. The test did not stop the host, remove
local caches, restore this build from canonical storage, validate the saved
Firecracker device state, or prove that upload completed before a shutdown.
The public source used by the verifier has not been matched to the deployed
release. The historical D3 failed build is a different snapshot and remains
unexplained.

The PoC's host-stop and SDK restart probes therefore remain blocked before
pause or shutdown. The next required experiment is a per-snapshot upload
completion signal tied to the exact build, followed by the controlled
same-snapshot restart/cache matrix and independent restore oracles.
