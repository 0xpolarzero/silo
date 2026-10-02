# Silo computer-use review pass 3, 2026-10-02

Review in progress. This pass checks cancellation races, durable attempt markers, LCU upgrade and rollback, runtime identity, and the virtio-fs checkpoint device-state limits against the computer-use integration contract.

Initial revision: `f9421925`. Scope includes commits returned by `git log --since=2026-10-01`, with particular attention to `57d8b380`, `4d58e654`, `dd2b6d80`, and `b6354934`. Findings use CU-01 onward. The two existing reports were read from the main checkout; this report does not reproduce their ledgers. R-11 and R-15 are excluded because another agent owns their fixes.

Evidence will distinguish source confirmation from executed deterministic fixtures. No app launch, live VM, production state, runtime preparation, or network-heavy verification is authorized by the shared task instructions. Native tests use the shared `/tmp/silo-codex-target` and explicit synthetic GitHub configuration only.

## Findings

No new finding confirmed yet. This sentence will be replaced as evidence is collected.

## Verification

Pending focused regressions and source review. A unit fixture proves behavior with its supplied inputs; it does not establish live guest health or release readiness.

### CU-01. The checkpoint inventory cap omits unavailable captured transports

**P2, open; extracted predicate reproduced, complete restore source-confirmed.** In [the checkpoint patch](../app/SiloUI/patches/microsandbox-checkpoint-fs-state-0.7.6.patch), `max_virtio_fs_devices` counts current launch mounts, file mounts, owned volumes and backends. It passes that bound into `PreparedCheckpointRestore::open` before building the VM. A RAM checkpoint can also contain a captured external transport that has no current host mapping. The pinned runtime deliberately constructs `UnavailableFs` for that slot, preserving topology without granting access. The new cap omits that device.

**Trigger.** Restore a full checkpoint whose captured virtio-fs count exceeds the current-input bound because one or more captured resources are unavailable. The extracted production functions reject four captured devices against a bound of three (two internal devices plus one current bind mount). This fixture models an unavailable external file slot; it does not execute Silo or restore RAM. Redundant owned-volume counting can mask smaller differences in other configurations.

**Evidence.** Exact pinned upstream revision `09df3d4b9d832adaede1fb9a198cfc660bfab8cd`: `sdk/rust/lib/sandbox/external_mounts.rs` marks a resource unavailable when no mapping is selected; `crates/runtime/lib/runner/vm.rs:2044–2098` builds file inputs from captured bindings and creates an unavailable filesystem for absent mappings. The corresponding bind-mount path retains missing slots too. The local fixture extracts both new functions directly from the shipped patch. Output: `checkpoint names 4 virtio-fs devices but this sandbox has at most 3`.

**Consequence.** The new guard rejects a supported restore topology before the runtime can construct its denied-access placeholder. This is a regression in the bundled runtime restore contract. No ordinary Silo UI sequence or live restore was exercised; the exact trigger requires unavailable captured filesystem resources.

**Correction.** Compute the upper bound from the topology that `build_vm` actually constructs, including validated captured external slots. Keep the per-object and 64 MiB aggregate limits. Validate captured binding IDs/counts before using them as a bound; do not replace the guard with the untrusted device-reference count.

**Acceptance.** Restore a checkpoint with an intentionally unmapped captured bind/file resource: its slot remains and access fails with EIO, while valid mapped resources restore. Reject extra device references not backed by that validated topology. Include current owned volumes and backends, strict/relaxed external policy, and the aggregate budget. This correction changes a runtime boundary and needs upstream tests, so it is not a small Silo-only fix.

### CU-02. Interrupted LCU publication leaves subsequent upgrades stuck

**P2, open; actual upstream publication function reproduced with synthetic collaborators.** Silo's [guest installer](../app/SiloUI/src-tauri/guest/silo-computer-use.py) invokes the pinned LCU installer for the 0.8.1-to-0.8.2 upgrade. [LCU 0.8.2 `select_release`](https://github.com/0xpolarzero/lcu/blob/v0.8.2/scripts/install.py#L85-L114) creates `prefix/.next`, then replaces `prefix/current`. Its exception handler removes the new release but leaves `.next`; later attempts refuse any existing or dangling `.next`.

**Trigger and evidence.** Inject a publication error at `os.replace` after `.next` is created. The exact upstream function preserves the old `current`, removes the new release and leaves a dangling `.next`. An unchanged retry raises `Unexpected .next path; inspect the installation before retrying`. The diagnostic runs only `select_release` from the fetched v0.8.2 source; bundle verification and runtime validation are synthetic. It uses temporary directories and no app or guest. Killing the installer in the same publication window also skips exception cleanup; that cancellation case is source-confirmed, not executed.

**Consequence.** Boot and Set up computer use keep failing after the original storage error is gone. The old release can remain usable, but a VM cannot complete the pinned upgrade or approval setup through Silo's retry. Restoring Ask does not run `lcu setup` because installation fails first.

**Correction.** Fix LCU's publication transaction upstream: clean only the temporary link owned by a failed attempt, and recover an interrupted publication under the existing installer lock after validating the candidate and current links. Preserve the prior release. Silo should consume a verified release containing that fix; do not remove arbitrary guest paths to bypass the upstream refusal.

**Acceptance.** Inject failure and terminate an owned fixture installer between link creation and publication; retry must either safely recover or publish a fresh validated release. Keep the old `current` until success and reject unrelated `.next` paths. Test successful upgrade and rollback separately. This is an upstream installer defect, so no unverified Silo cleanup workaround was added.
