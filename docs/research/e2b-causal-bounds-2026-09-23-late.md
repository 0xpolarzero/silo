# E2B causal bounds: D1 resume boundary, D2 actual-fsync EIO, D3 cache topology

Date: 2026-09-23 (late session). Scope: three causal upgrades on the owned
`silo-e2b-diagnostic-d1` deployment, executed after the fresh final run
`afe75b686e9a47c19e2b83e5c47d30fd`. The historical `silo-e2b-poc` VM was
touched only read-only (one `docker exec env`/`ls` probe of its orchestrator
container). No SiloUI product code changed. All new raw evidence is under the
ignored `app/SiloUI/src-tauri/target/verification/e2b-local/deployments/diagnostic-d1/evidence/`
tree and the VM-private `/var/lib/e2b/verification/` directories.

## D1: exact-ID fault at the real `ResumeSandbox` call boundary

The previously unexecuted
[`d1-resume-allocation-exact-id.patch`](../../experiments/e2b-local/patches/d1-resume-allocation-exact-id.patch)
was built and run in the owned VM for the first time.

- Disposable copy of the captured public tree (manifest base: the pristine
  2,568-file capture that accepts both earlier diagnostic patches), plus the
  patch (2,570 files). Archive SHA-256
  `5c5fd713c044de554e0295c874fa145ff5e48fb944878b650542efe248e2585a`.
- Linux Go 1.26.8 container build: focused test
  `TestD1ResumeAllocationFaultTargetsOneSandboxOnce` passed
  (`ok … 0.019s`); binary SHA-256
  `7746aa50ab06b870687b93da10f58efe7d31bfea83b4f1fb11fb8c43b6e5744b`.
  Switch script `d1-resume-orchestrator-switch.sh` (deploy/restore with hash
  and health checks); pinned binary backed up and restored unchanged
  (`e5052cb59d4bfef1c2b9d90266f2aa4a061fa5551b52d1853a9895494245a8f7`).

| Run | Mode | Outcome |
| --- | --- | --- |
| `16f2d77d9cc14dc8892ad0b5f514cc2c` | unarmed control (trigger absent) | checkpoint + restore both preserved process-memory nonce, fsynced-file hash, and a new write. Both guests deleted by exact ID. Report SHA-256 `024346834b481d5db912cd4756ccb096fedf6a9b94be56858237e0e3bb7658bc`. |
| `29f28a3dbd1741cdb11a475ba34cf90d` | exact-ID fault at `ResumeSandbox` | trigger `.fired` consumed; SDK `create_snapshot()` → `500: Error creating snapshot template`; source `get_info` → `SandboxNotFoundException`; zero Firecracker processes; no run-tagged candidates; build `c53a5e66-acbd-4176-878f-ba2015f0e969` failed with reason carrying the exact marker; local-only artifacts (160 MiB memfile, 144 KiB rootfs diff, staged metadata/snapfile); no canonical build dir; SDK restore from `yxah1fbi2n15gv86zsyp:default` → `404`. Report SHA-256 `d933018a3fac30659032d628924714c0028c978d7c20d0f44806e02136cc3977`; restore receipt SHA-256 `9a80a165209b0773cd4c6cc52541e613aec14a2cb21c49b50b0f2ff70ef4c1cc`. |

Preserved root-only evidence under `/var/lib/e2b/verification/d1-resume-fault/`:
local-artifact tar (167,936,000 bytes, SHA-256
`44f3d144576d362ea6ab0a70a2937e65e563e66175f591aee72ac3ef631f44e4`),
orchestrator log window SHA-256
`558a49b3a6da30d2a635f001aec205494308a5a8eb6f3d62e72c21b95e7607e2`, API log
window SHA-256
`0fc7af3d5d917624d0b4681a58b3683afcf9b8ece6dfa29694f2bf0451a16601`, and the
`.fired` trigger marker.

**What this upgrades:** the failure-preservation defect is no longer only
demonstrated at an inserted post-capture return. It reproduces at the actual
`ResumeSandbox` call site — the historical "fresh-resume allocation failure"
location — with the source's own error branch, telemetry, API build failure,
and cleanup all executing unchanged. The error value remains synthetic (not a
real `ENOMEM`/hugepage failure), the candidate still differs from the pinned
release at two dependency versions, and one armed run plus one control does
not measure a failure rate. Historical D1 attribution remains **unresolved**;
the preservation-failure-on-candidate evidence is now two-for-two across two
distinct boundaries.

## D2: actual `fsync` EIO on the pinned release binary

The prepared strace preflight
([`run-sync-probe.sh`](../../experiments/e2b-local/d2-report/run-sync-probe.sh))
passed in a disposable `golang:1.26.8-bookworm` container with strace 6.19:
`PASS: actual File.Sync syscall returned injected EIO on exact target;
unrelated sync succeeded`.

