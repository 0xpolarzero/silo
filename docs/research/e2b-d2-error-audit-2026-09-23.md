# D2 pause I/O failure: preserved log and catalog evidence

Date: 2026-09-23. Scope: read-only inspection of the already-running owned
historical E2B VM. No sandbox was connected, resumed, deleted, or changed.
The original `/tmp/silo-pause-failure.log` is absent after reboot, but the
orchestrator container still retains lines for the exact failed request.

The affected sandbox was `ihuji71ivqwchwhlzmd7s`. Its pause RPC began at
2026-09-22 18:53:30+02:00. Firecracker paused at 18:53:32.341, created a full
snapshot at 18:53:33.040, and the orchestrator logged `sandbox lifecycle
stopped` at 18:53:33.141. At 18:53:37.555 the orchestrator logged:

```text
error snapshotting sandbox: error while post processing: synchronous rootfs export failed: failed to convert rootfs diff file to local diff: failed to sync file: sync /orchestrator/build/2d5669c0-ca9c-4815-bffb-0621fc738f59-rootfs.ext4-ov20x5xsxt75ubtxkaxx: input/output error
```

The gRPC `SandboxService/Pause` call then returned `Internal` with the same
error. This identifies a failed sync on the local rootfs diff path and
establishes that the sandbox process had stopped before the error response.
It does not identify why the Linux `sync` call returned EIO: neither a device
error, host disk capacity, fault injection, nor the exact underlying syscall
has been verified. A later `df` value cannot retroactively establish free
space at the time of the call.

A read-only catalog SELECT still finds snapshot template
`naa4djgwyr0zwl7ns8d2`, build
`2d5669c0-ca9c-4815-bffb-0621fc738f59`, status `failed`, created
2026-09-22 16:53:30.435+00:00, finished 16:53:37.564+00:00. The exact
`/orchestrator/build/2d5669c0...*` diff file and canonical
`/var/lib/e2b/storage/templates/2d5669c0...` directory are absent in the
current VM. The local template-cache directory contains no files now. These
current absences do not prove what bytes existed immediately after the failed
pause or whether an alternate recovery path ever existed.

A later read-only journal check on the historical VM found no retained kernel
entries from 2026-09-22 18:52–18:55 CEST. `journalctl --list-boots` shows the
prior boot's last retained entry at 17:56:35 CEST and the current boot's first
at 18:56:51 CEST, a gap that covers the pause error at 18:53. This journal
cannot distinguish the EIO's storage or host cause.

The inspected source's D2 call graph is in
`docs/research/e2b-lifecycle-source-audit-2026-09-23.md`. It plausibly
explains process teardown after a rootfs export failure, but deployed source
identity remains unverified. A later
[source-built synthetic EIO reproduction](e2b-d2-rootfs-sync-repro-2026-09-23.md)
confirmed the failure propagation and SDK recovery rejection on a separate
owned VM. It did not identify the real kernel EIO cause or implement a fix.
