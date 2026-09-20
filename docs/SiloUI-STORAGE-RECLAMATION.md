# Workspace disk reclamation

Silo reclaims blocks that the workspace filesystem has already marked free. It
does not delete projects, dependencies, caches, or system files. The Storage panel
reports host allocation separately from guest filesystem usage and capacity.
Reclamation currently applies to the local VM's ext4 `/workspace` disk, not its
overlay runtime disk or a VM on another computer.

## Policy

All intervals use persisted Unix timestamps, keyed by the immutable local VM ID.

| Trigger | Eligibility |
| --- | --- |
| Explicit successful start | Never successfully trimmed, or last success at least 604,800 seconds (7 days) ago |
| Background check every 60 seconds | Same 7-day rule; running VMs only |
| Normal Stop, Restart, or Quit | Last success at least 86,400 seconds (24 hours) ago, or never successfully trimmed |
| Manual Reclaim unused space | No elapsed-time restriction; VM must be running |

Automatic attempts additionally require at least 86,400 seconds since the last
attempt. An interrupted or unsupported operation therefore cannot retry on every
monitor tick or every Quit. Failures never advance the successful-trim timestamp.
Clock rollback postpones eligibility until the saved time plus interval is reached.
These intervals are product policy choices, not an experimentally optimal schedule.

Each trim gets at most a 15-second host command budget. With the full budget, the
guest uses `timeout -k 1s 12s fstrim /workspace`, the runtime exec has a 14-second
timeout, and the host command deadline is 15 seconds. Smaller remaining budgets
reduce the nested deadlines; less than four seconds remaining skips the attempt.
Quit establishes one shared maintenance deadline 15 seconds after Quit begins,
including any maintenance already in progress. It does not grant 15 seconds per
VM. Normal VM stop/verification retains its existing separate timeout. These are
command execution deadlines, not a guarantee that an unresponsive kernel or
filesystem syscall can be cancelled instantaneously.

The monitor takes the existing runtime mutation lock without waiting, checks a
rotating VM order within its budget, and trims at most one VM per tick. Lifecycle
maintenance also holds that lock. Trim additionally takes the cross-process Silo
configuration lock without waiting; conflicts defer maintenance. Failures do not
veto a normal stop. Durable history preserves the last result and is removed when
the VM is deleted.

## Worker compatibility and boundaries

The pinned runtime advertises `--silo-storage-protocol` version `1`. A successful
explicit start records its `runtime_instance_id` in Silo's memory only after the
runtime passes that check. The instance is the active database run ID and start
timestamp, with the run PID checked against the handle. Before trimming, Silo
requires the same instance, matching managed VM ID, and the expected workspace
disk mount in both desired and available active configuration. An app attaching
to an existing VM after relaunch or a VM started outside this app requires a
restart before trimming. No read or reclaim command automatically boots a VM.

Guest commands independently check that `/workspace` is an ext4 mountpoint.
Disk allocation uses Unix `st_blocks * 512`; guest usage/capacity comes from
`df -B1`. Reported reclaimed bytes are the decrease in host allocation, never
the logical byte count printed by `fstrim`. Concurrent guest writes or APFS clones
can make this differ from the increase in free space on the physical volume.

The open workspace disk descriptor is checked after success or failure. A
shortened logical tail is restored to the original length and reported as a
failure; a growing image is never truncated. This is a defensive guard in
addition to the underlying runtime fix.

## Reproduction and upstream fix, 2026-09-20

On a stopped local development VM, the workspace image occupied 38,821,707,776
bytes on APFS while `df` reported approximately 604 MiB used inside the guest.
The controlled trim took 8 seconds (11.253 seconds including temporary boot,
whole-workspace checksum comparison, and shutdown). Host allocation fell to
889,184,256 bytes: a decrease of 37,932,523,520 bytes, approximately 35.33 GiB.
SHA-256 manifests of all regular workspace files matched before and after trim.

Reboot verification exposed a bug in `msb-imago 0.1.5`: its
`try_discard_by_truncate` optimization shortened an image when the discarded
range reached its end. Its cached size hid the problem until reopen. The ext4
superblock still declared 128,849,018,880 bytes, but the file had shrunk to
128,716,906,496 bytes; the next mount failed with EINVAL. An APFS clone was
preserved and the missing empty tail was extended back to the declared size.
The VM then booted and its workspace files were readable again.

