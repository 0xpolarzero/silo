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
