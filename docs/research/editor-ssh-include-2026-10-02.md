# Editor follow-up: literal directories in SSH Includes

Scope: `app/SiloUI/src-tauri/src/editor.rs`, `include_line`.

## EDITOR-6 · P2

- **Trigger:** A directory in the host runtime path contains glob syntax, such as `home[1]`, `home?`, `home*`, or a literal backslash.
- **Evidence:** The original helper quoted the path for SSH configuration syntax but left its directory components unescaped for glob expansion. [OpenSSH Include](https://man.openbsd.org/ssh_config#Include) expands wildcard pathnames even when they were quoted for parsing. A temporary `home[1]/ssh/dev.conf` containing the expected Host entry was ignored by `/usr/bin/ssh -G -F <fixture config> silo-test-dev`. The failing regression output is retained under `/tmp/silo-codex-target/verification/editor/editor-6-before.log`.
- **Consequence:** Editor aliases do not resolve to their configured VM when OpenSSH fails to match the literal directory, or another matching directory's configuration is read instead. The local preflight passes its individual config with `-F`, so it does not detect this Include failure before handing the alias to the editor.
- **Fix:** Escape glob metacharacters in the directory, then append the intentional `*.conf` wildcard and quote that combined pattern for SSH parsing.
- **Regression:** `ssh_includes_keep_wildcard_characters_in_directory_names_literal` passes the generated Include to the actual system OpenSSH config parser and checks the resolved HostName for all four directory-name cases. `-G` performs no SSH connection. The fixture uses temporary directories, not the user's SSH configuration or VMs.

The parser tested locally is OpenSSH 10.2p1. This check establishes configuration resolution on that parser; it does not prove a live editor connection or the complete supported-host matrix.

The same fix was independently folded in `94734eb1` before this branch's fold. The merge keeps that implementation and its changeset, removes this branch's duplicate changeset, and retains the additional regression using distinct HostName values for each fixture directory.
