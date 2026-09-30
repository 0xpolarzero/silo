---
"silo-ui": patch
---

Settings now suggest only terminals and code editors that can open sandboxes, and the system default falls back to one that can (for example Visual Studio Code instead of Xcode on macOS). Zed Nightly now opens sandbox folders too. On Linux, Open terminal works out of the box through the system's terminal launcher, Ptyxis and other launchers are supported, and Visual Studio Code from Microsoft's package, snap or Flatpak and Zed from its own installer or Flatpak open sandbox folders instead of failing or closing after a few seconds. When Silo runs as an AppImage, the terminals, editors and browsers it opens no longer inherit the AppImage's own libraries and settings.
