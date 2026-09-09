# Terminal handoff and status actions

Implemented 2026-09-10. The Swift `TerminalLauncher` was inspected as reference:
its Ghostty native-tab API and private command-file approach were retained.
The executable target is now the bundled MicroSandbox interactive exec command,
not a legacy wrapper or a new SSH layer.

The native action reads the current terminal preference, verifies a local managed
VM is Running, and launches `msb exec NAME --no-start --workdir /workspace --tty`.
The runtime selects its default interactive shell. `--no-start` also protects the
race where the VM stops after the initial check. Paths are shell-quoted as single
arguments. No GitHub tokens or secret values are written to launcher files.

macOS supports Ghostty's native tab/window API and Terminal/iTerm command files.
Command files have mode0700, delete themselves when run, and are removed after
launch failure. Ghostty requires1.3 or newer and macOS Automation permission;
Silo supplies the purpose string and Apple Events entitlement. Unsupported apps
produce a clear error rather than opening a local shell that appears successful.
Linux uses known terminal command arguments (GNOME Console/Terminal, Ghostty,
Konsole, Alacritty, Kitty, WezTerm, Xfce Terminal, Xterm, Tilix). Desktop entries
are resolved with GIO; Exec strings are never treated as shell programs.

Status-bar destinations are stored natively until the main window consumes them;
a main-only command and event cover startup and repeat navigation. Dismissing a
finished push removes its native result and refreshes views. Dismissal cannot
cancel an active push.

Validation: terminal unit tests cover shell argument boundaries, private script
execution/cleanup, no-start command construction and unsupported adapters. A real
PTY session in dev returned `/workspace`, printed a marker and exited cleanly.
Full suites:578 frontend tests,241 native tests passed (6 explicit integration
tests ignored). TypeScript checking, lint and desktop build passed. Linux and
VS Code are not installed/tested here; Zed's successful SSH test does not verify
VS Code's Remote SSH extension and URI handoff.

Primary references:
- [Ghostty native scripting](https://ghostty.org/docs/features/applescript)
- [Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)
- [iTerm command-file associations](https://iterm2.com/documentation-one-page.html)
- [Xfce terminal arguments](https://docs.xfce.org/apps/xfce4-terminal/4.16/command-line)
- [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh)
- Bundled `msb exec --help`: interactive default shell, `--tty`, `--workdir`, `--no-start`.

The rebuilt production app's command menu `Open dev in Ghostty` launched the
canonical bundled `msb exec dev --no-start --workdir /workspace --tty` process.
The computer-use provider refused Ghostty access, so its visible terminal contents
were not inspected. The independent real PTY check above verified interactive
command execution. Native status tray interaction was not driven; route delivery
and dismissal were verified through native and frontend tests. No fixture mode
was used for the launcher test.
