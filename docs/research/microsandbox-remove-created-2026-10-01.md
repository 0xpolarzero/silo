# MicroSandbox: removing a sandbox that never started

Draft of an upstream issue and pull request for
[superradcompany/microsandbox](https://github.com/superradcompany/microsandbox).
Nothing here has been published. The change is carried downstream as
`app/SiloUI/patches/microsandbox-remove-created-0.7.6.patch` (SHA-256
`18b5dd57f15175fc4eae5824690cb9c5246d919a7f3dacc781af87bfa1a1bdbf` (`d42071128d10d80c1b950aefbc3c673d1d2bf0115ef7534a9075c50cce83c355` as `-0.7.4.patch`)); how it is pinned,
built and verified is in
[Removing a sandbox that never started](../SiloUI-RUNTIME-PACKAGING.md#removing-a-sandbox-that-never-started-2026-10-01).

## State of upstream (checked 2026-10-01)

- The check is in `remove_local_persisted_sandbox`, `sdk/rust/lib/sandbox/mod.rs`. It reads
  `Stopped | Crashed` at v0.7.4 (`e36ffc0a`, lines 1739 and 1783), at v0.7.5 (published
  2026-09-30; lines 1742 and 1786) and on `main` (`09df3d4b`, the 0.7.6 version bump of
  2026-10-01; lines 1753 and 1797). No released version changes it.
- No issue or pull request mentions it. Searches of the repository's issues, pull requests and
  code for `Created` with remove, "never started" and "create without starting" found nothing
  relevant. The nearest open items are #1311 (conditional removal by sandbox incarnation) and
  #1687 (an ephemeral sandbox left `stopped` after a cancelled create); neither is about
  this check.
- The rest of the SDK already treats `Created` as removable. `SandboxHandle::remove`
  (`sdk/rust/lib/sandbox/handle.rs`) rejects only `Starting`, `Running`, `Draining` and
  `Paused`; `destroy_requires_stop` is false for `Created`; `has_active_runtime_state` is false
  for it. Only the helper both of them call is stricter, so a handle that passes its own check
  fails inside the helper.
- Upstream's own local code never writes `Created` at v0.7.4: the entity documents it as
  "Cloud-only today" and a local create inserts `Starting`. That is why the gap went unnoticed. Any code
  that creates a local sandbox without starting it (a downstream `--no-start`, as Silo's
  `create-stopped` patch adds) reaches it immediately.
- DeepWiki answers that removing a `Created` sandbox is allowed. That describes the
  handle-level check only; the helper's check is the one that fails (see the reproduction
  below).

## Issue draft

**Title:** `remove` refuses a persisted sandbox whose status is `Created`

**Version:** v0.7.4 (also v0.7.5 and `main` at `09df3d4b` by source).

**What happens.** `Sandbox::remove`, `SandboxHandle::remove`, `Sandbox::remove_persisted` and
`msb remove` fail for a sandbox that was prepared and never started:

```text
error: sandbox still running: cannot remove sandbox "e2e-created": status is Created
```

`msb remove --force` fails the same way (its kill step ignores its own errors and does not
change the status). `msb stop` leaves the status at `Created`. Nothing can move the sandbox to `Stopped`
without booting it, so its name, its directory and its disks stay until someone starts it.

**Why.** `remove_local_persisted_sandbox` accepts only `Stopped | Crashed`, in both its first
status check and the recheck under the lifecycle locks. `SandboxHandle::remove` runs just before
it and already lets `Created` through, and `destroy` skips its stop step for `Created`, so the
two entry points disagree with the helper they call. A `Created` sandbox has no run record, no
runtime process and no socket; the transition and lifecycle locks that the helper takes are
enough to make removing it safe.

**Reproduction.** Upstream cannot create a local `Created` sandbox, so the reproduction is a
unit test in `sdk/rust/lib/sandbox/mod.rs` next to `persisted_removal_rejects_a_stale_sandbox_identity`:
insert a sandbox row with `status: Created` and a private directory, then call
`remove_local_persisted_sandbox`. It returns `SandboxStillRunning("... status is Created")`
(see the pull request below for the test). With a build that can create a sandbox without
starting it (`msb create <rootfs> --name n --no-start`), `msb remove n` exits 1 with the message
above.

**Expected.** The sandbox's directory, socket artifacts and database rows are removed, as for a
`Stopped` sandbox, and every state that may have a runtime (`Starting`, `Running`, `Draining`,
`Paused`) is still refused.

## Pull request draft

**Title:** `fix(sdk): remove a sandbox that has never started`

**Summary.** `remove_local_persisted_sandbox` now accepts `Created` as well as `Stopped` and
`Crashed`. A `Created` sandbox was prepared and never started: it has no run record, runtime
process or socket, and `SandboxHandle::remove` and `destroy` already treat it as removable. The
two status checks (before and after the lifecycle locks) share one helper, `sandbox_status_allows_removal`,
so they cannot drift apart. The transition guard, the snapshot-lineage guard, the exact-identity
check (`SandboxReplaced`) and the lifecycle-lock recheck are unchanged, and `Starting`,
`Running`, `Draining` and `Paused` are still refused.

```rust
#[cfg(feature = "local")]
fn sandbox_status_allows_removal(status: SandboxStatus) -> bool {
    matches!(
        status,
        SandboxStatus::Created | SandboxStatus::Stopped | SandboxStatus::Crashed
    )
}
```

**Tests** (`sdk/rust/lib/sandbox/mod.rs`):

- `persisted_removal_removes_a_sandbox_that_never_started` removes a `Created`, a `Stopped` and
  a `Crashed` sandbox, each with a private directory and a label row, and checks that the
  directory, the sandbox row and the label rows are gone for all three. It fails on v0.7.4 with
  `SandboxStillRunning("cannot remove sandbox \"never-started\": status is Created")`.
- `persisted_removal_still_refuses_a_sandbox_that_may_own_a_runtime` checks that `Starting`,
  `Running`, `Draining` and `Paused` are refused with `SandboxStillRunning`, and that their
  directory and row are kept.
- The existing `persisted_removal_*` tests (stale identity, recycled PID, lineage lock) pass
  unchanged. The test module's `EntityTrait` import is no longer `cfg(unix)`, because the new
  tests use it on every platform.

**Test plan.** `cargo test -p microsandbox --lib persisted_removal`, `cargo fmt --all --check`.

**Why now / scope.** This does not add a create-without-start for the local backend (that is
the separate parity question noted in `SandboxBackend::create`); it only stops the removal
helper from being stricter than its callers. If a local create-without-start is ever added, or
a cloud-style `Created` row is ever migrated into a local catalog, removal already works.

## Open questions for upstream

- Is a local `Created` state meant to stay unreachable? If so the change is a consistency fix
  (the helper and its callers agree); if not, it is required.
- Should `msb remove --force` on a `Created` sandbox say that nothing was running, instead of
  staying silent about the ignored kill? Not changed here.
