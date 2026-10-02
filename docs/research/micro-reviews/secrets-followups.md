# Secrets follow-up fixes

Scope: secrets storage and runtime integration, plus the secrets editor and assignment rows. Verification uses deterministic fixtures; no app, live VM, or credential store was used.

## SECRETS-3: Local secret assignments display a remote sandbox's identity and state

- **Priority:** P2
- **Location:** `app/SiloUI/src/features/application/components/secrets-management.tsx`, `SecretRow` workspace lookup.
- **Trigger:** A remote workspace precedes a local workspace with the same name in the application source, or only the remote row remains while local assignment metadata is stale.
- **Consequence:** The local secret assignment displays the remote computer's name and runtime state. It falsely identifies which computer owns the assignment; the backend assignment itself remains local.
- **Evidence:** Both new page fixtures failed with `dev · Office` where the assignment must display `dev`. The editor already excludes remote workspaces, and the native assignment validator accepts local VMs only.
- **Fix:** Resolve badges using the same local-VM boundary as the editor. With no local VM, retain the name-only fallback.
- **Regression:** Render a same-named remote before the local VM, then repeat without the local row. Assert the local runtime state or name-only fallback, with no remote computer badge.

## SECRETS-4: The editor accepts inputs that native validation always rejects

- **Priority:** P2
- **Location:** `app/SiloUI/src/features/application/model/secret-configuration.ts`, `secretConfiguration` value and collection validation.
- **Trigger:** Save a value larger than 65,536 UTF-8 bytes, a value containing a null character, or more than 100 sandbox assignments or domains. These violate the existing limits in `src-tauri/src/secrets.rs::validate`.
- **Consequence:** The editor submits a deterministic invalid request. The native controller refuses it, and `useSecretsManager` replaces the native validation message with a generic failure and Retry. Retrying the unchanged draft cannot succeed and gives no field-level correction.
- **Evidence:** Five model fixtures failed because the client produced no error for native-invalid inputs. The page fixture also called Save with a 65,538-byte replacement instead of preserving the editor with a value error.
- **Fix:** Apply the existing native byte and collection limits in the client. Count UTF-8 bytes rather than UTF-16 string length, and preserve the existing blank-replacement behavior.
- **Regression:** Test both new and replacement values, ASCII and multi-byte boundaries, and 100/101 collection entries. Render an oversized replacement in the editor and assert no save call, an actionable field error, focus on the invalid field, and the retained draft.

## SECRETS-5: Native capacity and deletion guidance becomes a generic Retry error

- **Priority:** P2
- **Location:** `app/SiloUI/src/features/application/components/secrets-manager.ts`, `operationFailure`.
- **Trigger:** A save returns either of the fixed public capacity or sandbox-deletion errors added by SECRETS-1/2.
- **Consequence:** The user sees only a generic Retry message. It hides the required capacity reduction or renewed sandbox selection; the unchanged draft still exceeds capacity, and a same-named replacement can make a later retry target a different sandbox.
- **Evidence:** Both page fixtures expected the exact public corrective message and received `Could not save this secret. Your changes are still here. Retry.`
- **Fix:** Allowlist the two fixed native messages alongside the existing credential-store guidance. Unexpected error text still uses the fallback and remains absent from the UI.
- **Regression:** Reject saves with each fixed message and assert its guidance and retained draft. Existing arbitrary-private-error tests must continue to pass.

## SECRETS-6: Exhausted reconciliation publishes an older result onto a newer generation

- **Priority:** P2
- **Location:** `app/SiloUI/src-tauri/src/secrets.rs`, `reconcile_with` retry limit and result publication.
- **Trigger:** Desired secrets change during each of the three permitted apply attempts. The third result belongs to an earlier desired revision, but the retry limit accepts it unconditionally.
- **Consequence:** An older success clears the newer generation's affected-workspace marker and errors even though that generation was never handed to apply. It can advertise completion and erase the newer save's failure state.
- **Evidence:** The fixture applied the initial value and rotations 1/2 while publishing rotation 3 concurrently. Before the fix, its expected `affected: ["dev"]` became `[]`; the unconditional success branch also removes the workspace's error.
- **Fix:** Carry the attempted revision with its outcome. Inside the document transaction, publish status only if that revision still matches. This also closes the deletion race between the last revision read and status persistence.
- **Regression:** Use the existing reconciliation seam with the in-memory vault, replace the desired generation during every apply, and record a newer failure on attempt three. Assert three attempts, the latest generation, and preservation of its affected workspace and failure.
