# Distribution and update acceptance

Approved scope: GitHub-hosted versioned releases, ad-hoc macOS signing, signed
Tauri updates, Apple Silicon DMG, Linux ARM64/x86-64 AppImage and Debian packages.
No Apple membership, update server, forced installation, or public publication
before the owner's review of the completed release.

## Implementation and ownership

- Native updater: trusted configuration, download/signature verification,
  operation exclusion, confirmed VM shutdown, durable exact-ID restart recovery.
- Application UI: compact General Updates card, default-on automatic checks,
  explicit download/install, real progress, actionable errors and confirmation.
- Packaging: complete versioned draft, matching checksums/signatures/feed,
  protected signing and publication, previous releases retained.
- Integration: real two-version upgrades and independent review of safety gates,
  clean installation, resource layout, and desktop behavior.

## Required evidence

| Boundary | Required observation |
| --- | --- |
| Authenticity | Correct signature installs; wrong key or modified bytes refuse installation. |
| Version selection | Current/older versions do not install; missing platform and malformed feeds report failure. |
| Downloads | Offline/timeout/truncated response is recoverable; current installation stays usable. |
| Installation | Read-only destination and insufficient space fail before VM shutdown or replacement. |
| Runtime safety | Active operations block installation; new operations cannot race confirmed shutdown. |
| Relaunch | Previously running exact VM IDs resume; stopped VMs remain stopped; interrupted shutdown/install is recoverable. |
| Data | Settings, accounts, secret references, root/workspace data and backups survive the upgrade. |
| macOS | Downloaded ad-hoc DMG first launch and next-version upgrade exercised, including Keychain/login prompts and bundled helper execution. |
| AppImage | Both architectures boot the installed app, resolve packaged tools, and update the actual AppImage path. |
| Debian | Clean installation and package upgrade work; UI opens the correct package download rather than self-replacing managed files. |
| Publication | Incomplete matrix/signatures never publish; version assets are not overwritten; latest advances only after verification. |

Tests use isolated keys, feeds, builds and app-data directories. No fixture IPC,
debug routes or runtime endpoint override belongs in the production UI. Report
untested boundaries explicitly; compiling a package is not installation proof.

## Release credentials

On 10 September 2026, the owner authorized setup of the release automation.
`release-signing` and `release-publish` GitHub environments require owner review
and permit only `v*` version tags. The private updater key is an encrypted secret
in `release-signing`; the app contains only its public verification key. A local
owner-only, Git-ignored copy exists for backup. Never commit or print private
keys or upload native build directories containing account configuration.

## Primary references

- [Tauri updater](https://v2.tauri.app/plugin/updater/): established signed update
  transport and platform artifacts; static GitHub feed needs no hosted service.
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/): ad-hoc signing
  supports Apple Silicon but does not confer Gatekeeper trust or notarization.
- [Tauri AppImage packaging](https://v2.tauri.app/distribute/appimage/): package
  format and Linux build compatibility constraints.
