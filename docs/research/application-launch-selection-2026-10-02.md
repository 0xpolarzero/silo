# Application launch selection

The [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-run) defines branch, architecture, command, and installation flags as selectors for the application being run. A desktop entry's `X-Flatpak` application ID alone does not preserve those selectors. Silo uses the parsed entry's `flatpak run` arguments, checks that they include the supported application ID, and removes file-forwarding syntax before appending its workspace arguments. It preserves the entry's Flatpak executable path too.

Verification uses the platform-neutral launch resolver with distinct stable and beta entries. No Flatpak installation or live editor is launched.

Apple's [AppleScript application reference](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_classes.html) documents a POSIX path as the way to target a specific application copy. Ghostty's script therefore uses the selected canonical bundle path as a quoted literal, which also loads that bundle's scripting terminology. Backslashes, quotes, and line-control characters are escaped; the terminal command remains a separate `argv` value. The existing execution deadline remains unchanged.

Ghostty tests check two distinct target paths and evaluate the generated path literal with `osascript` to verify escaping without contacting any application. They also retain the command argument and helper-deadline tests. This does not verify a live Ghostty window or Automation permissions.

## APPLICATIONS-3: native Linux editor options were discarded (P2)

At `app/SiloUI/src-tauri/src/applications/launch.rs:119–122` before the fix, native editor resolution returned an empty argument vector. Selecting a desktop entry containing `code --user-data-dir=/path/to/data --extensions-dir=/path/to/extensions %F` therefore opened the default data directory and extensions instead of the selected isolated instance. The [VS Code CLI documentation](https://code.visualstudio.com/docs/configure/command-line#_advanced-cli-options) confirms that these options select separate user state and extensions. A temporary CLI fixture recorded only Silo's profile and workspace arguments in the failing regression.

The resolver now preserves arguments following the original editor program when substituting its CLI. Field codes remain removed, and Silo appends its channel profile and workspace. Microsoft's [argument parser](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/argv.ts) takes the last value for single string options, so the appended Silo profile remains authoritative. The regression records the actual arguments received by the temporary CLI, including directories containing spaces. No installed editor is launched.
