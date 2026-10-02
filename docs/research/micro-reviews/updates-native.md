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

## Fix-loop status

- UPDATES-NATIVE-1: Fixed by holding the controller state mutex across persistence, schedule changes, and event publication. The extracted production helper failed the concurrency regression before the fix and passed after it; the Cargo native test runs remain queued behind the shared artifact lock. Added a persistence-failure regression as well.
- UPDATES-NATIVE-2: Skipped. Safe remediation requires a package-manager ownership/recovery design and Linux qualification. Returning a timeout through the existing error path would restore sandboxes while dpkg could still be installing. The fix-loop instructions explicitly exclude large refactors and fixes requiring live qualification.

Preference-fix verification: the extracted production helper and scheduler passed 8 tests, including concurrency and failed-persistence regressions. `npm --prefix app/SiloUI run typecheck`, `npm --prefix app/SiloUI run lint`, `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check`, and `git diff --check` passed. Extracted tests compile against cached dependencies and use temporary files; they do not prove full application compilation or live update behavior. Native Cargo runs were requested with the shared target and synthetic GitHub configuration.

## UPDATES-NATIVE-3: A split UTF-8 character discards Debian update diagnostics

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/updates/debian.rs:155–161` before the fix.
- **Trigger:** A failed helper writes a log longer than 16 KiB, and the retained tail begins within a UTF-8 character.
- **Evidence:** The production subprocess fixture wrote a two-byte character followed by 16,383 ASCII bytes ending in a package-repair sentinel. Seeking to the last 16,384 bytes retained the second byte of the character. `read_to_string` failed; its ignored error left Details empty. The rejecting test failed because Silo returned the generic authentication/package-installation message without the sentinel.
- **Consequence:** Valid diagnostic text after the split character disappears, preventing the user from identifying the package repair error.
- **Suggested fix:** Read the bounded tail as bytes, propagate actual read failures, and decode with replacement for partial/invalid UTF-8.
- **Test that catches it:** `truncated_utf8_log_tail_preserves_package_manager_details` runs the real subprocess seam with that boundary and requires the package-manager sentinel to survive.
- **Status:** Fixed. The complete Debian module is compiled directly against cached `tempfile` and tested with local synthetic subprocesses. No administrator helper or package manager is launched.

Diagnostic-fix verification: the rejecting test failed before the change and all 7 Debian module tests passed afterward. Rust formatting, typecheck, lint, and diff whitespace checks passed. The tail read remains capped at 16 KiB.

## UPDATES-NATIVE-4: Closing progress output bypasses the preparation timeout

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/updates/debian.rs:94–109`, `139–140` before the fix.
- **Trigger:** The authentication/helper process closes stdout before emitting `ready` but continues running past the preparation deadline.
- **Evidence:** The subprocess fixture closes stdout and executes a two-second sleep with a 100 ms preparation deadline. Before the fix, channel disconnection breaks the timed receive loop and enters unbounded `child.wait()`. The rejecting test took 2.02 seconds and returned the wrong completion error instead of the timeout.
- **Consequence:** The advertised preparation timeout is bypassed; the caller retains admission, backup, GitHub, and secret guards while the process remains alive. Sandboxes are not stopped in this case. This is separate from the deliberately unbounded post-go-ahead installation in UPDATES-NATIVE-2.
- **Suggested fix:** Keep checking the original preparation deadline while waiting for a process whose progress pipe closed. On expiration, use the existing pre-install cancellation/reaping policy; retain post-go-ahead ownership semantics.
- **Test that catches it:** `a_closed_progress_pipe_does_not_bypass_prepare_timeout` requires the timeout result within one second and asserts sandbox preparation is never called.
- **Status:** Fixed and checked with the complete Debian module and synthetic subprocesses.

Closed-progress fix verification: the rejecting fixture failed before the change, then all 8 Debian module tests passed. Formatting, typecheck, lint, and diff whitespace checks passed. Earlier queued Cargo requests were stopped after verifying their executable command, owner, and exact worktree; one consolidated `cargo +1.94.0 test --manifest-path app/SiloUI/src-tauri/Cargo.toml --locked updates::` request remains queued against `/tmp/silo-codex-target` with explicit synthetic GitHub values.

## UPDATES-NATIVE-5: Repairing preferences leaves the startup read error visible

- **Priority:** P3.
- **Location:** `app/SiloUI/src-tauri/src/updates.rs:295–331` before the fix.
- **Trigger:** Start with corrupt update preferences, then successfully save automatic checks as disabled.
- **Evidence:** Startup stores the preference read failure in the error snapshot and disables checks. The save command persists the replacement and changes only the automatic-check flag and schedule, leaving the old error/phase intact. Disabled automatic checks never run a successful check to clear it. The temporary-directory regression repaired a corrupt JSON file but failed because the returned snapshot still contained the read error.
- **Consequence:** The card continues asking the user to save the preference again after that exact repair succeeded.
- **Suggested fix:** Clear the identified preference read error after successful persistence; preserve unrelated download/install failures and in-flight phases.
- **Test that catches it:** `saving_preferences_clears_the_read_error_but_preserves_update_failures` repairs a real corrupt preference file with checks disabled, requires an idle/error-free snapshot, then verifies a download failure survives another preference save.
- **Status:** Fixed.

