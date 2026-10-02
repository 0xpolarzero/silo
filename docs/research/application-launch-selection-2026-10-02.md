# Application launch selection

The [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-run) defines branch, architecture, command, and installation flags as selectors for the application being run. A desktop entry's `X-Flatpak` application ID alone does not preserve those selectors. Silo uses the parsed entry's `flatpak run` arguments, checks that they include the supported application ID, and removes file-forwarding syntax before appending its workspace arguments. It preserves the entry's Flatpak executable path too.

Verification uses the platform-neutral launch resolver with distinct stable and beta entries. No Flatpak installation or live editor is launched.

Apple's [AppleScript application reference](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_classes.html) documents a POSIX path as the way to target a specific application copy. Ghostty's script therefore uses the selected canonical bundle path as a quoted literal, which also loads that bundle's scripting terminology. Backslashes, quotes, and line-control characters are escaped; the terminal command remains a separate `argv` value. The existing execution deadline remains unchanged.

Ghostty tests check two distinct target paths and evaluate the generated path literal with `osascript` to verify escaping without contacting any application. They also retain the command argument and helper-deadline tests. This does not verify a live Ghostty window or Automation permissions.
