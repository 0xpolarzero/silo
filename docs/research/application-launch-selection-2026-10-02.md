# Application launch selection

The [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-run) defines branch, architecture, command, and installation flags as selectors for the application being run. A desktop entry's `X-Flatpak` application ID alone does not preserve those selectors. Silo uses the parsed entry's `flatpak run` arguments, checks that they include the supported application ID, and removes file-forwarding syntax before appending its workspace arguments. It preserves the entry's Flatpak executable path too.

Verification uses the platform-neutral launch resolver with distinct stable and beta entries. No Flatpak installation or live editor is launched.
