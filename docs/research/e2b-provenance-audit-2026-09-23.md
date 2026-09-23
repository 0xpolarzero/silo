# E2B provenance and incident evidence audit

Date: 2026-09-23  
Scope: read-only P0 inventory. No SDK connection, VM/container/service operation,
guest inspection, state mutation, or runtime lease was used in the initial audit.
The orchestrator later supplied a separate read-only inventory from the owned
running VM, labeled below.

## Result

P0 provenance remains **blocked / incomplete**: this checkout preserves a
reviewable set of historical evidence files and verified static inputs, but it
does not prove the exact API/orchestrator/Firecracker/envd images or template
artifacts that served the 2026-09-22 incidents. D1, D2 and D3 attribution stays
**unresolved** on this evidence alone.

The raw inventory is
`app/SiloUI/src-tauri/target/verification/e2b-local/2026-09-23-provenance/raw-file-manifest.tsv`.
It records SHA-256, byte size and UTC mtime for 100 root-level logs/configs,
files in the `evidence/` directory, and selected acquisition/pin files. It stores
no file copies or contents. The directory is under ignored Cargo target output.

## Commands and actions

Read the complete `AGENTS.md` and `docs/SiloUI-E2B-QUALIFICATION-HANDOFF.md`.
Inventory used:

```sh
rg --files -uu app/SiloUI/src-tauri/target/verification/e2b-local
find app/SiloUI/src-tauri/target/verification/e2b-local -maxdepth 2 -type f -print
shasum -a 256 experiments/e2b-local/poc.py \
  experiments/e2b-local/qualification.py \
  app/SiloUI/src-tauri/target/verification/e2b-local/upstream/runtime/embed/compose/.env \
  app/SiloUI/src-tauri/target/verification/e2b-local/upstream/runtime/embed/compose/compose.yaml \
  app/SiloUI/src-tauri/target/verification/e2b-local/downloads/runtime.tar.gz \
  app/SiloUI/src-tauri/target/verification/e2b-local/downloads/SHA256SUMS
```

The checksum command confirmed the two Compose inputs match `poc.py`'s expected
hashes. No container registry or default Docker daemon was queried. No log or
JSON payload was opened during this inventory. The local `ls` confirmed the
historical Lima home path exists, but no contents were enumerated or read. The
host-side `/tmp/silo-pause-failure.log` check was negative; the handoff says the
original was inside Linux, which was deliberately not accessed. Thus the
guest-side copy is **not checked**, not proven absent.

## Verified static input facts

These are facts about files currently present, not proof of incident-time
deployment:

| Item | Recorded value | Evidence |
| --- | --- | --- |
| Compose acquisition revision in `poc.py` | `a065a4ddb3f2c6a4149634d9acb14b62f65839ac` | `experiments/e2b-local/poc.py` |
| Compose `.env` API / DB migrator | `v0.14.202609170000-908833e4c12` | `.../upstream/runtime/embed/compose/.env` |
| Compose `.env` orchestrator / envd | `v0.16.202609130627-59497eb9134` / `v0.9.202609130627-59497eb9134` | same |
| Compose `.env` Firecracker / guest kernel | `v1.14-0.2.0` / `vmlinux-6.1.177_5008931` | same |
| Compose `.env` `RUNTIME_COMMIT` | `7278c2a380767c9989da73cf4c04b1af1b32da18` | same |
| Expected and actual `compose.yaml` SHA-256 | `0ef4902dc0d8e9aa1f16603d2201ddeab3e21456e2d2c50a6663388788b66666` | `poc.py`; local file |
| Expected and actual `.env` SHA-256 | `58f80d93bc155b8ace1ce196eb6f633bb78527cd033b9c7e0a3c849c6b0d0ba6` | `poc.py`; local file |
| Acquired `runtime.tar.gz` SHA-256 | `c537dff6c91db86ec721e327586875d59fa02aadd4f7bd434946a1afc70dd142` | local acquired archive |
| Lima image checksum pin | `7bcf159e29ad0000bfed9c57875908c39268f5ed1257f4958fa6a9f5f60edd54` | `poc.py`; matching checksum lines in `lima-start*.log` |

