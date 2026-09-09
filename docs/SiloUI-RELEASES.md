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

## Rolling GitHub release

`.github/workflows/release.yml` runs on every push to `main`, without path
filters. It also supports manual dispatch on `main`. It builds these existing
runtime targets natively, because the patched MicroSandbox build rejects cross
compilation:

| Host runner | Target | Downloads |
| --- | --- | --- |
| `macos-15` (ARM64) | `aarch64-apple-darwin` | `Silo-macos-arm64.dmg`, `Silo-macos-arm64.app.tar.gz` |
| `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | `Silo-linux-x64.deb` |
| `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | `Silo-linux-arm64.deb` |

Windows and Intel macOS are not supported by the bundled runtime. Linux packages
target Ubuntu 24.04 or compatible newer distributions, rather than claiming the
older glibc minimum of individual bundled components. Local Linux VMs require
KVM. This initial workflow does not publish AppImage or RPM packages.

All three names in the configuration table are repository **Actions secrets** in
`0xpolarzero/silo`; they were configured on 2026-09-10. New repositories need the
same setup under Settings → Secrets and variables → Actions. The workflow checks
their presence before installing dependencies and injects them into the build
environment. Do not put secret values directly in the workflow YAML.

Each matrix job installs Node 24, Rust 1.94.0, and platform prerequisites, runs
frontend tests/lint and native tests, builds release packages, and uploads only
the intended downloads. macOS code signatures and Debian package metadata are
checked. Publication requires every matrix job to succeed and validates that
all four expected downloads exist and are nonempty before changing GitHub.

One serialized publication job updates the `latest` tag to the built commit,
uploads replacement downloads and `SHA256SUMS`, removes obsolete assets, and
updates the existing release notes and GitHub's latest-release designation. It
skips publication if `main` has advanced. Downloads have stable filenames:

- [Rolling release](https://github.com/0xpolarzero/silo/releases/tag/latest)
- [Latest release redirect](https://github.com/0xpolarzero/silo/releases/latest)

A failed build leaves the previous release intact. GitHub asset replacement is
not atomic: a network failure during publication can leave a partial update;
rerun the workflow on current `main` to finish it. This rolling release requires
mutable releases; do not enable release immutability for it. The release tag
tracks the source commit; the app's package version remains the version in
`package.json` and is not incremented automatically.

`GITHUB_TOKEN` has read access in build jobs and `contents: write` only in the
publication job. No personal GitHub token is needed. This adds downloadable
releases, not automatic in-app updates. The workflow starts only after its
files are committed and pushed to `main`.

## Signing and verification limits

macOS release builds currently use `APPLE_SIGNING_IDENTITY=-` for ad-hoc signing.
They are not Developer ID signed or notarized; downloaded apps can require user
approval under macOS security settings. Apple signing/notarization needs separate
Apple credentials and is not supplied by the GitHub App client secret.

Builds and unit tests do not certify GUI behavior, GitHub browser authentication,
VM boot, KVM availability, or the oldest supported OS on every platform. The
first actual Actions run is required to establish Linux packaging evidence.
Existing Swift `app/Silo` smoke scripts test a separate application and do not
validate this Tauri release workflow.

## Local verification on 2026-09-10

- `npm --prefix app/SiloUI run desktop:build:debug`: passed using the local file
  with no GitHub variables exported. All three configured values were confirmed
  present in the built executable without printing their contents.
- `codesign --verify --deep --strict app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`:
  passed. The app was rebuilt, not launched for an authentication test.
- `cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml --offline --locked -- --test-threads=1`:
  241 native tests and 5 configuration tests passed; 6 live tests remained ignored.
  The restricted sandbox initially blocked four local-socket tests; the same
  suite passed outside that sandbox without code changes.
- `python3 -m unittest discover -s app/SiloUI/scripts -p 'test_publish_release.py'`:
  4 tests passed, covering incomplete matrices, superseded commits, initial
  creation, and updates to an existing release.
- `actionlint .github/workflows/release.yml`: passed with actionlint 1.7.7.
- The local JSON file is Git-ignored and mode `0600`; secret names were verified
  in GitHub Actions. The client secret does not appear in tracked or unignored
  task files. The Actions matrix has not yet run.

## References

- [Tauri GitHub Actions packaging](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- [GitHub hosted runner labels and architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub CLI release editing](https://cli.github.com/manual/gh_release_edit)

These primary sources informed runner selection, dependencies, signing, and
rolling release behavior on 2026-09-10. Repository target support is defined in
`app/SiloUI/scripts/microsandbox-runtime.mjs` and `git-runtime.mjs`.