Repaired-preference verification: the rejecting test failed before the fix, then all 9 extracted helper/scheduler tests passed. Formatting, typecheck, lint, and diff whitespace checks passed. Clearing is restricted to the identified preference read error in the error phase, so a preference save cannot reopen admission during an in-flight check or erase a download/install failure.

## Final verification and fold record

- UPDATES-NATIVE-1: fixed and folded, `6082fb69`.
- UPDATES-NATIVE-2: skipped for the ownership/recovery design and Linux qualification described above.
- UPDATES-NATIVE-3: fixed and folded, `f0512950`.
- UPDATES-NATIVE-4: fixed and folded, `a0af439c`.
- UPDATES-NATIVE-5: fixed and folded, `366470f7`.
- 9 extracted preference/scheduler tests and 8 complete Debian module tests passed; every added behavior regression failed before its fix. These used cached dependencies, temporary files, and synthetic subprocesses.
- Typecheck, lint, Rust formatting, and diff whitespace checks passed before each fix commit.
- Full native Cargo validation remained blocked on the shared artifact lock and was stopped after checking the exact executable command, user, and worktree. It did not compile or run tests. Earlier superseded queued requests were also stopped. No other agent process was interrupted.
- No application, real VM, package manager, production data, or credentials were exercised. The final scope pass confirmed the remaining post-go-ahead stall finding and found no further evidence-backed defect.

## UPDATES-NATIVE-6: Missing metadata silently retires update recovery

- **Priority:** P2.
- **Scope:** Adjacent `runtime/update_recovery.rs:250–257` and the metadata reader in `runtime.rs`.
- **Trigger:** An update resume journal exists, but `machines.json` is missing.
- **Evidence:** `resume_unless_removed` treats a missing metadata path as an absent sandbox and returns success. `restore_pending` then removes that identity and deletes the journal. The new temporary-directory regression failed because recovery returned success with no metadata.
- **Consequence:** The exact saved running set is discarded without evidence that those sandboxes were deleted. Restoring the configuration later cannot retry the lost update resume intent.
- **Correction:** Preserve the metadata reader's missing-file result for recovery. Ordinary first-launch reads still default to an empty configuration; update recovery requires a readable saved configuration before retiring an absent identity. This also avoids an existence-check/read race.
- **Regression:** `missing_metadata_preserves_the_update_resume_journal` requires an error and byte-identical journal preservation when metadata is absent, then installs a valid empty configuration and requires confirmed deleted entries to retire normally.

UPDATES-NATIVE-6 verification: the regression failed on the original recovery decision, then 6 extracted journal/metadata-decision tests passed, covering missing metadata, confirmed deletion, interruption, failed resume, consent, and an empty running set. Journal and metadata-reader functions are production source; runtime path/type/validation collaborators are disposable fixtures. Typecheck, lint, formatting, and whitespace checks passed. Full native `update_recovery::tests::` validation is queued with the shared target and synthetic GitHub configuration.


UPDATES-NATIVE-6 merge verification: retained the concurrent metadata reader's 1 MiB-plus-one-byte consumption limit. Seven extracted tests passed, including its child-process peak-memory regression against a sparse 128 MiB file. Formatting, typecheck, lint, and whitespace checks passed after resolving the merge. The complete earlier update audit trail was preserved.

## UPDATES-NATIVE-7: Update preferences allocate the complete input before rejection

- **Priority:** P2.
- **Location:** `updates.rs::read_preferences` before the fix.
- **Trigger:** A corrupted or externally edited update preference file grows well beyond the one-boolean schema.
- **Evidence:** The exact production reader consumed a sparse 128 MiB fixture. A child-process peak-RSS regression measured a 134,299,648-byte increase before rejection and failed its 32 MiB budget.
- **Consequence:** Startup allocates memory proportional to arbitrary file size before displaying the preference-read error; sufficiently large files can exhaust application memory.
- **Correction:** Use standard `Read::take` with the existing application settings convention of 1 MiB plus one byte, reject oversized files, and retain missing-file/default and malformed-file error behavior.
- **Regressions:** `preferences_large_input_memory_is_bounded` measures the real read in an isolated subprocess; `preference_size_limit_accepts_boundary_and_rejects_larger_files` accepts an exact-limit valid document, rejects one extra byte, and preserves the input bytes.

UPDATES-NATIVE-7 verification: the peak-memory regression failed before the fix and 12 extracted preference/scheduler tests passed afterward, including exact-limit preservation and previous preference repairs. Formatting, typecheck, lint, and whitespace checks passed. Full native validation remains queued on the shared artifact lock.

UPDATES-NATIVE-7 merge verification: retained concurrent additive-field preservation. Its save path reproduced a further 134,332,416-byte peak-memory increase while repairing the same sparse fixture. Reads and repair saves now share the bounded preference reader. A save that would grow a valid exact-limit document past the read limit fails before replacing it; its regression also failed before the writer check. Fifteen extracted preference/scheduler tests passed, including both concurrent additive-field regressions. Typecheck, lint, formatting, and whitespace checks passed after resolution.