The distinct source/release suffixes are not themselves evidence of an invalid
release combination. `RUNTIME_COMMIT` is an explicit static selection and is
not equivalent to the Compose file's acquisition revision. The archive hash
identifies only the local archive bytes; without authenticated acquisition or
build records it does not map the running images back to source.

The visible Compose pins are tags, not registry digests. A bounded metadata scan
of preserved root-level logs found no `RepoDigest` or `Image ID` record for the
runtime service images. It found the Ubuntu disk image checksum in the Lima
startup logs only. This does not rule out a separate uncollected deployment
record.

## Preserved evidence inventory

The `evidence/` directory contains historical acceptance and qualification
records, failed-run JSON, `durability.json`, named-checkpoint recovery,
host-restart records, cache-reclamation and disk-recovery records, resource and
template JSON, credential records, and native editor/viewer records. Root-level
logs include `deploy.log`, `qualification*.log`, `acceptance-*.log`,
`lcu-host-stop.log`, `lcu-host-restart.log`, `host-restart*.log`,
`source-checkpoint-recovery.log`, storage/build logs, and credential run logs.
Exact per-file hashes and mtimes are in the private manifest above.

The handoff explicitly classifies `evidence/durability.json` as manually
assembled, not as three independent failure tests, and the `qualification.py
resume` history as accumulated groups from changing runs/environments. Treat
each file as a historical observation until its raw assertion inputs, run ID,
source/runtime manifest and timeline are matched. Do not combine old green
groups into a fresh integrated verdict.

## Evidence vs. inference

**Established from this read-only inventory:**

- The static PoC pins and local Compose files are present and their expected
  Compose hashes match.
- Static release tags, source commit selectors and historical report/log files
  are present as listed above.
- The host-side pause-error path checked is absent. The Linux guest path was not
  accessed.
- No per-image registry digest/build attestation was found in the preserved
  top-level logs through the metadata-only scan.

**Not established:**

- Which image digests, binary build IDs, feature-flag values or template digest
  were active during any D1–D3 request.
- Whether the Compose stack was recreated after the checked-in pins changed, or
  whether running containers matched the current `.env` tags.
- Whether the guest still contains the original pause log, failed snapshot
  graph, cache manifests, failed build IDs or cleanup records.
- Whether the historical instance is currently running, paused, unaddressable,
  or removed. This audit did not query the Lima manager or guest.
- Whether a failed snapshot's referenced bytes remain recoverable. No VM data
  or snapshot bytes were copied or read.

## Missing provenance and next discriminating step

P0 needs a read-only capture from the already-owned deployment, under the
orchestrator's explicit runtime lease: container image IDs and registry digests;
binary checksums/build info; resolved Compose config with secret values
redacted; runtime/template IDs and full parent lineage; deployment timestamps;
selected feature flags; and the association between those artifacts and each
incident request/process. First verify ownership and current state without
resuming anything. Preserve and hash any available incident files before a
separate scratch deployment is used.

If the exact deployed source cannot be recovered, source-build a named revision
and compare the lifecycle failure there. That can establish behavior for the
source-built candidate, but it cannot retroactively establish what ran during
the historical incidents.

Do not call `poc.py test`, `reset-failed-test.py`, `reclaim-cache.py`, global
pause, prune, snapshot deletion, `Sandbox.connect`, or any VM/service lifecycle
command as part of this audit.

## Appendix: Embed artifact paths and checksum model

Static path mapping from the inspected source:

