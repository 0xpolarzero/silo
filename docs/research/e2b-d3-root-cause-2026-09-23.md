# E2B D3 root cause: capture-time snapshot corruption under host storage exhaustion

Date: 2026-09-23 (late session). **The historical D3 restore panic is
reproduced deterministically from the stored artifacts on a healthy host, and
the immediately preceding snapshot generation of the same machine restores
cleanly.** The corruption entered at the 18:53 capture, 57 minutes into a
documented host-storage exhaustion crisis. All experiments ran on the owned
`silo-e2b-diagnostic-d1` deployment; the historical VM was only read
(`docker logs`, `journalctl`, read-only SQL). No SiloUI product code changed.

## The reproduction

The 23-build / 12.01 GiB canonical closure of failed build
`4d52ff40-ea41-4b1d-887c-0c000e4a5a8f` was copied to the Mac
(`d3-protected-copy/`, tar SHA-256
`eeeebf004907e67d75a6ef15a54dbb7d67463e08d7f62abc5e8f38c99d4c981e`) and all
46 body hashes verified against the incident-time manifest
(`28aab7ed…`). The bodies were placed into the diagnostic deployment's
canonical storage (re-verified in place, 46/46), and a minimal catalog chain
(`envs` + `env_builds` + `env_build_assignments` + `snapshots`, values copied
from the historical rows) exposed it as `d3failedrestore02:default`.

`Sandbox.create("d3failedrestore02:default")` — through the production API,
orchestrator, uffd memory backend and the deployed Firecracker binary —
failed **3/3** with the byte-identical incident panic:

```text
Firecracker panicked at src/vmm/src/devices/mod.rs:34:9:
The number of available virtio descriptors 41919 is greater than queue size: 256!
```

The restore path proceeds normally until `/snapshot/load` completes
(204, 41 ms), the eth0 rate-limiter patch is applied, and Firecracker aborts
(SIGABRT, core dumped) the moment it validates the first virtio queue. The
SDK surfaces `500: Failed to place sandbox`. Full log window and receipts in
`deployments/diagnostic-d1/evidence/d3-root-cause/`
(orchestrator log SHA-256 `e68ee36a…`, three panic lines).

A direct standalone Firecracker run of the same snapfile confirms the
artifacts parse (device states load; the fork rejects file-mapped restore of
hugepage-backed snapshots, "Please use uffd"), ruling out truncated or
malformed files at the container level.

## The control

Build `8210f23d-cd5b-409a-8928-91be502a21e5` — the failed memfile's own base
build, i.e. the immediately preceding snapshot generation of the same machine,
captured at **18:11** — was exposed the same way as `d3parentctrl05:default`
and **restored cleanly**: sandbox created, guest command executed
(`alive`, kernel `6.1.177+`), then killed by exact ID. No panic.

## The physical context (D2/D3 share one cause window)

Read-only inspection of the historical VM's journal shows its last retained
entries before the incident are a wall of `No space left on device` errors
from rsyslog, dockerd (json-file logs) and journald at **17:56:35** — the
Linux filesystem was full, which is also why the journal stops there. A
bounded loopback-ext4 probe on the diagnostic VM showed that plain ENOSPC
surfaces as `ENOSPC` at write with a clean fsync, not the incident's
write-then-`EIO` — so the D2 fsync `EIO` (18:53:30, sandbox
`ihuji71ivqwchwhlzmd7s`) came from a deeper failure mode under that pressure
(device layer or journal), which retained logs can no longer distinguish. The
D3 capture is 3 seconds earlier (18:53:27, sandbox
`ihgs21sl03xx1a6jao8ah`): **the same pause batch under the same crisis
produced one visible I/O failure (D2) and one silently corrupt snapshot
marked `success` (D3).**

## What is and is not established

Established:

1. The stored artifacts of the failed snapshot are internally inconsistent:
   restored guest memory and saved device state differ by exactly 41,919
   descriptors on a 256-deep virtio queue, on a healthy host, from
   hash-verified bytes, deterministically (3/3).
2. The previous generation of the same machine restores cleanly (1/1), so the
   corruption entered at the 18:53 capture, not before and not at restore
   time. Restore-time assembly, our cache reclamation, host hardware at
   restore time, and the restart itself are excluded as causes.
3. The capture ran during documented host-storage exhaustion.

Not established:

1. Which side carries the stale state — the memfile's avail-ring bytes or the
   snapfile's device state. E2B's Firecracker fork vmstate schema is private
   (vanilla v1.14.4's snapshot-editor rejects it:
   `UnexpectedVariant { type_name: "Option<T>", found: 16 }`), and the uffd
   fault reads are mmap-served, so the failing queue could not be named.
   The wrap arithmetic (`avail_idx − next_avail` mod 2¹⁶ = 41919) shows the
   two sides are from materially different moments; which one lagged is open.
2. The exact writer bug inside the capture path (memory export / uffd CoW
   state vs device-state serialization under storage pressure).

Both remain answerable with E2B's fork source or a vmstate schema from them.

## Reproduction recipe (owned diagnostic deployment)

```sh
# 1. Protected copy from the historical VM (read-only source):
#    sudo tar -cf - -C /var/lib/e2b/storage/templates <23 build ids>  → verify
#    against 2026-09-23-provenance/d3/all-ancestor-body-sha256.txt (46/46).
# 2. Place bodies under the diagnostic /var/lib/e2b/storage/templates/.
# 3. Insert envs/env_builds/env_build_assignments/snapshots rows for a fresh
#    env id (source must be 'snapshot_template' — the snapshots-insert
#    trigger forces 'snapshot', which the API's active_envs lookup rejects;
#    set it after insert and use an id the API has never resolved, its
#    negative-cache tombstones are sticky across ~minutes).
# 4. Sandbox.create('<env>:default') → 500; orchestrator log carries the
#    41919-descriptor panic.
```

## Consequences for Silo

- A pause that reports success during host storage pressure is **not** proof
  of a restorable snapshot; Silo's cutover requires a capture-side integrity
  barrier (or post-upload verification) that this incident shows is missing.
- The "older checkpoint restored correctly" behavior during the incident is
  explained: the older generation predates the corrupted capture.
- Upstream report: separate issue from #3658 (independent root cause:
  silent capture corruption, not failure-path data loss); see the final
  section of the gate matrix for its URL once filed.
