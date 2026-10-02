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
