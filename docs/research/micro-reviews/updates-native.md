# Native update micro-review

Scope: `app/SiloUI/src-tauri/src/updates.rs` and `app/SiloUI/src-tauri/src/updates/`.

Read-only source review. No builds, tests, application launches, or live package operations were performed. The two main review reports and worktree `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` were checked; previously reported restart ownership (R-35) and frontend settings delivery (R-23) are excluded.

## UPDATES-NATIVE-1: Preference persistence and publication can disagree

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/updates.rs:300–307` (atomic file replacement at lines 104–108).
- **Trigger:** Two concurrent `set_update_automatic_checks` native invocations with opposite values. Request A persists `false` and pauses before `modify`; request B persists `true` and publishes `true`; A resumes and publishes `false`.
- **Evidence:** Each invocation runs on the blocking pool. `save_preferences` executes before acquiring the controller state mutex through `modify`. There is no native serialization covering both operations. The described interleaving leaves the JSON file at `true` and `snapshot.automatic_checks` at `false`, with both requests returning success. The current frontend provider serializes its own actions, so this finding concerns concurrent native callers, not a demonstrated ordinary toggle interaction.
- **Consequence:** The displayed preference and background-check policy disagree with the persisted preference. Restart re-enables network checks after the surviving snapshot reported them disabled.
- **Suggested fix:** Serialize preference persistence and snapshot publication as one native operation. Retain blocking-pool execution for filesystem synchronization and emit only the snapshot corresponding to the durable value.
- **Test that would catch it:** Use barriers between persistence and publication to overlap opposite native preference changes. After both complete, assert that the returned final snapshot, stored JSON, and freshly loaded preference agree. Assert the emitted final snapshot has the same value.

## UPDATES-NATIVE-2: Debian installation loses all monitoring deadlines after go-ahead

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/updates/debian.rs:93–107`, `115–127`; gates retained by `app/SiloUI/src-tauri/src/updates.rs:640–665`.
- **Trigger:** The helper emits `ready`, sandbox preparation succeeds, and the package-manager installation then stalls, for example in a system-configured dpkg/APT hook.
- **Evidence:** `prepare.take()` removes the condition selecting `recv_timeout`. Every subsequent progress read uses unbounded `lines.recv()`, followed by unbounded `child.wait()`. The root helper's `run` uses `subprocess.run` without a timeout (`app/SiloUI/scripts/debian/silo-system-update:48–50`); its installation command at lines 75–84 sets network and package-lock timeouts, not a deadline for package installation or hooks. While this wait persists, `install_debian` retains the admission write lock, backup/GitHub/secret guards, and computer-wide runtime gate acquired before stopping sandboxes.
- **Consequence:** The app remains in `installing` indefinitely with sandboxes stopped. Native writes are refused and computer-wide runtime operations, including normal shutdown, cannot acquire the gate. The preparation timeout provides no recovery once installation starts.
- **Suggested fix:** Add a monitored installation deadline and an actionable stalled-install state. Preserve package-manager ownership and unknown-outcome safety: do not blindly kill dpkg, resume VMs, release mutation guards, or offer reinstallation while installation can still be running. Provide a supported recovery/exit path and reconcile actual package state before normal operations resume.
- **Test that would catch it:** At the existing subprocess seam, emit `ready`, accept `install`, then block beyond an injected installation deadline. Require a bounded transition to an actionable stalled state and verify that ordinary shutdown does not silently wait forever. Release the fake installer and verify that success or failure is reconciled once, with no premature sandbox restart or duplicate installation.
