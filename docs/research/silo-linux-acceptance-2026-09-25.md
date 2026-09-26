# Linux acceptance evidence (2026-09-25)

## Environment and exact package

Qualification ran on the connected Ubuntu 26.04 x86-64 devbox, inside the
task-owned Ubuntu 24.04 x86-64 container. The container exposed KVM API 12 and
had a disk-backed build mount. This proves execution in that container; it does
not qualify an Ubuntu 24.04 host or Linux ARM64. The installed user Silo
process/state were not used. Build configuration was synthetic and
non-distributable; no real GitHub credentials were copied.

The final package was `/work/final-package-import-cold-start/Silo-x86_64.AppImage`
(211,974,648 bytes, SHA-256
`f3ed57daaeccc7237780f4b78399222e5805413367671194c9a7d714fd811a6c`). Its
AppDir payload was built from source binary SHA-256
`42b4a7bf4d3c7c3a66a47fe2702f2eb4da370d9f209a85e356d605dce65333c1`; linuxdeploy
changed the packaged binary's RUNPATH, so the packaged executable has a
different file hash. The exact final AppImage passed 10/10 production
WebKit/WebDriver smoke checks using `APPIMAGE_EXTRACT_AND_RUN=1`: onboarding
and IPC, dependency retry, workspace/GitHub/secrets/backup/settings routes,
inline secret validation, isolated XDG autostart enable/disable, and settings
persistence after a full app relaunch. Compact report, driver log, and two
screenshots are preserved in
[`appimage-smoke/`](../../app/SiloUI/src-tauri/target/verification/linux-acceptance-20260925/appimage-smoke/).

## Real VM lifecycle

The predecessor was created with shipped Silo 0.6.3 / MicroSandbox 0.6.17 and
its Ubuntu 24.04 v2 guest, then provisioned by the supported account migrator.
The stopped source had a real `silo` account (UID 1001), SFTP server, original
workspace disk and sentinel, and `silo.working-account=1`. This was a genuine
old-runtime fixture, not a 0.7 VM relabeled as legacy. The current app completed
the 1/1 migration and displayed the converted VM stopped. Explicit Start
restored the original workspace sentinel.

The real UI then created a full checkpoint and stopped fork. Tests confirmed
disk independence in both directions, a `/dev/shm` RAM marker and identifiable
guest process surviving fork/restore, recovery checkpoint creation, stopped
state across app relaunch, and source rollback of disk/RAM/process state. The
11 core checks are listed in the preserved lifecycle report; the report's
overall `passed` field is false because the subsequent archive action failed,
so only those listed assertions are claimed as passed. Evidence is
[`lifecycle-core.json`](../../app/SiloUI/src-tauri/target/verification/linux-acceptance-20260925/lifecycle-core.json).

The production archive export produced a valid v3 archive of 922,837,009 bytes
(880.1 MiB), SHA-256
`d759f814f90f15e5727f6fc75bb4fc9275fb7ce303dc41fef6f226e96f40a4be`. Production
import persisted a new stopped VM; explicit Start passed exact workspace-byte
and absence checks. The small migration screenshot is preserved as
[`imported-migrated-stopped.png`](../../app/SiloUI/src-tauri/target/verification/linux-acceptance-20260925/imported-migrated-stopped.png).
Archive export/import was exercised through production Tauri IPC, not through
the native GTK folder chooser.

The tested Silo flow's repeated export failed with
`snapshot identity snap_a6253d64fbdc953f3dfd3eb4d730a211 has 5 local copies; use
group:member or an explicit artifact path`. Inspection of pinned 0.7.2 source
is consistent with ambiguous parent-ID resolution, but this does not establish
an upstream contract violation. Silo creates each capture in a fresh export
group; the inspected resolver prefers a same-group parent before global lookup.
The qualification did not run an independent MicroSandbox-CLI-only
reproduction, establish the supported parent-locator contract, or inventory
the five copies. Earlier failed imports may have contributed duplicates, so
one clean import followed by a repeat export has not been proven to fail. The
release gate remains open for this Silo/MicroSandbox integration behavior; no
workaround was retained.

Live qualification also found and fixed defects in pending-restore recovery
forks, lifecycle lock contention, completed-generation backup-history
quarantine, 4 GiB legacy managed-root normalization, durable capture ancestry,
large snapshot-index output truncation, multi-member import head selection,
native snapshot selector validation, and disk-snapshot cold boot flags. Focused
Rust regressions passed for these changes. The archive repeated-export issue
above was unresolved at the time of this September 25 run; the later x86
same-home matrix passed, as recorded in the September 26 follow-up below. This
earlier run did not emulate an unsaved editor buffer or test ARM64 or an Ubuntu
24.04 KVM host.

