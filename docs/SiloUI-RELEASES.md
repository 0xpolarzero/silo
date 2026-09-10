# Building and releasing Silo

Every native Silo build requires the GitHub App configuration. The build reads
`app/SiloUI/github-build.local.json` automatically; no terminal exports are needed.
Explicit environment variables take precedence, which is how GitHub Actions
supplies the same configuration. Missing, empty, malformed, or multiline values
stop the native build instead of producing an app with broken GitHub access.

## Local setup

The local file on the maintainer's machine was configured on 2026-09-10 with
owner-only permissions (`0600`). It is explicitly ignored by Git. For a new
checkout or another development machine, run from the repository root:

```sh
cp app/SiloUI/github-build.example.json app/SiloUI/github-build.local.json
chmod 600 app/SiloUI/github-build.local.json
```

Fill in `SILO_GITHUB_CLIENT_SECRET` using the existing GitHub App's client secret.
The example already contains the two public identifiers:

| Key | Value / source |
| --- | --- |
| `SILO_GITHUB_APP_SLUG` | `microsandbox-workspaces` |
| `SILO_GITHUB_CLIENT_ID` | `Iv23liEjp3VnGe0sw2LU` |
| `SILO_GITHUB_CLIENT_SECRET` | Client secret from the GitHub App settings; never commit the value |

These identify Silo's GitHub App, not a user's password or personal access token.
They do not alter saved accounts, repository selections, or sandbox Git identity.
The client secret is embedded in the desktop executable and is extractable; it
is not a confidential boundary in a distributed desktop app. Keep the source
file and verbose Cargo build output private. Cargo's ignored build outputs also
contain the compiled configuration. Do not upload the entire Cargo target tree
as an Actions artifact or cache.

Use the existing commands:

```sh
npm --prefix app/SiloUI ci
npm --prefix app/SiloUI run desktop
npm --prefix app/SiloUI run desktop:build:debug
npm --prefix app/SiloUI run desktop:build
```

Only run the command needed: `desktop` starts development mode;
`desktop:build:debug` builds the local macOS app with ad-hoc signing;
`desktop:build` produces release-mode packages for the host. Platform resource
preparation runs before native compilation and needs network access on a cold
cache. Install Rust 1.94.0 (`rustup toolchain install 1.94.0`) for the pinned
MicroSandbox source build, plus the host's Tauri prerequisites.

The Rust `build.rs` loads the file relative to the crate, so it also covers
direct `cargo build`, `cargo test`, and direct Tauri CLI invocations from other
working directories. Cargo tracks changes to the file and all three environment
variables and recompiles when they change. An explicitly empty environment
variable fails even when the local file has a value; unset a stale override to
use the file again. An invalid local JSON file must be repaired or removed.

Native tests also require configuration. CI uses the configured Actions secrets.
Contributors running offline unit tests can explicitly supply synthetic values
for all three variables; such test executables cannot authenticate to GitHub and
must not be distributed. Frontend tests need no GitHub credentials.

## Versioned distribution and updates

Releases are deliberate. Development pushes do not publish downloads. The source
version in `app/SiloUI/package.json`, package lock, Cargo manifest and Cargo lock
must agree. Stable versions use `MAJOR.MINOR.PATCH`; `0.0.0` and prereleases cannot
be published through the stable pipeline.

Supported packages:

| Platform | Installer | In-app updates |
| --- | --- | --- |
| Apple Silicon macOS | DMG | Signed Tauri app archive |
| Linux x86-64 | AppImage and Debian package | AppImage only |
| Linux ARM64 | AppImage and Debian package | AppImage only |

Linux builds target Ubuntu 24.04-compatible systems and require KVM for VMs.
AppImage bundles application libraries but does not make glibc or GPU support
universal. Debian upgrades use the package manager and download flow, never
replace package-owned binaries in place. Intel macOS and Windows are unsupported.
Debian packages keep runtime/Git helpers in `/usr/lib/Silo/bin`; they never
overwrite system Git in `/usr/bin`. AppImage keeps its helpers inside the image.
The guest image, native runtime, host Git/LFS tools and notices are packaged with
the application; existing VM disks are not release assets.

