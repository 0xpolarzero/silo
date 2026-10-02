# Guest scripts fix-loop follow-up

Scope: shell and Python guest scripts under `app/SiloUI/src-tauri/guest/`. The initial review remains in the shared micro-review worktree; follow-up findings and fixes are developed in `codex/fix-guest-scripts`.

## GUEST-SCRIPTS-3 — P3 — Inaccessible ancestors masquerade as missing folders

**Location:** `app/SiloUI/src-tauri/guest/list-directory.py:28–34` before this fix.

**Trigger:** A previously browsed workspace subdirectory still exists, but the working account no longer has search permission on its parent.

**Evidence:** A real temporary `private/child` directory with `private` chmod 000 produces `missing\0`, not `denied\0`, through the guest script's actual subprocess entry point. `os.path.exists` suppresses the permission error and returns false. The host maps `missing` to “This folder no longer exists.” Root bypasses this permission boundary, so the regression skips when run as root. The fixture ran as the ordinary local user and failed before the fix.

**Consequence:** The file browser misdiagnoses permission loss as deletion and gives the wrong recovery information.

**Suggested fix:** Inspect the directory with `os.stat`, distinguish permission denied, missing paths, and non-directory components, and retain the physical-cwd check against symlink traversal.

**Test that catches it:** Execute the unchanged guest entry point against a temporary child directory beneath a mode-000 ancestor. Require `denied\0`, restore permissions for cleanup, and keep existing missing/file/symlink cases passing.
