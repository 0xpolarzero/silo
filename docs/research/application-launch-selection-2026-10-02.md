# Application launch selection

The [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-run) defines branch, architecture, command, and installation flags as selectors for the application being run. A desktop entry's `X-Flatpak` application ID alone does not preserve those selectors. Silo uses the parsed entry's `flatpak run` arguments, checks that they include the supported application ID, and removes file-forwarding syntax before appending its workspace arguments. It preserves the entry's Flatpak executable path too.

Verification uses the platform-neutral launch resolver with distinct stable and beta entries. No Flatpak installation or live editor is launched.

Apple's [AppleScript application reference](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_classes.html) documents a POSIX path as the way to target a specific application copy. Ghostty's script therefore uses the selected canonical bundle path as a quoted literal, which also loads that bundle's scripting terminology. Backslashes, quotes, and line-control characters are escaped; the terminal command remains a separate `argv` value. The existing execution deadline remains unchanged.

Ghostty tests check two distinct target paths and evaluate the generated path literal with `osascript` to verify escaping without contacting any application. They also retain the command argument and helper-deadline tests. This does not verify a live Ghostty window or Automation permissions.

## APPLICATIONS-3: native Linux editor options were discarded (P2)

At `app/SiloUI/src-tauri/src/applications/launch.rs:119–122` before the fix, native editor resolution returned an empty argument vector. Selecting a desktop entry containing `code --user-data-dir=/path/to/data --extensions-dir=/path/to/extensions %F` therefore opened the default data directory and extensions instead of the selected isolated instance. The [VS Code CLI documentation](https://code.visualstudio.com/docs/configure/command-line#_advanced-cli-options) confirms that these options select separate user state and extensions. A temporary CLI fixture recorded only Silo's profile and workspace arguments in the failing regression.

The resolver now preserves arguments following the original editor program when substituting its CLI. Field codes remain removed, and Silo appends its channel profile and workspace. Microsoft's [argument parser](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/argv.ts) takes the last value for single string options, so the appended Silo profile remains authoritative. The regression records the actual arguments received by the temporary CLI, including directories containing spaces. No installed editor is launched.

An additional regression covers `code -- %F` and the equivalent Flatpak entry. After removing file field codes, an empty trailing `--` must also be removed so Silo's appended profile remains an option. Both adapters are covered.

## APPLICATIONS-4: environment wrappers hid stale editor launchers (P2)

Before the fix, `linux_editor_command` accepted an absolute editor path without checking that the resolved command could execute. An entry such as `Exec=/usr/bin/env A=b /removed/code %F` passed desktop-entry validation because [GLib 2.78.6 validates only `argv[0]`](https://github.com/GNOME/glib/blob/2.78.6/gio/gdesktopappinfo.c#L1803-L1831). Silo's discovery accepted that entry through `entry_editor(...).is_ok()` and could choose it as the editor default even though opening a sandbox failed.

The resolver now requires the final native CLI or Flatpak launcher to be an executable file. The regression transitions a temporary env-wrapped target through missing, non-executable, and executable states. Existing adapter tests now use actual temporary executable fixtures instead of nonexistent host paths.

## APPLICATIONS-5: stale env-wrapped terminals remain suggested (P3, skipped)

- **File:line:** `app/SiloUI/src-tauri/src/applications/linux.rs:63–71`.
- **Trigger:** A visible terminal entry has `Exec=/usr/bin/env A=b /removed/gnome-terminal` without `TryExec`, and its target has been removed or lost execute permission.
- **Evidence:** GLib's validation above accepts the existing `env` wrapper. `terminal_program` returns the absolute target without checking it, and `launchable_terminal` checks only whether its basename has a supported argument adapter.
- **Consequence:** The catalog still offers an unavailable terminal. Choosing it and opening a sandbox fails at process launch. That error is reported, so this is a stale suggestion, not false success.
- **Suggested fix:** Require the resolved terminal target to be an executable file before including the entry.
- **Regression:** On Linux, create an env-wrapped terminal entry and transition its target from executable to non-executable and removed; require `launchable_terminal` to become false in both failure states.
- **Skipped:** This macOS host cannot execute the GIO desktop-entry regression. The fix loop prohibits launching a Linux VM; use the ordinary Linux native-test runner to complete the failing-test loop.

## Fix-loop results

All code changes were made in `codex/fix-applications` and folded into `codex/integration` separately:

| Finding | Fix commit |
| --- | --- |
| APPLICATIONS-1, Flatpak selection | `9e62895f` |
| APPLICATIONS-2, Ghostty bundle selection | `9ad90fa6` |
| APPLICATIONS-3, native editor options | `e808832e` |
| Editor file-separator regression | `1510ec7f` |
| APPLICATIONS-4, stale editor launchers | `3e38bba0` |

Each behavior regression failed before its correction. The full Cargo test build used Rust 1.94.0, `/tmp/silo-codex-target`, and explicit synthetic GitHub values. Its focused Flatpak test passed. A retained copy of that built test executable then passed all 30 `applications::` tests, including the Ghostty and native-editor-option regressions. The later separator and executable-validation changes were verified by compiling the production `launch.rs` module directly with `rustc --test` and its existing `tempfile` dependency in the shared target directory. Formatting, frontend typecheck, and lint passed; intermediate runs included warnings outside this scope. Evidence logs remain local under `/tmp/silo-applications-*`, and test artifacts remain under `/tmp/silo-codex-target/verification/applications/`.

All inputs were temporary fixtures. No packaged bundle was inspected or launched, and no live editor, terminal, VM, production state, or credential store was exercised. Linux GIO discovery and actual application handoffs remain outside this verification.

At the final merged checkout, the isolated `launch.rs` run passed all 13 tests, including two AppImage regressions folded by another task. Direct `clippy-driver` analysis completed with the existing `nonminimal_bool` warning at `launch.rs:30`; an additional strict `-D warnings` run rejected that expression. No new Clippy warning was reported.

## APPLICATIONS-6: editor environment prefixes were discarded (P2)

The resolver recognized `env NAME=value code` and `env -i NAME=value flatpak run ...` entries but launched the resolved program without their prefix. The failing launch regression used a temporary executable that printed the environment value supplied in its entry; it received an empty value instead. Environment settings selecting editor data or runtime behavior therefore did not reach the editor.

The command now retains the original environment launcher and prefix arguments around the resolved editor CLI. Both native and Flatpak adapters use the same prefix seam. [GNU env documentation](https://www.gnu.org/s/coreutils/manual/html_node/env-invocation.html) defines assignments and `-i` as changes to the child environment; Silo delegates those semantics to the original executable rather than implementing a second environment mechanism. The regression executes temporary native and Flatpak launchers, with the marker explicitly removed from the parent command environment.

## APPLICATIONS-7: unset-option operands were mistaken for programs (P2)

`exec_program` treated the operand of `env -u NAME` or `env --unset NAME` as the executable. Ordinary entries were rejected as unsupported editors; when the operand equaled the editor name, the resolver also rebuilt the prefix around the wrong token occurrence. The failing regression executed `env -u code code` under a fixture-only PATH: the child retained the `code` variable instead of removing it.

The parser now consumes the unset operand and returns the actual program index. Editor resolution uses that index rather than searching for the first equal string. The same parser supplies Linux terminal identity. The regression verifies the executed child's environment and workspace argument, both unset option spellings, and rejection of a missing operand. No real editor or terminal is launched.