Additional mechanism probes (same container): directory-scoped `-P` traces
nothing on strace 6.19 (rejected for the orchestrator); `when=N` counters are
per-thread, defeating ordinal targeting in a Go program; attach requires `-f`
and works with `--inject` on an exact file path.

**Experiment design that worked:** the orchestrator launch script's own
`OL_COMMAND` hook was not needed; instead a watcher observed the pause's new
`*-rootfs.ext4-*` file under `/orchestrator/build` and attached
`strace -f -p <orchestrator-pid> -P <exact-file> -e trace=fsync,fdatasync
-e inject=fsync:error=EIO:when=1` inside the write→sync window. The
**pinned, unpatched release binary** (`e5052cb5…`) served both runs. Runner:
`sdk-d2-sync-fault-repro.py` (deployment evidence tree).

| Run | Outcome |
| --- | --- |
| `bf19ecc9a6bc423ba010df4032d2a8d9` | one `INJECTED` fsync EIO on the pause's own diff file (`fsync(55</orchestrator/build/51cdd27a-…-rootfs.ext4-oryu4zye2s7gc0ojsp1k>) = -1 EIO`); pause → `500: Error pausing sandbox`; orchestrator log carries the exact historical chain: `error snapshotting sandbox: error while post processing: synchronous rootfs export failed: failed to convert rootfs diff file to local diff: failed to sync file: sync /orchestrator/build/…: input/output error`; source `get_info` → `SandboxNotFoundException`; no processes/candidates; build `51cdd27a-…` failed; no local/canonical artifacts at observation; exact `connect` → `SandboxNotFoundException: Paused sandbox … not found`; create-from-snapshot `s98ziq84wc896iibcmh7:default` → `404`. Strace SHA-256 `a6f6edf7e3c1dad106cfae43c87c71f9a81957e0d91cf45bf7abf9e1a6d4379c`. |
| `4dcd6f6049ef45cb8aed058d91ad3f39` | identical outcome, 2/2 repeatability. Strace SHA-256 `3909af8821c3ce31489e3d4a7cc6c9d8b562b41dd82e9ccfcd07630585aae9b4`. |

Combined log window (both attempts) preserved at
`/var/lib/e2b/verification/d2-sync-fault/` and copied (redacted-free, no
credentials) into the Mac evidence tree.

**What this upgrades:** the deployed release binary itself — not a source
build — returns the exact historical error signature when the actual
`File.Sync` on the actual rootfs diff file fails with a real kernel `EIO`
(ptrace-injected at the syscall boundary; the physical writeback cause of the
historical incident remains unknown). Post-failure behavior on the release
binary matches the earlier source-built run: source stopped and
SDK-unaddressable, failed build, local artifacts removed by the error path,
no tested SDK recovery route. This satisfies the "actual failing sync"
condition of the [D2 report readiness](e2b-d2-report-readiness-2026-09-23.md)
for a **source-built-candidate-scoped** upstream claim about failure
preservation; incident-time physical cause, effective flags, and an upstream
durability contract for failed pauses remain unproven. ENOSPC and
upload-failure variants remain unrun.

