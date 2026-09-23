# D3 upstream report readiness: invalid virtio descriptor restore

Date: 2026-09-23. Scope: independent source and evidence review of the
historical D3 restore failure. No VM, service, snapshot, cache, or artifact was
changed. This note prepares a falsifiable next experiment; it does not publish
or draft an upstream issue.

## Verdict

**Do not report an upstream Firecracker defect yet.** The message identifies a
real, deliberate Firecracker safety check rejecting an inconsistent virtio
available-ring count. It does not say which persisted bytes or restore step
made that count inconsistent. The current controls pass, the 23-build artifact
closure is present now, but there is no independent pre-incident checksum for
the guest memory/device state and no source/build mapping from the incident
Firecracker binary to an exact commit.

The falsifiable position is: **the failed restore supplied a virtio queue state
whose available index minus Firecracker's saved `next_avail` was 41,919 modulo
2^16, while the queue size was 256.** A report becomes supportable only if the
same defect is reproduced from a protected copy or a newly created minimal
snapshot with a clean upload barrier, and an exact source-built version exhibits
it in a control that excludes corrupted or mismatched inputs. If clean
source-built snapshots stay valid while the historical copy fails, the evidence
points to artifact/state mismatch, not a general Firecracker restore bug.

## What the evidence says

The historical log links the 2026-09-22 18:59:02 restore request to sandbox
`ihgs21sl03xx1a6jao8ah`, build
`4d52ff40-ea41-4b1d-887c-0c000e4a5a8f`, and snapshot template
`2zow77tphtoidyg1lt2g`. Firecracker then reported 41,919 available descriptors
against queue size 256 and exited; the subsequent network rate-limit request
failed with EOF. The upload-success log for this snapshot precedes the restore
by about five minutes. That rules out only the simple claim that restore
necessarily raced an upload still in flight.

The preserved canonical tree currently has both rootfs and memory V3 header
closures: 23 build IDs total, 46 body files with 12.01 GiB logical size, all
present and hashed in place. The failed build's memory header refers to base
`8210f23d-cd5b-409a-8928-91be502a21e5` and four mapped IDs; its rootfs header
has a different base, `dab5cb2b-9a16-4044-be57-2c650748e617`, and 22 mapped
IDs. The separate closures matter: following one base alone is incomplete.
This is evidence that the currently inspected dependency graph is closed and
readable. It is not evidence that the same bytes were present before reboot,
that the Firecracker `snapfile` is internally valid, or that memory reconstruction
used the intended pages. No original expected body hashes exist.

The scratch control restored one 512 MiB guest after both an orchestrator-only
restart and a clean Linux host restart. The run captured an exact upload marker,
catalog link, canonical readback manifest, and memory/file/new-write oracles.
Both restarts were quiet and did not clear the cache. They show that this path
works for those exact small snapshots. They do not exercise the failed D3
snapshot, a cold cache, or pressure.

## Firecracker source interpretation

