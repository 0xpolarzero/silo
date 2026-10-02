# GitHub frontend micro-review

Scope: `app/SiloUI/src/features/github/`.

Read-only source review; no npm, Cargo, builds, or tests run. Checked the first, second, and third-pass review documents for component filenames and related token findings; the finding below is distinct from R-19's failed credential persistence.

## FE-GITHUB-1 — P2 — Stale removal retry deletes a replacement token

- **File:line:** `app/SiloUI/src/features/github/components/personal-token-connection.tsx:31` (retry registration), `:23` (replacement success), `:27–30` (unguarded removal).
- **Trigger:** Removing token A fails and creates the persistent “Could not remove token” toast. Replace A with token B successfully, then click Retry on the earlier removal toast.
- **Evidence:** The failure toast retains `() => void remove()`. Successful save neither dismisses that toast nor invalidates its callback. `remove()` checks only whether `onRemove` exists; it does not check the token generation or an in-flight operation. `showActionFailure` in `src/lib/operation-toast.ts` gives the toast `duration: Infinity`. The production action (`src/desktop/production-source.ts:1751`) invokes `remove_github_personal_token` without a credential identifier. The native command (`src-tauri/src/github_personal_token.rs:344–354`) detaches token consumers and deletes the currently stored credential.
- **Consequence:** Retry for failed removal of A removes newly connected B and detaches token access from sandboxes. The toast can also invoke removal while replacement is busy because disabled component buttons do not guard its callback.
- **Suggested fix:** Invalidate and dismiss the removal retry when replacement starts or succeeds, and on component teardown. Route saves, removals, and toast retries through one synchronous in-flight guard; bind a retry to the credential generation it originally targeted so an obsolete callback cannot delete a replacement.
- **Test that would catch it:** Render the component with a Toaster; reject the first removal, replace the token successfully and rerender its connected status, then attempt the old Retry. Assert the old retry disappears or is inert and `onRemove` remains called once. Also retain the callback in a mock, start a deferred replacement, invoke it, and assert no concurrent removal occurs.