| Artifact | Linux execution-host path | Additional guest path |
| --- | --- | --- |
| Orchestrator | `/var/lib/e2b/bin/orchestrator` | None; runs on execution host |
| Promoted envd binary | `/fc-envd/envd` | `/usr/bin/envd` inside each sandbox rootfs, started by its systemd unit (`ExecStart=/usr/bin/envd`) |
| Firecracker | `/fc-versions/<E2B_FIRECRACKER_VERSION>/<arch>/firecracker` | None; runs on execution host |
| Guest kernel | `/fc-kernels/<E2B_KERNEL_VERSION>/<arch>/vmlinux.bin` | Loaded by Firecracker; not a normal guest file |

`fetch-artifacts.sh:128-132` writes these paths under `HOST_ROOT`, which Compose
mounts as the Linux host root (`compose.yaml:171-187`). The orchestrator launch
script executes `/var/lib/e2b/bin/orchestrator` (`orchestrator-launch.sh:38-40`).
The orchestrator's `FIRECRACKER_VERSIONS_DIR`, `HOST_KERNELS_DIR`, and
`HOST_ENVD_PATH` agree with those locations (`compose.yaml:247-258`). The
guest-side envd path is separately defined as `/usr/bin/envd` in
`packages/orchestrator/pkg/sandbox/rootfs/envd_swap_linux.go:60-61`, and its
service executes that path in
`packages/orchestrator/pkg/template/build/core/rootfs/files/envd.service.tpl:51-53`.

`fetch-artifacts.sh:22-40,42-52,64-109` verifies SHA-256 before replacing a
downloaded binary. Checksums come either from rows compiled into the tools
image or a `$BUCKET/<artifact-key>.sha256` sidecar. The script says release
sidecars are published create-only and used for versions not embedded in the
table. In this inspected snapshot, the selected envd version has a pinned
row for amd64, but the selected arm64 envd uses a release sidecar. Selected
Firecracker and kernel versions have pinned rows for amd64 and arm64, while the
selected orchestrator release also uses a sidecar.
These are download-time integrity checks; they do not prove which artifact was
actually installed at incident time or map an artifact to an exact source tree.
The `.env` Docker image tags also lack registry digest pins here. A tag alone
does not identify immutable bytes or a Git source revision; capture the
resolved registry digest and build provenance separately.

Safe read-only hash commands for an orchestrator to run **only after validating
the owned execution-host identity and while it is already available**:

```sh
# Run on the Linux execution host (the Lima guest), not on the Mac host.
set -eu
arch="$(uname -m)"
case "$arch" in
  aarch64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo "unsupported architecture" >&2; exit 2 ;;
esac
sha256sum \
  /var/lib/e2b/bin/orchestrator \
  /fc-envd/envd \
  "/fc-versions/v1.14-0.2.0/$arch/firecracker" \
  "/fc-kernels/vmlinux-6.1.177_5008931/$arch/vmlinux.bin"
```

This prints only digests and paths. To hash the currently mapped orchestrator
and Firecracker executables without dumping process arguments or environment,
run this additional read-only loop; output is limited to executable SHA-256
values and numeric PIDs:

```sh
for name in orchestrator firecracker; do
  pids="$(pgrep -x "$name" || true)"
  for pid in $pids; do
    digest="$(sha256sum "/proc/$pid/exe" | cut -d ' ' -f 1)"
    printf '%s pid=%s sha256=%s\n' "$name" "$pid" "$digest"
  done
done
```

The running guest's `/usr/bin/envd` is in a separate microVM filesystem. Hash
it only through an already-established, authorized read-only guest observation;
do not make `Sandbox.connect` merely to inspect it because connect can resume a
paused sandbox. A guest-local command, if an existing safe shell is already
available, is simply:

```sh
sha256sum /usr/bin/envd
```

This path mapping and commands describe the inspected Compose/source snapshot.
They are not evidence that the incident deployment used these exact paths,
versions, architecture, or binary contents.

### Current owned-host inventory supplied by the orchestrator

