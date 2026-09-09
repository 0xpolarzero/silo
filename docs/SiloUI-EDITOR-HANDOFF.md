# Native editor and browser handoff

Network links use the current browser preference: Launch Services (`open -a`) on macOS and GIO `launch_uris` on Linux. Only HTTP(S) URLs without embedded credentials are accepted. URL contents are positional arguments, never shell programs. Explicit unavailable preferences fail instead of opening a different app.

Folder actions use MicroSandbox's SSH server over standard input/output, not a host `/workspace` path. The app checks the managed VM is running and the requested directory exists before opening it. `msb ssh serve --stdio --no-start` prevents the editor transport from starting a stopped VM, including a stop between checking and connecting.

Silo creates an Ed25519 client identity in its private runtime home, adds only its public key to MicroSandbox authorization, and pins the VM's locally stored SSH host public key. The guest does not receive either private key. SSH uses `IdentitiesOnly`, disables the agent, and requires the pinned host key. Each exact VM alias has a private configuration file. One `Include` line is prepended to the user's SSH configuration; the existing bytes are preserved and repeated actions do not duplicate the include. Symlinked or oversized SSH configuration files fail explicitly rather than being replaced.

Supported adapters:

- Zed: bundled CLI on macOS or discovered executable on Linux, with an encoded `ssh://root@alias/path` URI.
- Visual Studio Code: bundled CLI on macOS or discovered executable on Linux, with `--folder-uri vscode-remote://ssh-remote+alias/path`. VS Code needs its Remote SSH extension.
- Other editors: explicit unsupported message. No successful-looking local folder fallback.

The host needs its standard OpenSSH client (`ssh` and `ssh-keygen`); missing executables produce an explicit error. The bundled runtime SSH session resolves the guest login home once and uses it for both shell commands and SFTP, so editor uploads and remote mkdir commands agree.

The transport is probed before launching. Launch success means the operating system/editor CLI accepted the handoff; editor server installation, extensions and guest network requirements can still fail inside the editor.

Primary references:

- [Zed SSH remote development](https://zed.dev/docs/remote-development): SSH URI support and use of the user's SSH configuration.
- [VS Code remote CLI](https://code.visualstudio.com/docs/remote/troubleshooting#_connect-to-a-remote-host-from-the-terminal): remote folder URI and Remote SSH behavior.
- [GIO AppInfo.launch_uris](https://docs.gtk.org/gio/method.AppInfo.launch_uris.html): application-aware URI launching and desktop-entry handling.
- Bundled MicroSandbox source, pinned commit `5eca4de8bf233e57f114140f8c076ea8c96f21ab`, `crates/cli/lib/commands/ssh.rs` and `sdk/rust/lib/sandbox/ssh.rs`: stdio transport, authorized key store and per-sandbox host key path.

Focused tests: `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml editor::tests` and `applications::tests`. The ignored `editor::tests::live_editor_transport` requires explicit `SILO_EDITOR_USER_HOME`, `SILO_EDITOR_RUNTIME_HOME`, `SILO_EDITOR_MSB`, and `SILO_EDITOR_LIBRARY`; it modifies that home's SSH integration and proves the dev test repository is reachable. `SILO_EDITOR_OPEN_ZED=1` also launches the real editor. It is never enabled during ordinary tests or production startup.

## Live macOS verification (2026-09-10)

The focused live test passed against the running `dev` VM with the patched bundled CLI: SSH `pwd` equals `$HOME`; a shell-created relative directory receives an SCP/SFTP marker; the transfer exits zero; SSH reads identical marker bytes; the test deletes its marker and directory. Real Zed then completed server installation, opened `silo-files-test-express`, and displayed the repository's `Readme.md` from `/workspace/silo-files-test-express/Readme.md`. No repository file was edited.

This exposed and fixed two runtime bugs, covered by the live transfer regression: SSH/SFTP previously used `/` instead of the login home, and SFTP channel completion omitted SSH exit status (OpenSSH SCP returned failure despite successfully transferring bytes). The patch sets a shared login-home cwd and sends subsystem completion status on client EOF. Neither fix uses Zed-specific paths.

VS Code and Linux editor opening still require real-platform verification; URI/configuration and preference validation tests do not substitute for those checks.
