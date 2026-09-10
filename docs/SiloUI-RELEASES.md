# Building and releasing Silo

Every native Silo build requires the GitHub App configuration. The build reads
`app/SiloUI/github-build.local.json` automatically; no terminal exports are needed.
Explicit environment variables take precedence, which is how GitHub Actions
supplies the same configuration. Missing, empty, malformed, or multiline values
stop the native build instead of producing an app with broken GitHub access.

## Release a new version

Silo uses **Changesets** for version decisions and changelogs. Contributors add
short release notes with their changes. Preparing a release combines those notes;
pushing its version tag builds a draft. Publication is a separate explicit step.
Normal branch pushes do not release the app.

Run these commands from `app/SiloUI`. Install dependencies with `npm ci` first.
Use Node.js 24, Python 3.11 or newer, Git, and GitHub CLI (`gh auth login` for
publication). Your Git remote `origin` must point to the Silo repository, and
your account needs push and Actions permissions. CI holds the signing keys;
local release preparation needs no signing credentials or VM runtime.

### While making changes

```sh
npm run changeset
```

Choose `silo-ui`, the bump type, and write a user-facing summary. Use **patch**
for fixes, **minor** for compatible features, and **major** for incompatible
changes. Include any migration steps. Commit the generated `.changeset/*.md`
file alongside the change. Edit the Markdown freely before release. Internal
refactors, tests, and documentation do not require a note unless users are affected.

Agents can create these files directly; release notes do not depend on commit
message conventions. Each note should explain the resulting behavior, not list
implementation files. Never put credentials or private user information in notes.

### Prepare and review

```sh
npm run release:status
npm run release:version
```

Changesets chooses the next version, updates `package.json` and `CHANGELOG.md`,
and consumes the pending notes. Our adapter updates `package-lock.json`,
`src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` to the same version without
changing dependencies. It exports the new changelog entry to
`docs/releases/VERSION.md`, which becomes the GitHub release body and app update
notes. Tauri already reads its version from `package.json`.

Review all generated changes, including the removed changeset files. The initial
remote-computers changeset requests a minor release from 0.1.1 to 0.2.0; the
version is not bumped until you run the command. Several pending notes produce
one release using the largest requested bump.

Commit the generated changes and push your branch. Use your normal review process;
merge the release preparation into `main` before releasing from its clean checkout.
Do not edit version files by hand. To edit wording after preparation, keep the
new changelog entry and `docs/releases/VERSION.md` consistent.

### Build the draft

```sh
npm run release:draft
```

This requires a clean working tree, synchronized versions, release notes, and no
pending changesets. Changesets creates the `vVERSION` tag; the command pushes
only that tag to `origin`. The tag push automatically runs **Build Silo release**.
Approve `release-signing` in GitHub Actions if requested. All three platforms
must pass before the complete draft appears under GitHub Releases. Nothing is
published to npm, and no public app update is announced yet.

Test the draft installers on clean supported systems and upgrade an earlier real
installation. Review the notes and the acceptance evidence below.

### Publish the tested draft

From the same release commit:

```sh
npm run release:publish
```

This dispatches **Publish verified Silo draft** against the exact version tag.
Approve `release-publish` if requested. The workflow verifies the stored packages,
signatures, checksums, version metadata and update feed, then publishes and marks
the release latest. A successful command means the workflow was requested;
publication is complete only when that workflow succeeds.

### Preview, retries, and recovery

- `npm run release:status` is read-only. No pending changes is not a new release;
  `release:version` fails without changing the version when there are no notes.
- If versioning succeeds but synchronization fails, fix the reported input and
  run `npm run release:sync`. It can be retried without another version bump and
  refuses to overwrite different existing release notes. Review the working diff
  before committing; failed preparation never pushes or publishes anything.
- For CI verification before tagging, manually run **Build Silo release** on
  your branch with `draft` unchecked. Those packages use isolated test signing
  keys and are not distributable updates.
- A failed tag push leaves a local tag; retry `release:draft`. The command never
  force-moves tags. If a tag identifies another commit, check out that release or
  prepare a newer version.
- Pushing an existing remote tag again does not retrigger CI. Retry **Build Silo
  release** manually on that tag with `draft` checked. An existing incomplete
  draft must be reviewed and explicitly removed before rebuilding; publication
  refuses incomplete drafts. Never replace a published version.
- For a later publication retry, check out the release tag and run
  `release:publish`, or select that tag in **Publish verified Silo draft** and
  enter its version without the `v` prefix.

The installed Changesets CLI is pinned in `package.json` and the lockfile.
Configuration keeps Silo private to npm while enabling versioning and Git tags.
Changesets 3 uses `git-tag`; the wrapper uses the installed command. See the
[Changesets source and documentation](https://github.com/changesets/changesets)
for its note format and release model. Run `npm run test:release` to exercise
actual Changesets versioning in disposable repositories and the desktop adapter.

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

The macOS release packager signs the bundled VM engine first, then constrains
`msb` to that exact library's code hash. Apple system libraries remain permitted
by macOS. The helper's library-validation exception is paired with this enforced
constraint; an unconstrained helper fails release verification. The app and Git
helpers retain their ordinary library validation. This blocks engine substitution,
not malicious code already present in the approved build or replacement of the
entire ad-hoc-signed app. Each update gets a constraint for its own engine.
The packager regenerates both the DMG and signed updater archive from the same
finished app, with no AppleDouble archive entries.

The minimum macOS 14 constraint tests are required before draft creation; the
build runner also exercises the constraint tests. GitHub's macOS 14.8.9 and
15.7.9 runners were verified to have System Integrity Protection disabled on
2026-09-10. Their explicit `--constraints-only` mode checks library fingerprint
restrictions and records the two signature-enforcement controls as skipped.
A passing hosted result does not establish signature enforcement. Public release
also requires the full suite on a Mac with SIP enabled, including the minimum
supported macOS version. GitHub currently provides
macOS 14 runners until November 2, 2026. Before their retirement, replace this
minimum-version proof with a maintained runner rather than silently omitting it.
This CI test checks library enforcement, not nested VM execution.

### Build and publish

Follow [Release a new version](#release-a-new-version) above. Both version-tag
pushes and manual draft builds use the same signing and validation pipeline;
only the separate publication workflow can make the draft public.

The app reads
`https://github.com/0xpolarzero/silo/releases/latest/download/latest.json`.
That file references immutable version-specific download URLs and all three
platform signatures. Partial build/upload failures leave the prior public release
and update feed unchanged. A partial draft must be inspected and explicitly
removed before retrying; the scripts never silently clobber it. A bad published
release is fixed with a newer version, not an automatic data downgrade.

GitHub release immutability was enabled for this repository on 2026-09-10.
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
- [GitHub macOS 14 runner retirement](https://github.com/actions/runner-images/issues/13518)
- [Apple library constraints](https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints)
- [GitHub release immutability](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub deployment environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment)

Reviewed 2026-09-10. Distribution/update acceptance evidence is tracked in
`docs/SiloUI-DISTRIBUTION-PLAN.md`.