The maintained MicroSandbox patch now contains a small dependency patch removing
the truncation shortcut. Discard uses hole punching, preserving logical length.
Its regression creates a disposable 1 MiB image, discards its latter half, closes
and reopens it, then checks length, the retained prefix, and zero reads from the
discarded tail. The test failed with a 524,288-byte reopened image before the fix
and passed afterward. The runtime builder extracts only the checksum-verified
locked crate archive, applies the patch, and adds a local Cargo override. Every
other locked dependency remains unchanged. Both cached and newly built binaries
must advertise the storage protocol.

A separate guest timeout probe exited 124 after a one-second deadline without
leaving its delayed child running. This verifies ordinary process cancellation;
it does not prove bounded cancellation of every possible stuck storage syscall.

## Other storage growth

Silo already bounds runtime logs to 250 MiB and seven days through the shared
`log_retention.rs` implementation. Its private publishing cache has a 2 GiB
eviction budget. Guest project caches belong to the user's workloads; this
feature does not silently remove them. Free blocks in the guest and persistent
files are different cleanup problems.

## Sources and verification

- [util-linux fstrim manual](https://www.man7.org/linux/man-pages/man8/fstrim.8.html):
  discard requests apply to unused filesystem blocks; reported bytes describe
  potential discard rather than physical space actually recovered.
- [Imago source](https://github.com/superradcompany/imago): the pinned published
  `msb-imago 0.1.5` crate, `src/file.rs`, contained the tail-truncation shortcut.
  Its exact input is verified against the pinned MicroSandbox Cargo.lock checksum.
- Backend policy, identity, failure, logical-length protection, guest measurements,
  and lifecycle-stop regression tests live in `runtime/storage/tests.rs`.
- Frontend bridge and Storage panel behavior use deterministic fixture tests.
- Build-tool tests cover verified single-crate patch staging and reject unexpected
  dependency identities or lockfile contents.

Compilation and fixture tests do not prove installed-app behavior, remote VM
health, or release readiness. Live checks use explicitly named bundles/runtime
binaries and preserve their results under ignored `target/verification/` output.

### Final verification

- `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml runtime::` with
  explicit synthetic test configuration: 144 passed, 7 opt-in tests ignored.
  This includes the isolated regression for Quit beginning during a VM start.
- Selected ignored `live_reclaim_preserves_capacity_contents_and_reboots` with
  explicit runtime path, VM ID, runtime home, and a pre-existing checksum:
  passed in 8.58 seconds. It ran production lifecycle/storage functions against
  the rebuilt `target/debug/bundle/macos/Silo.app/Contents/MacOS/msb`, exercised
  automatic/manual reclamation, and verified matching file manifests and
  128,849,018,880-byte logical disk capacity across two starts and stops.
  The VM was left stopped. Repeated trims recovered zero additional bytes, as
  expected after the initial reclaim; workspace host allocation remained
  889,184,256 bytes, with 632,422,400 bytes used inside the guest.
- Focused frontend bridge, panel, overview, and production-source tests:
  82 passed. Typecheck and lint passed.
- `npm --prefix app/SiloUI run test:release`: 36 passed.
- `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 npm --prefix app/SiloUI run desktop:build:debug`:
  local macOS debug bundle built successfully. This is not a published or
  notarized release. No installed copy was replaced.

The application-support directory measured 6.7 GiB after verification, down from
42 GiB. Obsolete intermediate runtime builds and the temporary repair clone were
removed. Final test logs are in the ignored
`app/SiloUI/src-tauri/target/verification/storage-reclamation/` directory; private
build logs remain in the local temporary directory.

### Storage panel and history

The Storage panel uses a responsive grid of host allocation and guest usage measurements. Tooltips explain each metric. Refresh is an icon action; manual reclamation uses the shared indeterminate progress component because the runtime does not report a meaningful completion percentage.

Each sandbox retains its latest 50 reclaim attempts, newest first, in its existing atomic maintenance record. History starts collapsed and scrolls within a bounded area. Entries identify manual, scheduled, after-start and before-stop attempts, with measured reclaimed bytes or the recorded failure. An interrupted attempt retains an incomplete-operation error. Existing records preserve the previous successful reclaim as one legacy entry; older attempts cannot be reconstructed.
