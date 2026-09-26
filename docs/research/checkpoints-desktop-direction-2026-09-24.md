# Silo checkpoints and desktop direction

Date: 2026-09-24. Research and recommendation in response to the user's proposed
direction. No runtime upgrade, VM operation, desktop selection or implementation
was performed. This supplements the [E2B assessment](e2b-adoption-assessment-2026-09-24.md).

Follow-up, 2026-09-25: the user accepted manual checkpoints, recovery-protected
restore, independent forks and inheritance of current assignments. Forks must
start stopped and require explicit Start. The
[implementation plan](../SiloUI-CHECKPOINTS-PLAN.md) records these decisions and
the proposed pending-restore lifecycle; it does not report an implementation pass.

Keep Silo and first qualify an upstream MicroSandbox upgrade for checkpoints and
forks. Retain the existing Ubuntu desktop as a comparison baseline while selecting
the remote display stack with the forthcoming LCU integration. Do not build a
snapshot engine or choose a distribution from desktop testimonials.

## Correction to the earlier comparison

The earlier assessment correctly described **Silo's pinned 0.6.17**, but did not
evaluate a newer MicroSandbox release as a fourth option. That omission matters:
[v0.7.2](https://github.com/superradcompany/microsandbox/releases/tag/v0.7.2),
published September 17, already advertises live branches and full snapshots in its
[tagged README](https://github.com/superradcompany/microsandbox/blob/v0.7.2/README.md).
The project still identifies itself as beta. This is an upstream implementation
to qualify, not evidence of a Silo pass or a promise of an uncomplicated upgrade.

The tagged [snapshot guide](https://github.com/superradcompany/microsandbox/blob/v0.7.2/docs/sandboxes/snapshots.mdx)
documents disk/memory/execution capture, live branching, and private writes with
shared memory on supported Linux and macOS hosts. It also covers incremental
exports and disk-chain compaction. Host connections require reconnection, external
bind mounts remain dependencies, and full restore requires compatible execution
settings. These are not exclusive E2B capabilities compared with current upstream.

This is more than a planned API. The tagged
[capture implementation](https://github.com/superradcompany/microsandbox/blob/v0.7.2/sdk/rust/lib/backend/local/snapshot/create.rs)
contains full capture, staging, immutable group publication and source-recovery
reporting. The [restore implementation](https://github.com/superradcompany/microsandbox/blob/v0.7.2/sdk/rust/lib/backend/local/snapshot/restore.rs)
constructs child-owned storage, private writable disk heads and a runtime restore
configuration. This source inspection is not an audit of the entire hypervisor or
a durability test.

Silo's actual packaged version remains documented in
[runtime packaging](../SiloUI-RUNTIME-PACKAGING.md). Its patch, archive handling,
workspace disk, secrets, SSH publication and native signing must be reconciled
with the upgrade. Do not apply the old patch mechanically or upgrade user data
in place during qualification.

## Checkpoint scope and acceptance

Use three distinct product operations: checkpoint a recoverable state, fork an
independent workspace, and export a portable recovery copy. Keep their storage
and recovery promises visible. A live branch is not itself a retained recovery
point. An external API side effect cannot be rolled back by restoring a VM.

[Btrfs snapshots](https://btrfs.readthedocs.io/en/latest/Subvolumes.html) share
filesystem blocks and can reduce disk-copy costs. They neither capture RAM/vCPU
state nor provide a separate backup. Nested subvolumes are not captured
recursively. Recommendation: use the runtime's existing snapshot machinery first;
do not change Silo's filesystem just to obtain VM snapshots. A guest filesystem
and the macOS host filesystem are different storage layers.

The initial qualification should establish:

1. **Actual state continuity.** Use an unsaved editor buffer, an in-memory process
   marker, root-disk data and workspace-disk data. Capture and fork; prove that
   the source continues and each child's subsequent memory/disk changes are
   independent. Saved files alone cannot prove a full checkpoint.
2. **Recovery.** Resume a saved checkpoint after owner/app and host restart.
   Interrupt capture and restore, exhaust disk space in isolated test storage,
   and verify that errors preserve an identified usable source or recovery
   artifact. Reuse the E2B failure oracles instead of accepting another happy path.
3. **Fork authority.** Allocate fresh Silo workspace identity, access endpoints,
   viewer sessions and current credential grants. A restored snapshot must not
   revive a revoked grant. Define what happens to copied browser logins and
   other credentials deliberately present in guest state; an API-token proxy
   cannot remove them from RAM snapshots.
4. **External effects.** Test reconnecting browser/SSH/PTY clients. Define how
   duplicated agents and services are prevented from immediately performing the
   same external work. Shared host folders need explicit semantics and cannot
   silently be presented as independent forked files.
5. **Storage and compatibility.** Measure physical disk and resident RAM after
   repeated checkpoints and divergent forks. Verify deletion, dependent-state
   retention, compaction, export/import and safe recovery across supported
   runtime updates. State which host/CPU combinations can resume memory.
6. **Existing Silo behavior.** Recheck secrets and active revocation, workspace
   storage, local/remote ownership, SSH/editor access and the packaged app on
   supported Mac and Linux targets. Resolve old runtime patches against upstream.

These are proposed acceptance requirements, not newly observed defects in 0.7.2.
No measured claim about upgrade performance or reliability is made here.

## Desktop suggestions and their actual roles

| Suggestion | Primary-source finding | Silo assessment |
| --- | --- | --- |
| CachyOS | Its [overview](https://wiki.cachyos.org/cachyos_basic/why_cachyos/) emphasizes an Arch rolling release, optimized x86 packages and a tuned kernel. Its [installation guidance](https://wiki.cachyos.org/installation/installation_prepare/) recommends bare metal over VMs. | Do not select it as the default. Silo currently supplies its own guest kernel through libkrunfw, so replacing userspace does not import CachyOS kernel tuning. An officially supported ARM64 guest path and a measured improvement would be needed. |
| Bluefin | Its [administration guide](https://docs.projectbluefin.io/administration/) uses bootc OS deployments and rollback, and recommends Flatpak, Homebrew and containers instead of changing the base OS. Its [installation guide](https://docs.projectbluefin.io/installation/) lists generated ARM images with a lower support tier. | Worth studying for reproducible images and updates. Its whole-OS boot/update model requires separate integration work; importing its userspace as an OCI root does not prove that model works in Silo. It is not a remote-viewer solution. |
| waypipe | The [Wayland project](https://wayland.freedesktop.org/faq/) describes application forwarding between Wayland environments. | Useful candidate for native application forwarding. It does not supply Silo's embedded full-desktop viewer. A Mac deployment needs an additional compatible compositor/client. |

Mac compositor projects exist, including the explicitly described
[wayland-macos proof of concept](https://github.com/lucsoft/wayland-macos).
Thus “impossible on macOS” would be wrong. Selecting one adds another dependency
and qualification scope; it does not establish a ready replacement for the
current Tauri viewer.

Keep Ubuntu as the measured control, not as an irrevocable distribution choice.
Decide the desktop session, display protocol, transport and LCU compatibility
together. Later visual polish is reasonable; postponing this compatibility proof
until after storage work is not. Assess text clarity and scaling, keyboard layouts
and IME, clipboard, focus/drag/shortcuts, reconnect, human takeover, and local/remote
latency. Measure CPU rendering and any acceleration available in the actual VM.
If audio or multi-monitor support is required, establish that before selecting a
transport. The [existing desktop comparison](../SiloUI-DESKTOP-SELECTION.md)
already provides candidates and a test rubric, not a measured winner.

LCU is the requested computer-use layer and remains under refinement. Do not
infer its future Wayland compatibility from the old Luda integration. The
contract to prove is one shared user session, consistent screenshot/input
coordinates and accessibility, exclusive control handoff, cancellation, and
session reconnection after restore or fork. Silo should reuse LCU's implementation.

## Other useful product additions

Prioritize prepared, versioned desktop templates; explicit hibernate/resume;
reusable checkpoint-derived workspaces; and reliable lifecycle progress and
reconnect behavior. Evaluate automatic idle suspension only as an explicit
policy. These benefits do not require reproducing E2B's entire control plane.

Retain MicroSandbox's built-in credential proxy as the upgrade baseline. Its
[0.7.2 secret contract](https://github.com/superradcompany/microsandbox/blob/v0.7.2/docs/sandboxes/secrets.mdx)
provides host-side substitution. Reconcile Silo's policy/connection patches
against that release and qualify restored/forked authority. The
[broker comparison](e2b-credential-tools-2026-09-24.md) answered the E2B fixture
replacement problem; no benefit from adding iron-proxy to retained MicroSandbox
has been established. Use that research only if a concrete upstream gap remains.

**Next action:** qualify a pinned upstream MicroSandbox release in an isolated
checkpoint/fork experiment using Silo's actual root/workspace storage and failure
oracles, before implementing the checkpoint UI or choosing a new distribution.
