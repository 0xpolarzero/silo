# Guest scripts fix-loop follow-up

Scope: shell and Python guest scripts under `app/SiloUI/src-tauri/guest/`. The initial review remains in the shared micro-review worktree; follow-up findings and fixes are developed in `codex/fix-guest-scripts`.

## GUEST-SCRIPTS-3 — P3 — Inaccessible ancestors masquerade as missing folders

**Location:** `app/SiloUI/src-tauri/guest/list-directory.py:28–34` before this fix.

**Trigger:** A previously browsed workspace subdirectory still exists, but the working account no longer has search permission on its parent.

**Evidence:** A real temporary `private/child` directory with `private` chmod 000 produces `missing\0`, not `denied\0`, through the guest script's actual subprocess entry point. `os.path.exists` suppresses the permission error and returns false. The host maps `missing` to “This folder no longer exists.” Root bypasses this permission boundary, so the regression skips when run as root. The fixture ran as the ordinary local user and failed before the fix.

**Consequence:** The file browser misdiagnoses permission loss as deletion and gives the wrong recovery information.

**Suggested fix:** Inspect the directory with `os.stat`, distinguish permission denied, missing paths, and non-directory components, and retain the physical-cwd check against symlink traversal.

**Test that catches it:** Execute the unchanged guest entry point against a temporary child directory beneath a mode-000 ancestor. Require `denied\0`, restore permissions for cleanup, and keep existing missing/file/symlink cases passing.

## GUEST-SCRIPTS-4 — P2 — Empty accessibility roots starve later applications

**Location:** `app/SiloUI/src-tauri/guest/silo-accessibility.py:135–153` before this fix.

**Trigger:** Responsive application roots with no children consume the six-second sweep budget before an application with web content. Empty roots are neither handled nor hung, so they are polled again at the front of every sweep.

**Evidence:** The actual worker and `poll_application` run against a synthetic bus and deterministic clock: 21 empty roots take 0.3 seconds each, below the slow-call threshold; the final application has one child. Across four sweeps the final application receives no accessibility requests. No bus or desktop is launched. Existing handled-root and hung-root cooldown controls pass before and after the fix.

**Consequence:** Applications later in the desktop enumeration never receive the property requests this helper uses to enable their web accessibility. Waiting or faster sweep intervals do not recover them while the earlier roots persist.

**Suggested fix:** Start the next sweep at the first application deferred by the budget, while still discovering all present identities for handled/cooldown cleanup. Preserve timeout and cooldown policies.

**Test that catches it:** Run the real worker for four virtual sweeps with the roots described above; require the final application to be touched once, and confirm successfully handled roots remain skipped and hung roots retain their cooldown.

## GUEST-SCRIPTS-5 — P2 — Stop forgets descendants of an exited group leader

**Location:** `app/SiloUI/src-tauri/guest/desktop-service.py:515–521`, `:651–660` at revision `3f9db64c`.

**Trigger:** A managed process-group leader exits before Stop, leaving a descendant in its original group. A session launcher or streamer can spawn descendants; the recorded process is only the leader.

**Evidence:** The actual `stop_managed_child` ran on macOS against an owned Python fixture group. The parent created a child in its group and exited; the controller waited for the parent, verified the child's group, and called the helper. Output: `leader_exited=True, owned_descendant_survives_stop=True`. The controller then sent SIGTERM only to its verified fixture descendant and observed its cleanup acknowledgement. No guest, real desktop process, app, or VM was involved. Linux guest cleanup remains unqualified.

**Consequence:** `stop_managed_child` skips all signalling when `poll()` reports an exit. `stop_selkies_processes` then clears the ownership records and publishes `stopped`, although descendants can retain processes or session resources. This is separate from failing to reap the leader; the session-recovery fix reaps leaders but does not establish descendant cleanup.

**Suggested fix:** Preserve verifiable ownership of the complete process group through leader exit and bounded cleanup, using supported process-lifecycle facilities. Retain evidence of unresolved owned descendants instead of clearing the records and reporting stopped. Do not merely remove the `poll()` guard and signal a possibly reused numeric PGID.