### Signing setup

`tauri.conf.json` contains the permanent public updater key. This is safe to
commit. The private key is stored in protected GitHub environment
`release-signing` as `TAURI_SIGNING_PRIVATE_KEY`; its optional password is
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep an independent secure backup. Losing
the private key prevents updates to already installed applications. Never upload
private keys, complete build directories, or local GitHub configuration artifacts.

The `release-signing` and `release-publish` environments require maintainer review
and restrict execution to version tags. Artifact-only verification uses a fresh
ephemeral signing key in `release-verification`; these packages are for tests and
cannot update production installations. The public key override only occurs in
that isolated workflow checkout. These are not public releases.

macOS uses ad-hoc signing and no notarization. A downloaded installation can
require System Settings → Privacy & Security → Open Anyway. Do not instruct users
to disable Gatekeeper globally. Update signatures are separate and always checked.

### Build and publish

1. Update the synchronized version and add `docs/releases/VERSION.md` with actual
   user-facing changes and compatibility notes. Commit and review the source.
2. For verification, dispatch **Build Silo release** with `draft=false` on the
   reviewed test branch. All three builds run tests and upload packages only.
3. After approval, create the exact `vVERSION` tag at the reviewed commit and
   dispatch **Build Silo release** on that tag with `draft=true`. Approve the
   signing environment only after confirming the commit. Every platform must
   pass before a draft is created. Existing releases and drafts are never overwritten.
4. Download and test the complete draft on clean systems and upgrade an earlier
   real installation. Review notes, bundled licenses and all architecture assets.
5. Obtain public-release approval, then dispatch **Publish verified Silo draft**
   on the version tag with the matching version. Approve `release-publish`.
   It downloads all draft assets, checks SHA256, updater signatures and the signed
   version/architecture metadata, and only
   then publishes the draft and marks it latest.

The app reads
`https://github.com/0xpolarzero/silo/releases/latest/download/latest.json`.
That file references immutable version-specific download URLs and all three
platform signatures. Partial build/upload failures leave the prior public release
and update feed unchanged. A partial draft must be inspected and explicitly
removed before retrying; the scripts never silently clobber it. A bad published
release is fixed with a newer version, not an automatic data downgrade.

Before publishing, enable GitHub release immutability in repository settings.
The workflow also refuses existing release versions and older stable versions.
The `publish-release.py` tests cover missing/empty/unexpected assets, symlinks,
invalid signature encoding, version bounds, complete checksums and platform URLs.
`verify-release-metadata.py` also rejects an old signed package advertised under
a new version. It reads macOS Info.plist/Mach-O headers, Debian control metadata,
and the signed AppImage release-info resource without executing any package.

### Required release acceptance evidence

- Clean install from actual downloaded DMG, AppImage and Debian package.
- Real signed version-to-version update and app relaunch; preserved settings,
  account, secrets, VM disks and previous running state.
- Invalid signature, interrupted/offline download, low disk space, read-only
  installation directory and interrupted installation.
- macOS quarantine first launch, signature verification and Keychain behavior
  after upgrading an ad-hoc signed app.
- AppImage extraction, library resolution, tray/notifications/desktop integration
  on both architectures; package-manager upgrade for Debian installations.
- No public-release claim until these checks have real evidence. Unit/build
  success does not substitute for clean installation or VM execution.

## Primary references

- [Tauri updater and signed static feeds](https://v2.tauri.app/plugin/updater/)
- [Tauri AppImage packaging](https://v2.tauri.app/distribute/appimage/)
- [AppImage filesystem/runtime layout](https://docs.appimage.org/introduction/software-overview.html)
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub release immutability](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub deployment environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment)

Reviewed 2026-09-10. Distribution/update acceptance evidence is tracked in
`docs/SiloUI-DISTRIBUTION-PLAN.md`.