The orchestrator reports a separate, read-only Lima inventory taken on
2026-09-23. It is current-state evidence, not historical incident provenance;
it was not independently collected by this audit. The Lima instance state was
reported as `Running`, while sandboxed Lima inspection reported `Broken` due to socket
denial. Host-side values supplied:

| Observation | Reported value |
| --- | --- |
| Linux boot ID | `4be1fe41-9287-4a82-a1c9-e7ae2b608079` |
| Guest memory | 16 GiB |
| Free guest disk | 23 GiB |
| Hugepages | 4096 total, 4084 free, 63 reserved, 2 MiB each |
| Registry records | 25 total: 16 deleted, 8 paused, 1 missing; all without `run_id` |
| Running API OCI digest | `sha256:e131ee5abc41104eb37b8fcac9bcc5ff2b76adc401bf358dc368a3c5753f5493` |
| Orchestrator service container image | `tools` image, `sha256:c565bc6b9562a54b656604f138e2cde507968a300339d822786431620a2e0fda` |
| Running client-proxy OCI digest | `sha256:f9ca12355225126dc3903b909a3c6bcbb331acb9363c27ac576b164e3db5eefd` |
| OCI revision labels | None reported |

The API/proxy OCI digests identify the reported local image contents, but no
revision labels means these facts still do not map them to source commits. The
orchestrator runs as a binary from the `tools` service image's host-root mount;
the tools-container digest is not the orchestrator binary digest. The
orchestrator subsequently hashed the four files through the already-running
owned VM; running orchestrator PID 5848 matched the on-disk hash. No Firecracker
process was present. These values identify current binaries, not which binaries
handled the incidents:

| File | SHA-256 |
| --- | --- |
| `/var/lib/e2b/bin/orchestrator` | `e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7` |
| `/fc-envd/envd` | `713b31989288fccc2f86892bb32917eacbf81a2f344aa1462abf53702df92624` |
| `/fc-versions/v1.14-0.2.0/arm64/firecracker` | `66a8347a08741e47f850da1720cc6153a6998a2c9e87666958261afbcc9ba05e` |
| `/fc-kernels/vmlinux-6.1.177_5008931/arm64/vmlinux.bin` | `3e134b55a6e4feec481f6f3a2813d42860e28c273eeb91c02df0661322e61dab` |

The Firecracker and kernel hashes match the checksum rows in the inspected
`fetch-artifacts.sh`. Public E2B release sidecars for the selected arm64
orchestrator and envd match the observed hashes. The sidecars and bytes
establish release-artifact identity but do not attest an exact source commit.
The sandboxed `limactl` report of `Broken` was a host-agent socket-denial result;
an unsandboxed read-only `limactl list` reported the owned Lima instance as
`Running`.

E2B's [release procedure](https://github.com/e2b-dev/runtime/blob/main/docs/RELEASING.md)
states that the public runtime repository is a read-only Copybara mirror of an
internal monorepo, with release tags and publishing performed in that monorepo.
It documents immutable artifact tags and SHA-256 sidecars for binaries. This
explains why matching a public source commit to the locally hashed release
binaries remains an open provenance step; the observed binary hashes and
sidecars alone do not identify the internal release commit.

A read-only copy of the scratch VM's 126,542,992-byte orchestrator binary was
inspected with `go version -m` on macOS. Its SHA-256 is
`e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`,
matching the currently observed historical VM binary. Embedded build metadata
reports Go `1.26.8`, `GOOS=linux`, `GOARCH=arm64`, module
`github.com/e2b-dev/infra/packages/orchestrator`, and linker values
`main.commitSHA=59497eb913` and
`Version=0.16.202609130627-59497eb9134`. It contains no `vcs.revision`
setting or full commit identity. The short linker SHA agrees with the release
suffix but does not prove a match to a public source revision or identify the
binary that executed each historical incident.

## Bounded source-built comparison

