# Editor follow-up: control characters change folder identity

Scope: `app/SiloUI/src-tauri/src/editor.rs`.

## EDITOR-3

- **Priority:** P2.
- **Location:** `app/SiloUI/src-tauri/src/editor.rs:154`, `remote_uri`.
- **Trigger:** Open an existing folder whose name contains a tab, carriage return, or newline, such as `/workspace/a\tb`.
- **Evidence:** The original validator rejected NUL but accepted the other characters. Both `Url::set_path` and the path segment setter use the pinned `url` 2.5.8 parser, whose `ascii_tab_or_new_line_pattern!()` branch discards these characters (`src/parser.rs:1240–1251`). The [upstream parser source](https://docs.rs/url/2.5.8/src/url/parser.rs.html) confirms this behavior. Thus the URI addresses `/workspace/ab`, although the guest directory check receives `/workspace/a\tb`. The regression test failed against the original validator before the fix.
- **Consequence:** An editor opens the wrong existing directory or fails to find the selected directory. No live editor or VM was used to verify the downstream handoff.
- **Fix:** Reject ASCII control characters before URI serialization and report that the folder name is unsupported.
- **Regression:** `control_characters_cannot_change_the_requested_editor_folder` covers tabs, newlines, and carriage returns through validation and both editor URI schemes. The extracted production-function harness uses temporary homes and passed after the fix.

The original EDITOR-1 and EDITOR-2 audit remains in the shared micro-review worktree. Their fixes preserve unparseable workspace files with an actionable error and encode literal percent signs through path segments. Full JSON-with-comments parsing is deferred because the fix-loop instructions prohibit dependency changes; the data-loss fix does not claim that commented workspaces can be reopened through Silo.
