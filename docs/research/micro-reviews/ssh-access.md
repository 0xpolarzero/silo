# SSH access micro-review

Scope: `app/SiloUI/src-tauri/src/ssh_access.rs`.

Read-only source review. Checked the first and second review reports in the main checkout and the local `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` reports for duplicates. No builds, tests, app launches, or live data access were performed.

## SSH-ACCESS-1: Missing private key prevents revocation of its persisted authorization

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/ssh_access.rs:820–826`; supporting code at lines 690–696 and 875–889.
- **Trigger:** Enable SSH and export the managed key. Remove its `ssh/managed-clients/<machine-id>` private file, then disable SSH using the keys returned by state and enable it again.
- **Evidence:** `managed_public_key` returns `None` when the private file is absent, and also suppresses public-key derivation errors. The disable branch uses `managed.as_deref().is_none_or(...)`, so `None` retains every untagged key, including the previously generated managed public key persisted in settings. Disabling then removes the remaining key files. Enabling generates a fresh key and appends it without removing the old persisted key.
- **Consequence:** Re-enabling authorizes both the new managed key and the supposedly revoked exported key. The implemented disable-and-rotate policy depends on retaining the private file needed to identify the old authorization.
- **Suggested fix:** Persist managed-key provenance or its public identity independently of the private file. Revoke that recorded identity on disable even when the private file is missing or unreadable; preserve unrelated user keys.
- **Test that would catch it:** Extend the existing disable/rotation fixture: retain the original managed public key, delete its private file, disable with the state-reported keys, and re-enable. Assert the old public key is absent from saved settings and the listener authorization file, the replacement differs, and unrelated user keys survive.

## SSH-ACCESS-2: Controller registration changes ownership of a user-added key

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/ssh_access.rs:763–769`; disable removal at lines 820–826.
- **Trigger:** A user has manually authorized a connecting computer's public key. That computer subsequently calls `ssh.access.connection` with the same public key and a valid controller ID.
- **Evidence:** When the tagged entry is absent, `authorize_controller` removes every entry whose normalized public key equals the supplied public key, regardless of whether it has a controller tag. It replaces the user's entry with a `silo-controller:<id>` entry. Disabling SSH then removes that entry through `is_controller_key`. The existing controller fixture uses distinct user and controller public keys, so it does not exercise this branch.
- **Consequence:** Registering a connection silently converts a user-owned authorization into a managed authorization. Disabling and re-enabling permanently loses the manually added key and its comment, contrary to the disable branch's stated policy that user-added keys survive.
- **Suggested fix:** Preserve an existing untagged authorization when the public key is already authorized. Only replace entries owned by that controller; represent multiple ownership explicitly if both need to be tracked while preserving public-key deduplication.
- **Test that would catch it:** Seed settings with a manually added controller public key and user comment. Register the same public key through `ssh.access.connection`, disable using state-reported keys, and re-enable. Assert the original user entry survives throughout, while a distinct controller-managed key is revoked.