After preserving the compact evidence above, the exact task container
(`0a6ddfce69bdf665af861e75ef8d182cd34fbf18195ab8fe6a0a84f6e7f80797`), its
dedicated dependency image (`25d2fa04c8027e3da220098abf24f68e285e7a0b661fb1de17e83e84f3091eaa`),
and bind-mounted task tree were removed. The tree measured 34,487,412 KiB before
deletion. Host free space rose from 17,608,646,656 to 58,055,655,424 bytes
(40,447,008,768 bytes net). Shared Ubuntu base images, installed Silo,
unrelated E2B data, and user state were left untouched.

## September 26 portability-fix build and pending live gates

A fresh Ubuntu 24.04.5 x86-64 guest on a KVM-capable host verified the Linux
AppImage packaging path. The final qualification AppImage is
`Silo_0.9.0_amd64.AppImage`, SHA-256
`f4ec0dafc7a9ab6a03b7c178b06f7a6154c266283ec3afe044642bd5a5a5d62d`. The
prepared runtime, AppDir, and extracted AppImage payload match for all six
runtime tools (MicroSandbox, libkrunfw, Git, Git LFS, and both Git remotes).
The extracted payload is retained at
`/work/evidence/final-appimage-payload/squashfs-root/usr/libexec/silo/tools`;
the package was built with task-only synthetic GitHub configuration and is
non-distributable.

