# EDITOR-7: literal percent signs in Linux editor entries

P2: GLib shell parsing leaves desktop-entry field-code escapes intact. Silo removed a standalone `%%` and passed embedded `%%` through unchanged, so an editor installed under `100%/code` was reported unavailable and percent-bearing data-directory arguments addressed a different directory.

The [Desktop Entry specification](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html) requires literal percent characters to be encoded as `%%` and field codes to expand only once. Decode `%%` after removing placeholders so an escaped `%%F` remains a literal `%F` argument.

The regression uses a temporary executable under a percent-bearing directory and asserts its actual received arguments, including a percent-bearing data directory, standalone percent and literal `%F`. It failed with “The selected editor is unavailable” before the fix. The whole production launch module is tested with a standalone Rust harness on macOS; this does not verify GIO integration on Linux or a live editor handoff. Evidence is under `/tmp/silo-codex-target/verification/editor/editor-7-before.log`.
