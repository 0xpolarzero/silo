# GitHub native follow-up review

Scope: `app/SiloUI/src-tauri/src/github.rs`.

## GITHUB-NATIVE-3 — P2: Repository capitalization changes detach selected OAuth access

- **Location:** `app/SiloUI/src-tauri/src/github.rs`, `scopes`, formerly lines 1662 and 1670.
- **Trigger:** The saved policy selects `owner/project`; the refreshed authorized catalog reports `OWNER/Project` with the same repository and owner IDs.
- **Consequence:** Exact JSON string equality rejects the selection as no longer authorized. `narrow_checked` responds to the error by dropping all previous OAuth grants for that sandbox. Host push accepts the same name through its existing case-insensitive comparison.
- **Evidence:** The new `selected_scopes_preserve_access_when_catalog_capitalization_changes` test fails against the previous `scopes` implementation and passes with case-insensitive lookup. It preserves the selected write repository and excludes an unselected repository belonging to the same owner.
- **Suggested fix:** Compare both validation and selection lookup case-insensitively, while retaining canonical catalog owner names and numeric repository IDs.
- **Test:** The regression uses synthetic catalog/policy data and the production scope builder. No live GitHub account or VM was used.

GitHub's [Get a repository parameters](https://docs.github.com/en/rest/repos/repos#get-a-repository), checked 2026-10-02, explicitly define both owner and repository names as case-insensitive. This agrees with Silo's existing `push_authorized` and duplicate-selection validation.

## GITHUB-NATIVE-4 — P2: Narrowing waits for runtime work while holding the global policy lock

- **Location:** `app/SiloUI/src-tauri/src/github.rs:2008`, called under `STATE` at lines 1344–1351 and 3009–3018.
- **Trigger:** A sandbox already has an OAuth grant. Disable access or remove a repository while another operation holds that VM's operation gate, or while `msb modify` is slow.
- **Evidence:** The desired-state command retains its `STATE` guard across `narrow_now` and `narrow_each`. The latter synchronously calls `runtime::apply_github_policy`. `runtime.rs:2344` acquires the VM operation gate with a deadline based on `MUTATION_TIMEOUT` (180 seconds), then runs runtime commands. Other GitHub desired-state saves and browser cancellation also require `STATE`.
- **Consequence:** A narrowing attempt blocks GitHub policy changes and browser cancellation across all sandboxes while it waits for that VM. This is the slow-work lock boundary that `outside_state` already avoids for ordinary grant attachment.
- **Suggested fix:** Prepare revision-bound narrowing work under `STATE`, perform runtime work outside it, and publish active-grant changes only after rechecking the saved revision. Preserve immediate invalidation and retirement ordering across every caller and both authentication methods.
- **Test that would catch it:** Hold a fake VM mutation at a barrier, start narrowing, and verify that an unrelated policy save and browser cancellation finish before releasing the fake mutation. Release it and verify the latest revision remains applied and its removed tokens are retired.
- **Disposition:** Skipped in this micro-fix loop. Correcting the lock boundary requires a coordinated refactor of narrowing callers and cache publication; dropping the guard alone would introduce stale-authority races. Source-confirmed; no live VM reproduction was attempted.