The source-only archive failure was traced to the native VMDK descriptor, not
the Silo manifest: its `FLAT` extent lines embedded absolute paths into the
exporter's `MSB_HOME/cache/fsmeta` and `cache/layers`. `snapshot save
--with-image` included the descriptor, and native `snapshot load` copied it
unchanged. The seventh pinned MicroSandbox patch regenerates this derived VMDK
from validated destination extents while holding the existing cache lock,
keeps an identical warm descriptor, atomically replaces a stale descriptor,
and commits metadata last. Its focused native snapshot-artifact suite passed
63/63, including cold-cache, valid-warm, and stale-warm cases after source
cache removal. Patch SHA-256 is
`23b3b8e3cbc9ec20160306fd2aab5b196418efe132ed830e2e18738a89cfff57`; the
seventh runtime-input manifest and preflight updates are also retained in the
source tree.

The genuine x86 predecessor fixture is staged at
`/home/siloqa/silo-linux-legacy-x86-20260926`. It was created with patched
MicroSandbox 0.6.17 and the pinned Ubuntu 24.04 v2 amd64 image, provisioned
with the supported working-account migrator, and verified stopped with a real
`silo` account (UID 1001), SFTP server, and original workspace marker. Its
expected resources are 2 CPUs, 2048 MiB RAM, an 8 GiB managed root, and a 1 GiB
workspace. The corrected package previously imported the retained source
archive into a fresh XDG/MSB_HOME and registered stopped UUID
`d3a06dbe-f159-4eb7-8f08-d077e6e8cebf` with 2 CPUs, 2048 MiB RAM, a 40 GiB root,
and 20 GiB workspace. Its restored VMDK extents point into the new cache while
the old source fsmeta remains absent. Explicit Start succeeded, and the
`qemu-img` capacity check confirmed the restored root is 40 GiB. Compact
evidence is `production-import-started-capacity.json` in the isolated UI task
root.

The runtime-7 x86 AppImage used for the authentic migration and lineage run had
SHA-256 `f741e941c7d215835282ab7159b7ae32cef50bfba51311aceb5593ed9a4b1189`; its
bundled `msb` SHA-256 was
`ad5e94f8a29801cb7e5a25c363f2143755e08c7d7d1b98a42492b5882861a12a`. The
source used the original task-owned XDG root so its workspace mount stayed
within the source runtime. Production migration completed 1/1. The converted
VM appeared stopped in the real overview, and explicit Start/Stop preserved
`/workspace/sentinel` with bytes `legacy-source-before-checkpoint\n` and
UID:GID `1001:1001`.

The same-home lineage matrix passed: one seed export, exactly one import, one
stopped full-checkpoint fork, then two exports each from the original, imported
VM, and fork. All seven exports (including the seed) verified; the source,
import, and fork retained their authoritative groups across app relaunch and
preserved the expected 2 CPU / 2048 MiB / 8 GiB resources. `qemu-img` reported
a raw root virtual size of exactly 8,589,934,592 bytes for all three VMs.
Compact results are in
[`snapshot-groups-result.json`](../../app/SiloUI/src-tauri/target/verification/x86-legacy-final7-matrix-20260926/evidence/snapshot-groups-result.json);
the migration journal is in the same evidence tree at
`xdg-data/org.silo.preview/runtime-migration.json`.

The production lifecycle assertions passed through migration overview,
explicit start, checkpoint/fork/restore, RAM marker and process restoration,
disk independence, and post-relaunch recovery. The final helper then hung at a
GTK chooser interaction; this is not a product failure and does not revoke the
separate native folder-picker pass documented below. The guest-script stale
X11 recovery fix passed 35 focused tests. A backup canonicalization regression
was also fixed: it now accepts and clears a validated transient interface
`ipv6_address` while retaining the rest of the runtime policy; the focused
backup suite passed 12 tests with 1 ignored.

The final eight-patch runtime and AppImage also passed ARM64 packaging and live
port-control qualification. The AppImage SHA-256 is
`4c6aee7c1352611ee931ca2a747186e88c7ebe58d09c31aaa4a15b93ec3c8ae3`; its
tested `msb` SHA-256 is
`f552ad75296c8964b7ed974e1fafac2533374e4caefe2c09dc34321c250ba06b`. The
runtime-input manifest SHA-256 is
`be2b4f29fb21faf08df79ddae12c5b070b762f7ad79588fe07b0d4dd8efc35fd`. Live
tests proved positive and denied probes, absent-service handling, the 128-port
limit, occupied-port mapping preservation, established-relay closure on remove,
and immediate exact-port reuse with traffic. Evidence is retained under
[`native8-live-ports/`](../../app/SiloUI/src-tauri/target/verification/native8-live-ports/).
The first x86 runtime-8 transfer request was rejected by automatic review.
After the user explicitly approved the named patch and manifest transfer, the
same transfer succeeded. The final x86 build, package smoke, and native live
port-control test passed; the exact artifacts and evidence are recorded below.

## September 27 desktop-session and remote-stream follow-up

The Linux desktop session proof now covers unsaved editor state across a full
checkpoint, fork, and source restore. Mousepad contained the unsaved draft
`SILO_UNSAVED_DRAFT_UI_1790456678` while the saved file still contained the
baseline. Full checkpoint `c42c2eb0bd2284a8ab6fa1250763eb36` captured the draft;
stopped fork `54e8b201-7e30-44e1-b866-855b23fb7d4a` restored it on explicit
Start. Restoring the source through recovery checkpoint
`cd898861f17ab4870be24f8ef96014c5` and explicitly starting it also recovered
the draft, with the saved baseline unchanged. Evidence is in
[`x86-final-desktop/`](../../app/SiloUI/src-tauri/target/verification/x86-final-desktop-20260927/)
(`silo-live-viewer-unsaved.png`, `silo-fork-viewer-restored-unsaved.png`, and
`silo-source-viewer-fresh-after-restore.png`).

The restored desktop initially failed to start because its saved `/tmp` state
contained a dead X1 lock/socket pair. The service now normalizes the X11 socket
directory only before a new desktop start, and only after verifying that no
display listener or live lock PID exists and that the directory contents are
limited to the expected stale pair or are empty. The final x86 package
`069d16d9d0ce216d5a1e73f6888ce8011fb1a03003d448c04c98b41b4ab57f7c` passed the
live recovery: the dead-PID pair was replaced, `/tmp/.X11-unix` became
root-owned mode 1777, and port 6901 listened. The installed guest service
matched source SHA-256
`735bd1ee3acda327c46fe031953f2e399d8f3c9a9a1008a234f08e6d7de035dc`. Compact
evidence is [`live-stale-x11-recovery.json`](../../app/SiloUI/src-tauri/target/verification/x86-final-desktop-20260927/live-stale-x11-recovery.json).

The remote SSH bridge stall had two buffering defects: the framed success
response and short binary chunks in the raw stream were not flushed while the
stream remained open. Focused regressions failed before and passed after the
fixes; the remote stream suite passed 5/5. A production remote viewer then
connected to the running task VM over authenticated SSH, and a stopped fork
refused connection without auto-starting. The live proof used the prior x86
package with the same final remote-stream source; evidence is in
[`remote-final/`](../../app/SiloUI/src-tauri/target/verification/x86-final-desktop-20260927/remote-final/).

The final x86 runtime-8 AppImage is retained locally as
[`Silo_0.9.0_native8_final.AppImage`](../../app/SiloUI/src-tauri/target/verification/native8-final-package/Silo_0.9.0_native8_final.AppImage),
SHA-256 `58a0516b396632390b9637966219ff732b577810fcf18483dcc9cbb1409d804a`.
Its extracted app executable is SHA-256
`e2d23bb113a5d10f7ddf93d89b95a5cc3e6bf4839a31e2316dd8385628a6cad0`,
and its bundled native `msb` is SHA-256
`285d0bb9a67dcef45e78fe4e4f2bc1608fa4ae6e3532053461c54a8878be2fe2`.
The eight-patch runtime manifest, bundled Git and libraries, five protocol
probes, and dependency checks passed; the compact
[`package-smoke.json`](../../app/SiloUI/src-tauri/target/verification/native8-final-package/package-smoke.json)
is SHA-256 `d7b44744a6b363237293a6182d4b39784fccfc0390c08f4f785ba265baf68d04`.
The same native binary passed x86 live port-control tests in an isolated home;
[`x86-live-ports.json`](../../app/SiloUI/src-tauri/target/verification/native8-live-ports/x86-live-ports.json)
is SHA-256 `b6991e628ae18875057dac7c043caace1f6c357bad145f052137c2312d29935d`.
The final x86 package was smoke-tested, while the earlier package supplied the
live migration, desktop, and remote-viewer behavior proofs. After all gates
passed, the two named devbox task containers and bind directories were removed;
the final package, source changes, and compact evidence remain local.