The upstream, non-E2B [v1.14.0 virtio queue implementation](https://github.com/firecracker-microvm/firecracker/blob/v1.14.0/src/vmm/src/devices/virtio/queue.rs#L422-L453)
computes the unconsumed descriptor count as the 16-bit wrapping difference
`avail_ring_idx - next_avail`; `pop()` returns `InvalidAvailIdx` when that count
exceeds the configured queue size. The same source says this condition is
treated as a possible guest denial-of-service at runtime. Queue size 256 is
Firecracker's maximum for this implementation. Thus 41,919 is not 41,919
separate descriptors in the ring; it is the modular counter difference and
signals state disagreement far beyond one queue's capacity.

The [Firecracker v1.14.0 changelog](https://github.com/firecracker-microvm/firecracker/blob/v1.14.0/CHANGELOG.md#L197-L218)
does not list a virtio queue regression fix in that release. Earlier changelog
history records a deliberate fix to report and terminate when an available
count exceeds the queue capacity ([v1.2.0 entry](https://github.com/firecracker-microvm/firecracker/blob/v1.14.0/CHANGELOG.md#L456-L474)). This is evidence that the guard itself is
intentional, not that snapshot loading correctly handles every malformed
snapshot. The v1.14.0 queue comments also distinguish guest-runtime use, where
fatal handling is expected, from paths such as loading a corrupt snapshot,
where the error should be returned. We do not have the incident Firecracker
stack trace or exact source mapping to establish which call path produced the
observed process exit.

The error can result from either side of the counter pair being inconsistent:
guest memory may contain an unexpected `avail_idx`, or the saved device state may
contain an incompatible `next_avail`. A restored guest memory page mapped from a
wrong/missing ancestor can produce the first; a Firecracker snapshot/device
serialization or load-order defect can produce the second; a mismatched snapshot
and memory body can produce either. The rootfs header dependency graph does not
directly encode this queue counter, though unrelated rootfs state could cause
post-restore guest activity. The panic string alone cannot assign a component.

## Competing explanations and discriminators

| Explanation | Current evidence | Discriminator | Evidence against it |
| --- | --- | --- | --- |
| Firecracker save/restore defect | Firecracker exits on restore with a queue-state guard; restart was clean. | Repeat a newly created snapshot with a verified upload barrier on a pinned Firecracker build; exercise quiet and bounded I/O snapshots, then restore from cold and warm cache. Capture `/snapshot/load` response, Firecracker stderr/metrics and exact binary hash. | Repeated valid restore of same protected snapshot bytes across cold and warm paths, or failure only on one unverified historical artifact. |
| Snapshot or guest-memory inconsistency | The 41,919 modular delta is much larger than a 256-entry ring; no pre-failure memory/device hashes exist. | Preserve a byte-for-byte copy of the complete historical closure where storage budget permits; test the same copy in a fresh isolated deployment. Inspect and compare Firecracker snapfile and memory mappings without rewriting the source copy. | Reproducible failure from newly created verified snapshots with clean source and matching binaries. |
| Cold-cache fetch / mapping reconstruction | Existing controls used an already-populated cache; D3 has 23 mapped builds across separate memory/rootfs ancestry. | Restore one exact newly made snapshot from an empty per-deployment cache while canonical storage remains unchanged; verify every referenced object hash before and after, and record actual fetched paths. | Same failure from a warm local-cache restore with identical object hashes and no cache read path. |
| Pressure exposes ordering or read error | The historical environment had cache cleanup, disk expansion, service restarts and other work between tests; no exact pressure measurement is tied to this restore. | Repeat bounded background reads/writes in a dedicated cgroup only after cold/warm baseline passes, with a strict byte, memory and duration cap; collect I/O errors, free space and restore result. | Failure at idle across repeat runs, or clean restores under equal bounded pressure. |
| Wrong snapshot/runtime pairing | Static pins name Firecracker `v1.14-0.2.0`, but the observed request, binary provenance, and snapshot build pipeline are not all mapped to an exact source build. | Capture the snapshot's metadata and device config, resolved binary digest, full `--version`, build record, and exact image/source attestation; compare the expected and actual producer/loader. | Exact matching producer/loader provenance and a reproducible failure from that pair. |

No row is currently confirmed as cause. Pressure is a possible trigger, not a
cause inferred from historical disk cleanup or cache equality.

## Smallest safe next experiment

Use only a separately owned scratch deployment and one SDK-only 128–256 MiB
guest. Do not connect, restore, copy, delete, or change the preserved historical
VM. Keep the production user data and existing diagnostic deployment outside
the lease. The test should create its own snapshot, so it does not need the
12.01 GiB historical memory/rootfs closure.

1. Before setup, record Mac free space and the new VM's guest filesystem free
   space. Require at least **8 GiB free on Mac Data and 8 GiB free in the new
   VM**. Set a **4 GiB maximum additional Mac Data footprint** for this entire
   experiment, including VM image growth, logs and temporary copies. Abort if
   the candidate VM or a snapshot closure would exceed a **2 GiB logical
   artifact budget** or if the measured Mac delta reaches 4 GiB. These caps
   preserve at least half the current 18 GiB Mac headroom.
2. Use the pinned scratch recipe with a new deployment name, unique Lima home,
   explicit host port, and a declared exclusive host lease. Record source tree
   manifest, Compose hashes, resolved OCI digests, `/var/lib/e2b/bin/orchestrator`
   SHA-256 and `go version -m`, Firecracker `--version` plus SHA-256, envd and
   kernel hashes, and all snapshot metadata before creating a guest.
3. Create one guest with a random in-memory nonce and a fsynced file. Run a
   short deterministic virtio baseline: one process-level HTTP request/response
   plus sequential writes capped at 16 MiB. Then pause once. Wait for the
   sandbox-specific upload-completion record and exact catalog build link;
   run `sync -f` on canonical storage and record the read-only transitive
   manifest. Do not treat database `success` alone as the barrier.
4. Preserve this snapshot as an immutable golden build. For each condition,
   launch an independent disposable instance from that exact build using a
   supported fork/revert operation or a separate scratch deployment that reads
   the same canonical build. Confirm the catalog resolves every launch to the
   same build ID and retain the golden build unchanged. Read the nonce and
   fsynced file, make and verify one new fsynced write, and collect the exact
   restore response and artifact hashes. If the existing SDK path cannot launch
   multiple independent instances from one immutable build, stop; do not claim
   a same-snapshot cold/warm comparison from newly generated near-matching
   snapshots.
5. First restore one disposable instance with its already-populated cache.
   Then test cold cache only through an isolated cache path belonging to this
   new deployment. Preserve the warm cache manifest; prove no active guests or
   Firecracker processes belong to it; clear only that deployment's cache via
   its supported cache operation, never by a broad `rm` or global prune. Restore
   from the same canonical build, record every fetched object and compare the
   post-fetch hashes to the pre-run canonical manifest. If the code exposes no
   supported per-deployment cache reset, stop here and provision a fresh isolated
   deployment instead of inventing a deletion command.
6. Only after both idle restores pass, run one pressure case against another
   disposable instance from the same immutable build: keep guest virtio activity
   bounded to 16 MiB; add host-side
   background file I/O in a cgroup capped at 1 CPU, 512 MiB RAM, 1 GiB writes,
   and 60 seconds. Do not fill the host disk, consume hugepages, or induce host
   OOM. Record cgroup counters and free space. Repeat cold restore once under
   this cap, then stop pressure and restore once more as recovery control.
7. Preserve all failed output before any retry. Save only redacted reports and
   manifests in the ignored verification tree; do not publish raw guest memory,
   rootfs files, credentials, or system logs. Gracefully retire the exact
   run-owned guest and deployment after receipts are hashed; check free space
   before and after, and record cleanup ownership.

These are hard stop limits, not targets to consume. The historical closure's
12.01 GiB logical body set must not be copied to the Mac under the present
18 GiB headroom. If a later engineer needs that exact historical-copy test,
first reserve a separate owned Linux volume with **at least 32 GiB free** (12.01
GiB protected copy + up to 12.01 GiB staging/cache overlap + 8 GiB safety
reserve), make a read-only source copy and hash it, then operate only on a
second disposable copy. A hash manifest without the bodies is not an equivalent
restore test.

## Source and version mapping gap

The incident evidence does not establish the exact deployed Firecracker source
commit. The static runtime Compose input at `a065a4d` selects the release label
`v1.14-0.2.0`; the preserved historical metadata also reports that label. The
current observed binary SHA-256 is
`66a8347a08741e47f850da1720cc6153a6998a2c9e87666958261afbcc9ba05e`, but this
is a current binary observation, not incident-time attestation. E2B's archived
[Firecracker repository README](https://github.com/e2b-dev/firecracker#releases)
says current Firecracker releases are built by the `e2b-dev/infra` fc-versions
pipeline and published as artifacts; the public runtime Compose revision and
the binary release label therefore do not by themselves map to source. No
verified `infra` build record, signed provenance statement, immutable incident
binary digest, or v1.14-0.2.0 source commit has been collected here.

The runtime source mapping has a parallel gap: the deployed orchestrator has
linker metadata `Version=0.16.202609130627-59497eb9134` and short commit
`59497eb913`, but public source suffixes did not resolve, and the captured
source-built orchestrator resolves two dependency versions differently from
the deployed binary. Its structural similarity does not qualify it as the
incident build. The public runtime repo is an E2B Copybara mirror, while release
tags and builds are produced from the internal monorepo. Exact source mapping
requires release-pipeline metadata or an attested source archive tied to the
observed binary digest. Without it, describe any reproduction as a
source-built-candidate result, not a historical root cause.

## Upstream report gate

Open an upstream report only when all of these are true:

- The reproducer is one command on a disposable host and leaves its failing
  snapshot and complete dependency manifest intact for inspection.
- The exact guest image/kernel, Firecracker binary/version/hash, producer and
  loader source revisions, queue size and snapshot/cache condition are recorded.
- A new, fully uploaded snapshot fails at least twice under the same bounded
  condition; an unarmed baseline and the same snapshot's alternate-cache control
  pass, or the failure is otherwise isolated to Firecracker's snapshot/load
  code rather than a bad artifact.
- The Firecracker error stack distinguishes failure during snapshot loading
  from a later guest-runtime virtio event. A failure report includes the exact
  `/snapshot/load` response, VMM log/metrics, and before/after artifact hashes.
- The report states the scope: whether restore rejects a corrupt input safely,
  or whether a Firecracker-created snapshot becomes invalid after successful
  save/restart. Do not claim corruption or erased guest data unless recovery
  investigation proves that scoped state cannot be recovered.

Until these gates pass, the supported conclusion remains **D3 unexplained;
upstream report not ready**. The next action is to map the v1.14-0.2.0 artifact
through E2B's release pipeline and obtain an isolated cache-reset mechanism
before granting the scratch host lease.

## Sources and local evidence

- Historical artifact inventory and 23-build graph: [D3 artifact audit](e2b-d3-artifact-audit-2026-09-23.md).
- Passing small guest restarts and limitations: [D3 controlled restarts](e2b-d3-controlled-restarts-2026-09-23.md).
- Binary, source and dependency provenance: [provenance audit](e2b-provenance-audit-2026-09-23.md).
- Overall blocked gate status: [qualification gates](e2b-qualification-gates-2026-09-23.md).
- Firecracker queue guard: [upstream v1.14.0 queue source](https://github.com/firecracker-microvm/firecracker/blob/v1.14.0/src/vmm/src/devices/virtio/queue.rs#L422-L453), a comparison source rather than a proven match for the E2B release.
- Firecracker release changes: [v1.14.0 changelog](https://github.com/firecracker-microvm/firecracker/blob/v1.14.0/CHANGELOG.md#L197-L218).
- Descriptor-ring definition: [OASIS Virtio 1.4](https://docs.oasis-open.org/virtio/virtio/v1.4/virtio-v1.4.html).
