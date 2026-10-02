# GitHub native micro-review

Scope: `app/SiloUI/src-tauri/src/github.rs`.

Read-only source review. Checked the initial, pass-2, and pass-3 review reports for duplicates. No builds, tests, app launches, credential-store access, or live GitHub requests were performed.

## GITHUB-NATIVE-1 — P2: Targeted retry loses another sandbox's pending grant

- **Location:** `app/SiloUI/src-tauri/src/github.rs:3092` (also 1232–1245, 1362–1368, 1414–1463).
- **Trigger:** In the current app session, sandbox B has a newly saved access choice in `access_pending` while `refresh_at` remains in the future. Before the worker applies B, retry sandbox A with `workspace: Some("A")`. `mark_pending` replaces the pending list with all sandbox names, then `retain` reduces it to A, discarding B's existing pending intent.
- **Evidence:** The scheduled worker applies all policies. For B, `access_update_due` returns false because B is no longer pending, the session matches, and the refresh deadline has not arrived. With no previous access error, the skipped access branch returns `Ok(())`; the worker replaces B's operation with `succeeded` even though its new access was never applied. At subsequent deadlines, that succeeded operation suppresses reconciliation unless B has an expiring previous grant. If B previously had no grants, the new grant remains unapplied indefinitely during this session.
- **Consequence:** A retry on one sandbox can silently strand another sandbox's saved repository access and report it verified. Relaunch or another policy edit can recover it.
- **Suggested fix:** Preserve existing `access_pending` entries and add the requested retry target. Update operation state only for retry targets and existing pending work; do not mark unrelated skipped access as verified.
- **Test that would catch it:** Seed the current session with B's new nonempty repository policy, B pending, no prior B grants, no B error, and a future refresh deadline. Queue a retry for A before reconciliation. Assert B stays pending, receives its grant in the next worker pass, and cannot report success before attachment.

## GITHUB-NATIVE-2 — P2: Host push issues authority after Disable access completes

- **Location:** `app/SiloUI/src-tauri/src/github.rs:2100` (also 2059–2071 and 2864–2875).
- **Trigger:** Begin OAuth host-push credential acquisition with access enabled and a write-authorized repository. Hold its catalog request after the initial policy checks. Complete `set_github_access_enabled(false)` or remove that repository's write permission, then let credential acquisition continue.
- **Evidence:** `host_push_credential` holds `OPERATION`, reads the document once, and authorizes from that snapshot. Disable and policy saves take `STATE`, not `OPERATION`, so they can persist and narrow access during the catalog request. Credential acquisition neither reloads the document nor checks its revision before or after `Operation::Scope`; it returns the newly minted write credential. The caller in `host_push.rs:734–760` proceeds to push with it without another GitHub-policy check. Narrowing operates on guest attachments, not this host credential.
- **Consequence:** A host push still acquiring authorization can receive and use fresh write authority after the user successfully disables access or removes its write grant. The token remains bounded by expiry and end-of-push revocation; no permanent authority is claimed.
- **Suggested fix:** Revalidate the saved access choice under `STATE` before issuance and after the network response. If authorization changed while issuing the token, revoke the returned token and reject the push. Make the successful credential handoff ordered with policy changes.
- **Test that would catch it:** Barrier a synthetic catalog/scope adapter during acquisition, complete Disable access, and release the adapter. Assert acquisition rejects, any minted token is revoked, and the host push executor never receives credentials. Repeat with removal of the repository's write grant.
