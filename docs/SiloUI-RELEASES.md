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

Review all generated changes, including the removed changeset files. Several
pending notes produce one release using the largest requested bump.

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

Native development requires a GitHub App client ID, slug, and client secret.
The local configuration file is ignored by Git. From the repository root:

```sh
cp app/SiloUI/github-build.example.json app/SiloUI/github-build.local.json
chmod 600 app/SiloUI/github-build.local.json
```

Fill in `SILO_GITHUB_CLIENT_SECRET` using the existing GitHub App's client secret.
You need access to that credential for native development; installed-app users
do not. The example contains Silo's two public identifiers:

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

Release review must explicitly acknowledge that publishing packages distributes
this GitHub public-client secret. It is not an App private key or a user's access
token, and it must never authenticate a Silo installation to a backend service.
The [0.1.1 credential-distribution audit](SiloUI-OAUTH-RELEASE-AUDIT.md) records
package inspection, live App settings, PKCE enforcement checks, and their limits.

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

Native tests also require configuration. The isolated CI native-test jobs use
explicit synthetic configuration; package jobs use configured Actions secrets.
Contributors running offline unit tests can explicitly supply synthetic values
for all three variables; such test executables cannot authenticate to GitHub and
must not be distributed. Frontend tests need no GitHub credentials.

### Local macOS bundles

From the repository root, build a debug app:

```sh
npm --prefix app/SiloUI run desktop:build:debug
```

Output: `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`.
For an optimized local app without installer or updater artifacts:

```sh
npm --prefix app/SiloUI run desktop:build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Output: `app/SiloUI/src-tauri/target/release/bundle/macos/Silo.app`.
These commands do not install or publish the app.

### Verify a change

Run the checks relevant to the change from the repository root:

```sh
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
npm --prefix app/SiloUI test
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml
npm --prefix app/SiloUI run test:release
```

Native tests require the configuration described above. Frontend fixtures and
unit tests do not prove installed-app behavior, live VM health, or two-computer
operation. Keep opt-in live tests separate from ordinary tests.

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

### Linux software source

After publication, **Publish Silo system updates** verifies the public Debian
packages and deploys signed APT metadata to GitHub Pages. Confirm that workflow
succeeds before announcing availability through Software Updater. Initial
setup, key rotation, migration, and installer tests are documented in
[Linux system updates](SiloUI-LINUX-UPDATES.md).

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

## Release CI caches

The release workflow runs frontend tests, type checking, lint, and Node release
checks once in a shared job. Draft creation requires that job to pass. Each
platform still runs Python release checks, native tests, updater checks, and
its packaging and signing verification.

`warm-release-caches.yml` populates caches on `main` when runtime inputs, dependency
manifests, vendor sources, compiler configuration or cache tooling change; it also
supports manual dispatch on `main`. Let its first
cold run finish before tagging a release to benefit from the cache.
[GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
allows tags to restore default-branch caches, but not caches from other tags.
Release jobs restore caches without saving them.

The shared `prepare-release-runtime` action caches pinned public downloads,
patched MicroSandbox executables and their checksums, and the guest archive.
Keys include the runner, target, Rust toolchain, staging scripts, runtime patch,
and guest lockfile, so app version changes alone do not invalidate the runtime.
Preparation always verifies and stages restored inputs and regenerates package
metadata. Cache misses follow the normal build path.

Release validation checks exact runtime-cache availability for each target using
`lookup-only` on the existing validation runner. Warm platforms start their native
and package jobs directly, without an extra producer runner or artifact transfer.
A missing exact cache starts one credential-free runtime producer inside that
platform's `release-platform.yml` invocation. Its native and package jobs wait for
that producer; another platform's runtime does not block them. Sequential benchmark
mode still runs native tests in the package job before release compilation.

The cold producer archives only the existing public runtime-cache allowlist. The
archive preserves executable modes and excludes application build products, local
configuration, source-build work directories, and staged `release-info.json`.
Consumers require the producing job's archive SHA256, reject unsafe paths and
links, and then run normal preparation to validate and stage inputs for the current
release. No release job saves a shared cache; only the main-branch warmer does.
If an exact cache is evicted or damaged after lookup, ordinary preparation retains
its safe local rebuild fallback. Cache reuse is an optimization, not a prerequisite
for correctness.

The lookup and restore use the same key and literal path list. GitHub's
[cache version implementation](https://github.com/actions/toolkit/blob/main/packages/cache/src/internal/cacheUtils.ts)
combines those paths, compression method and format salt; its platform discriminator
applies only to Windows. Our Linux and macOS runners use zstd. The archive transfer
adds an explicit digest failure check because GitHub's
[artifact download validation](https://docs.github.com/en/actions/tutorials/store-and-share-data#validating-artifacts)
reports a digest mismatch as a warning.

Cargo download caches contain registry indexes, downloaded crates, and Git databases,
following the [Cargo home guidance](https://doc.rust-lang.org/cargo/guide/cargo-home.html).
A separate reviewed dependency cache contains selected compiled crates.io dependencies
for the exact release profile and target. It never contains the full Cargo target
tree, application executables or fingerprints, workspace/path/git package outputs,
or local configuration. Registry build-script products are included only when the
exporter attributes them to an approved locked crates.io package.

Only the credential-free `main` warmer compiles and exports that dependency cache,
using explicit synthetic GitHub configuration and no signing environment. An exact
cache lookup skips compilation when the cache already exists. Before saving, the
exporter audits package ownership, artifact hashes, paths and modes, verifies registry
source bytes against locked crate archives, and rejects the synthetic secret marker.
Release jobs only restore; they never export or save their credentialed build products.

Dependency keys include compiler and SDK identity, native toolchain versions, target,
release profile, dependency graph and features, lockfile pins and checksums, vendor
sources, Cargo configuration, and compiler environment overrides. Only the excluded
root application's version is normalized across Cargo/Tauri manifests, the lockfile
and root graph references. Dependency versions and checksums remain exact. Consumers
compute their own context before artifact-only verification changes the updater key.
The importer independently validates the current graph and lockfile, then checks all
cached artifacts and installed registry source bytes before restoring source timestamps
and approved dependency products. A missing cache, cache-service failure or rejected
import follows ordinary compilation with an empty dedicated release target.

CI release compilation and bundling use
`app/SiloUI/src-tauri/target/release-compile/<target>/release/`; bundles are under its
`bundle/` directory. Local build paths documented above are unchanged. Every release
still compiles the application, and the build rejects Cargo output reporting the
application executable as fresh. Native and updater tests retain their ordinary test
targets and run on every platform; dependency reuse removes no release gates.

The 0.3.1 macOS release spent about 14 minutes preparing its runtime. Reusing the
patched runtime targets that cost; actual savings must be measured on a release
with a warm cache. The first cache-warming run still pays the cold build cost.

## Fast feedback and phase measurements

Run `npm --prefix app/SiloUI run preflight` before a native build. This reads the
approved `runtime-inputs.json`, checks its schema, supported targets, source pins,
features and the actual patch digest without network access or Rust compilation.
Runtime preparation and draft creation run it automatically. JavaScript staging
and Rust dependency validation consume this same file; changing runtime pins
requires reviewing it and verifying downloaded bytes during staging.

Ordinary GitHub build and permission checks live in the binary's `cfg(test)`
modules. This preserves their assertions while avoiding Cargo's additional
normal debug executable build for integration tests. Use a Cargo test filter
for focused feedback, then run the full native suite once for combined changes.

Vitest runs reviewed browser-independent suites in Node and retains jsdom for
all other suites. The global worker limit remains overridable with
`npm --prefix app/SiloUI test -- --maxWorkers=2`; do not inherit that limit into
individual projects because project limits override the CLI root limit.

The release workflow runs native and updater checks on all three platforms in
parallel with package compilation. The draft job requires the entire native
matrix, frontend checks, package checks and minimum-macOS checks to pass. Native
test jobs receive no signing credentials. Only the reviewed public release dependencies
described above are cached; application and native-test products are excluded.

Artifact-only runs have independent concurrency groups, so they do not queue
behind or displace a pending publication. Tagged and draft publications retain
the shared release concurrency group. Optional `benchmark_ref` pins every
checkout to a full 40-character source commit while using the dispatched
workflow definition. It is rejected for publication; validation logs both
workflow and source commits before checkout. Omit it for normal releases.

For a controlled CI comparison, dispatch the same source commit twice with
`draft=false`, once with `benchmark_schedule=sequential` and once with
`benchmark_schedule=parallel`. Sequential mode runs native checks before package
compilation and is rejected for draft creation. Compare job/step timestamps and
the `native-timings-*` / `package-timings-*` JSON artifacts. The measurement
wrapper preserves command failures and records elapsed time, CPU use and peak
child-process RSS without command arguments, environment variables or logs.
Runner allocation and caches vary; a single comparison does not establish a
guaranteed speedup.

Runtime cache fallback restores public input candidates only. Preparation still
validates downloaded digests and the patched executable's build key. That key
includes embedded agentd bytes as well as source, patch, target, compiler and
features. The expanded key requires one initial rebuild of the patched runtime.
Only the credential-free default-branch warmer may populate shared caches.

Bundling retries the observed AppImage type2-runtime and Tauri vendor-tool
download failure chains for HTTP 500/502/503/504, at most three attempts with 2s/4s backoff. Every attempt
streams output and remains in the bundle log. Compilation, runtime preparation
and package validation are outside this retry boundary; other errors fail
immediately. This handles transient upstream download failures without
repeating the expensive build phases.
