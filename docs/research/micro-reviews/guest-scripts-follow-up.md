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
