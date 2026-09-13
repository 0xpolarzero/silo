# Linux system updates

Silo's Debian installer registers a signed APT source, so Ubuntu/Xubuntu can
install subsequent releases through Software Updater. AppImage remains an
optional portable download with its existing in-app updater. macOS is unchanged.

## Installation and migration

Install the new Debian package once and accept **Receive Silo updates through
Software Updater?**. A noninteractive installation uses the default, enabled.
The package installs a repository-specific public key and source definition;
it never adds global APT trust or changes Ubuntu's own sources.

An older Silo installation needs this installer once. An in-app banner alone
cannot register the source, and the existing released installers do not contain
these hooks. After enrollment, the normal system refresh discovers Silo updates.
No repeated package downloads or terminal commands are needed for normal updates.
The in-app update card also explains the Software Updater route and retains a
package download fallback for users who opted out.

Quit Silo before applying a system update. Closing its window is not Quit.
Quitting stops local VMs; remote VMs keep running. The installer refuses to
replace a running packaged Silo or its runtime and never kills either process.
New package versions also refuse startup while installation is in progress.
The first migration from an older version cannot enforce that startup guard in
old code, so keep Silo closed during this first installation.

The installed source is `/etc/apt/sources.list.d/silo.sources`, with trust limited
to `/usr/share/keyrings/silo-archive-keyring.gpg`. Software & Updates can disable
it. Upgrades preserve a deleted source and administrator edits such as
`Enabled: no`. `sudo dpkg-reconfigure silo` offers enrollment again. Removal
cleans up an unchanged source; administrator-edited files are retained.
If an edited source remains enabled after removal, disable it in Software &
Updates or remove it: the package-owned signing key is no longer installed.
A system crash during installation can leave a startup guard; finish the
interrupted package transaction with `sudo apt --fix-broken install`.

## Publishing

The source URL is `https://0xpolarzero.github.io/silo/apt`, suite `stable`,
component `main`, architectures `amd64` and `arm64`.

`.github/workflows/apt-repository.yml` runs after **Publish verified Silo draft**
succeeds, manually, and weekly to refresh expiring metadata. It downloads only
public stable releases, verifies both package checksums against `SHA256SUMS`,
validates their internal package/version/architecture, and signs the indexes.
Drafts never enter the repository. The latest release must be the numerically
highest stable release and must not change during publication.

GitHub Pages hosts the latest two complete releases, signed `InRelease` and
`Release.gpg`, and deterministic package indexes. Signed metadata expires in
14 days. Previously signed indexes are retained by hash for clients refreshing
cached metadata. The job fails above a 900 MiB site budget; move the package pool
to larger hosting before increasing retention. Failed builds leave the deployed
site intact. Monitor workflow failures: expired metadata intentionally stops
clients accepting stale updates. GitHub may disable scheduled workflows in a
public repository after 60 days without activity; keep the schedule enabled.
See [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Infrastructure setup:

1. Enable GitHub Pages with GitHub Actions as its build source.
2. Create an `apt-publish` environment restricted to the `main` branch.
3. Store the dedicated ASCII-armored private archive key in that environment's
   `SILO_APT_SIGNING_KEY` secret. Do not use the Tauri updater key. Never commit
   private key material or place it in build artifacts.
4. Merge the workflow, run **Publish Silo system updates**, and verify its Pages
   deployment before publishing an installer that enrolls users.
5. After every application release, confirm the APT workflow succeeds and an
   enrolled test machine sees the new candidate through `apt-cache policy silo`.

The pinned public key fingerprint is
`D870CA15D275FDB538DDC5516F36347AE839F67A`; it expires 12 September 2029.
The public key and fingerprint live in `app/SiloUI/scripts/debian/`.
Keep the private key in a secure backup. Rotate well before expiry: distribute
an installer keyring containing both keys while the old key remains trusted,
then switch signing after clients have that keyring. Never replace the trust
anchor and signing key simultaneously without a migration.

## Verification

Run Python release-tool tests normally. The repository tests require Linux
`apt-get`, `dpkg-deb`, `gpg`, and `gpgv`:

```sh
python3 -m unittest discover -s app/SiloUI/scripts -p 'test_apt_repository.py'
```

They generate disposable signing keys and Debian fixtures, verify that APT
selects the latest candidate, reject tampered metadata and package bytes, and
check retained indexes and complete architecture pairs.

The package lifecycle test installs and removes a dummy `silo` package. Run it
**only in a disposable Linux container or CI runner**, as root:

```sh
SILO_APT_LIFECYCLE_TEST=1 python3 -m unittest discover -s app/SiloUI/scripts -p 'test_debian_installation.py'
```

It covers enrollment, opt-out, a running process refusing replacement without
being killed, successful APT installation, administrator edits, source deletion,
and cleanup. These tests exercise real APT/dpkg with fixtures. They do not prove
Xubuntu's graphical updater, native VM health, or a production release upgrade.

## Local evidence, 13 September 2026

- Debian Bookworm disposable container, real APT/GPG/dpkg: 8 repository tests
  and the installer lifecycle test passed, including an APT upgrade between
  dummy versions. Production credentials were not used by tests.
- Python release tooling: 42 tests passed. Node release tooling: 16 passed.
- Frontend update and onboarding tests: 19 passed; typecheck and lint passed.
- The actual v0.2.2 Debian control archive contains no maintainer hooks that
  conflict with the new packaging step. Both workflow YAML files parse.
- Repository-wide `cargo fmt --check` reports existing formatting differences;
  unrelated Rust code was not reformatted. No new native application bundle,
  live Xubuntu GUI session, or production system update was exercised here.

## Primary references

- [VS Code Linux installation](https://code.visualstudio.com/docs/setup/linux): existing Debian installer enrollment pattern.
- [Ubuntu third-party repositories](https://ubuntu.com/server/docs/explanation/software/third-party-repository-usage/): repository-specific trust.
- [APT source definitions](https://manpages.debian.org/testing/apt/sources.list.5.en.html): deb822 and `Signed-By`.
- [Debian repository format](https://wiki.debian.org/DebianRepository/Format): hashes, relative package paths, and signed metadata.
- [Debconf developer guide](https://manpages.debian.org/unstable/debconf-doc/debconf-devel.7.en.html): installer choices.
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages): deployment permissions and artifacts.