**Test that catches it:** Start an owned fixture leader that spawns a descendant holding a listener, exit the leader, and invoke Stop. Require the descendant and listener to disappear within a deadline while an unrelated fixture survives. Include graceful leader exit, leader crash, cleanup timeout, and PID/PGID reuse rejection on Linux.

**Status:** Skipped in this bounded fix loop. Safe correction requires a process-group ownership change and Linux process-lifecycle qualification, rather than a local guard edit.

## Fix and verification ledger

- GUEST-SCRIPTS-1: fixed and folded in `fb8bda4e`; regression drives the actual computer-use session-repair loop through desktop Start, preserves healthy/starting sessions, and checks reaping during supervision.
- GUEST-SCRIPTS-2: fixed and folded in `bedcdfc0`; regression runs Selkies supervision with repeated output through an existing append descriptor and verifies bounded retained tails.
- GUEST-SCRIPTS-3: fixed and folded in `178b54f9`; a real temporary filesystem permission regression fails before the fix and passes afterward.
- GUEST-SCRIPTS-4: fixed and folded in `a248ed84`; deterministic worker regressions cover deferred applications, handled roots, and hung-root cooldowns.
- GUEST-SCRIPTS-5: skipped as described above; the owned-process fixture confirmed the cleanup gap and acknowledged fixture teardown.

Each fix includes a patch changeset. Rust formatting, Node 24.11.1 typecheck, lint, and diff whitespace checks passed for the implementation commits. The combined six-module guest-helper suite passed 152 tests on Python 3.12.9, with one skip because the macOS filesystem refuses non-UTF-8 filenames; that behavior also has a deterministic fake-entry test. Failing and passing diagnostic output is retained under `/tmp/silo-codex-target/verification/guest-scripts/`. These fixtures establish the stated seams, not live Linux VM health or release readiness. No app or VM was launched.

## GUEST-SCRIPTS-6 — P2 — Log retention traverses directory links

**Location:** `app/SiloUI/src-tauri/guest/desktop-service.py`, `trim_logs` (lines 1045–1058 before this fix).

**Trigger:** The configured home or its `.vnc` directory is a symbolic link, and the target contains a `.log` file larger than 1 MiB.

**Evidence:** Real temporary-directory fixtures for both a linked home and a linked `.vnc` directory were truncated from 1.75 MiB to 256 KiB by the actual helper. The existing `O_NOFOLLOW` protected only the final log filename; `HOME.glob` and the subsequent absolute open traversed linked directories. Both accepting assertions failed before the fix. This is guest data integrity, not a claimed host escape or a privilege boundary against agents with guest sudo.

**Consequence:** Periodic desktop log retention modifies files reached through directory links, contrary to its no-follow policy.

**Suggested fix:** Open the home and `.vnc` with `O_DIRECTORY | O_NOFOLLOW`, enumerate through the opened directory, and open log basenames relative to that descriptor with `O_NOFOLLOW`. Close all descriptors on success and error; preserve regular log tail retention.

**Test that catches it:** Link either the home or `.vnc` to a temporary directory containing an oversized sentinel `.log`; its original bytes must remain unchanged. Keep regular-log retention, leaf-link rejection, and open-append-descriptor tests passing. Replace the directory pathname with an external link between enumeration and opening the log; retention must stay anchored to the original directory and preserve the external sentinel.

The broader guest-helper and shell-recipe suite passed 179 tests on Python 3.12.9 with the same one filesystem skip. After the directory-link fix, the six helper modules passed 160 tests, and all four targeted retention tests (including directory replacement after enumeration) passed. All four shell scripts passed `sh -n`, and all seven guest Python scripts passed Python 3.12 syntax parsing. GUEST-SCRIPTS-6 is fixed in the accompanying commit; the separate GUEST-SCRIPTS-5 ownership redesign remains skipped.