The orchestrator later copied the captured 2,568-file public source tree to
the owned `silo-e2b-diagnostic-d1` VM. The source archive SHA-256 was
`6fa02e068d4479ee953e66177cb6cace51ca0d7a55e2dcd35edc6e8078dec8e3`
on both sides of the transfer; the sorted per-file source manifest SHA-256 is
`f10d3785a6d55258aa2a82daebde8242f5bcbfe6bb929f3e82d8c4b733735de4`.
The `golang:1.26.8-bookworm` image ID was
`sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d`.
No service binary was replaced or restarted.

The comparison ran in a disposable container with a 3 GiB memory limit, two
CPU limit, 512-process limit and 900-second timeout, with the captured source
mounted at `/src`. `GOWORK=off`, `CGO_ENABLED=1` and `-mod=readonly` kept the
build tied to its captured module files. The first attempt compiled two packages
at once and reported `compile: signal: killed` for the S3 and codec packages at
the container memory limit. The second attempt used `GOMAXPROCS=1` and
`GOFLAGS=-p=1`, reused the downloaded modules, and built successfully with
Go `1.26.8 linux/arm64`. The first raw build log was overwritten by the retry;
the exact failure lines survive in the task tool output, and this note does not
present the retry log as the first attempt's log.

The source-built binary SHA-256 is
`22f8b1acc6efdd74ec72389055a64ebcc9da10e872cc5266063848600a247e79`.
Its `go version -m` lists 241 dependencies, as does the deployed binary, but
two resolved versions differ:

| Dependency | Captured source build | Deployed release binary |
| --- | --- | --- |
| `github.com/gofrs/uuid/v5` | `v5.5.1` | `v5.4.0` |
| `github.com/sumup/typeid` | `v0.8.0` | `v0.7.0` |

The captured orchestrator and shared `go.mod` files request the newer versions.
This is positive evidence that the captured source/dependency set is not an
exact reproduction of the deployed release build. It does not identify which
code differences, if any, affect D1–D3. The build hash difference alone would
not prove that, because path and linker inputs can also change binary bytes.

Three focused tests from the captured source tree passed under the same limits:
`TestFailedCheckpointRetainsReservationUntilBothCleanupsFinish`,
`TestCheckpoint_AdmissionRefusesBeforeAnyDestructiveStep`, and
`TestUploadSnapshotAsyncTracksWorkThroughCompletion`. These cover reservation,
early admission and upload tracking, not a failed replacement allocation or a
restart-stable durability barrier. The ignored evidence directory
`deployments/diagnostic-d1/` contains the archive, build/test scripts and logs,
and both `go version -m` outputs. The VM had 59 GiB filesystem free and the Mac
26 GiB physical free after the comparison.

## Deployed binary call-target check

A later read-only `go tool nm` and `go tool objdump` check used the pinned
orchestrator binary above, mounted read-only into `golang:1.26.8-bookworm` on
the owned diagnostic VM. The binary exposes
`(*Server).checkpointResumeFresh`, `pauseProcessRootfs`, and
`(*LocalDiffFile).CloseToDiff` symbols. The checkpoint function's named call
targets include `snapshotAndCacheSandbox` at embedded `sandboxes.go:1299`,
`GetTemplate` at line 1307, `ResumeSandbox` at line 1319,
`runCheckpointUpload` at line 1388, and `stopSandboxAsync` at lines 1289,
1363 and 1391. The rootfs diff function calls `os.(*File).Sync` at embedded
`local_diff.go:71` and `os.Remove` at lines 65 and 84. These symbols and call
targets support a close structural match for the investigated D1/D2 paths.
They do not show the branch conditions, prove which path each incident took,
recover the private release source, or establish the historical EIO cause.

The separate [D1](e2b-d1-post-capture-repro-2026-09-23.md) and
[D2](e2b-d2-rootfs-sync-repro-2026-09-23.md) source-built failure comparisons
now have independent SDK recovery assertions. P0 remains blocked on exact
incident-time source mapping and release build provenance.
