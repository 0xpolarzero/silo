# Settings fix-loop review

Scope: `app/SiloUI/src-tauri/src/settings.rs`.

The initial SETTINGS-1 and SETTINGS-2 audit remains in the shared micro-review worktree. Their fixes are folded as `565ed23b` (with test correction `18a0d1e8`) and `64a30575` respectively. This document records the additional finding from the continued scoped review.

## SETTINGS-3: Defaulted desktop policy bypasses malformed-draft protection

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/settings.rs:340`.
- **Trigger:** A saved onboarding VM contains `desktop: {}` or `desktop: {"builtIn": true}`, with no `startWithSandbox` field.
- **Evidence:** The native draft validator deserializes `DesktopConfiguration`, whose `start_with_sandbox` field defaults to true (`src-tauri/src/desktop.rs:11`). It keeps the original JSON rather than serializing that default. The frontend contract requires `startWithSandbox` (`src/contracts/silo.ts:36`); `src/desktop/settings.ts:15–20` therefore rejects the recovered draft and exposes null. A temporary-file regression confirmed that native loading did not set write protection. The regression failed before the boundary fix.
- **Consequence:** The application discards the draft at the frontend boundary without protecting the original file. Subsequent draft saves can overwrite the recovery data, despite the native store's policy of preserving malformed saved documents.
- **Suggested fix:** Require the desktop start policy at the recovery boundary while retaining the runtime configuration's existing default for its other callers.
- **Test that catches it:** Load each malformed policy from a temporary settings file, assert write protection and a save error, attempt another draft save, and verify the original bytes are unchanged. Assert that explicit true/false policies remain valid.

Verification uses synthetic data only. No application or VM was launched. Extracted Rust harnesses use the production persistence/validation/state code and actual desktop configuration type; native appearance and restart constants are stubbed. Native Cargo verification uses synthetic GitHub configuration, the shared target directory, and a test-only Tauri override disabling unstaged package resources.