**Upstream report:** the narrow release-binary claim above was filed as
[e2b-dev/runtime#3658](https://github.com/e2b-dev/runtime/issues/3658)
(2026-09-23). It claims only the demonstrated failure-handling behavior and
asks for the intended contract; it does not attribute the historical
incident, assert a storage defect, or extend to E2B Cloud.

## D3: cache topology finding and an activity control

Read-only source + runtime inspection established the deployment's template
cache topology:

- Both deployments run the orchestrator with `ENVIRONMENT=local`; the
  `use-nfs-for-snapshots`/`use-nfs-for-templates` flags therefore default
  enabled, but `SHARED_CHUNK_CACHE_PATH` is unset, so the persistent chunk
  cache layer is disabled (startup warning path).
- Every template/snapshot open stages a fresh per-UUID copy under
  `TEMPLATE_CACHE_DIR` (default `/orchestrator/template/<build>/cache/<uuid>/`,
  from `packages/shared/pkg/storage/paths_cache.go:51`), removed on close;
  bodies are read from `TEMPLATE_STORAGE_URL=file:///var/lib/e2b/storage/templates`.
  The historical D3 log path is this per-open staging directory.

**Consequence:** there is no persistent warm body cache in this deployment;
every restore reads canonical storage. The prior restart controls therefore
already exercised the "fresh cache" fetch path, and the D3 readiness note's
"fresh-cache through an isolated per-deployment cache path" precondition is
structurally satisfied rather than needing a cache reset. A supported knob
(`SHARED_CHUNK_CACHE_PATH`) exists if an isolated cache is ever needed.

New bounded activity control `82a4e34f141645eeb6a59dca23f72946`
(`sdk-d3-activity-repro.py`, pinned binary): guest under disk bursts, memory
churn, and loopback network load during pause; upload-success marker
observed; catalog build row present; canonical closure readback exit 0;
orchestrator-only restart healthy; resume preserved process-memory nonce,
fsynced file, and accepted a new write. Report SHA-256
`a4a6dbe880957492f327881d4dee667a51d1bfd7847500c899f857c4792a3bfb`. Guest
killed by exact ID; zero Firecracker processes after.

**What remains blocked for D3:** the historical failed build's 23-build /
12.01 GiB closure cannot be protectively copied on this host (needs ≥32 GiB
free on an owned Linux volume; the deployment currently has ~32 GiB total
free against a 12 GiB protected copy plus staging and safety reserve, and
that free space is also the working budget for every other gate). The
historical panic therefore remains **unexplained**; activity during capture
on the current release does not reproduce it (one control, small guest).

## Repeatability and environment ledger

- D1 resume boundary: 1/1 armed reproductions + 1/1 unarmed control on the
  same built candidate.
- D2 actual-fsync EIO: 2/2 armed reproductions on the pinned release binary;
  the attach won the write→sync race both times (watcher delay 3–5 s in the
  event timeline of each report).
- All three runs used template `silo-sdk-lifecycle-20260923` (1 CPU, 512 MiB)
  and SDK 2.51.0; no Silo adapter, LCU, credentials, or desktop template was
  involved in the fault runs.
- After every experiment the pinned orchestrator hash was re-verified
  (`e5052cb5…`) and the container reported healthy; zero Firecracker
  processes and no run-owned sandboxes remained.

## Addendum (same session, after spare disk was confirmed available)

**D1 with a real allocation failure on the release binary.** Run
`ac86384031c84816ac1297a34fc33d29` exhausted the host's reserved 2 MiB
hugepages (anonymous `MAP_HUGETLB`, 3,765 pages held, effective free 0,
released in `finally`); `create_snapshot()` then failed at the exact
historical boundary with a genuine kernel `ENOMEM`:

```text
error resuming sandbox after checkpoint: failed to start FC: error loading
snapshot: uffd process exited: failed to wrap memfd: mmap memfd: cannot
allocate memory
```

The preservation failure matched the incident: source `SandboxNotFoundException`,
no processes/candidates, build `3ee1eff7-…` failed, local-only artifacts,
restore `ug714q1ks4flb6f4e5al:default` → 404. Evidence preserved under
`/var/lib/e2b/verification/d1-hugepage-fault/` (artifact tar SHA-256
`fe262750…`, orchestrator log `cf3d2900…`, API log `e20bc360…`). Reported as
a comment on [e2b-dev/runtime#3658](https://github.com/e2b-dev/runtime/issues/3658#issuecomment-5799997670).
Two earlier runner attempts (`ea1e4268…`, `6ea5af16…`) are preserved as
failed-runner receipts; cleanup `Sandbox.connect()` on a stopped sandbox was
observed to auto-create a brand-new runtime (sandbox `i8lkkq28…`), a live
instance of the "reads must not implicitly resume" adapter hazard.

**D2 physical cause bounded.** The historical VM's journal ends (17:56:35, 57
minutes before the incident) in a wall of `No space left on device` errors —
the filesystem was full; that also explains the journal gap. A bounded
loopback-ext4 probe on the same kernel shows plain ENOSPC yields `ENOSPC` at
write with clean fsync, so the incident's write-then-`EIO` arose from a deeper
mode under that pressure (device layer or journal), which retained logs can no
longer distinguish. Current mount shows zero ext4 errors. Context posted to
#3658 (same comment).

**D3 root cause identified** — see
[D3 root cause](e2b-d3-root-cause-2026-09-23.md). Deterministic 3/3
reproduction of the exact 41919-descriptor panic from hash-verified stored
artifacts on a healthy host; the previous generation (18:11 capture) restores
cleanly; the corruption entered at the 18:53 capture during the storage
crisis. Filed as
[e2b-dev/runtime#3659](https://github.com/e2b-dev/runtime/issues/3659). Which
side (memfile ring bytes vs snapfile device state) is stale remains open —
E2B's fork vmstate schema is private; vanilla v1.14.4's `snapshot-editor`
rejects the fork format (`UnexpectedVariant { type_name: "Option<T>", found:
16 }`; editor binaries for v1.14.0 and v1.14.4 built and preserved, SHA-256
`d3e198b2…`/`79cc2cde…`).
