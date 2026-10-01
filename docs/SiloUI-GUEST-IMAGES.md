# Bundled Silo guest images

Silo ships one recommended Ubuntu 24.04 image for the app's CPU architecture.
curl, Git, Git LFS, gh, CA certificates and Silo's credential helper are installed while
building that image. The v3 image also bundles sudo, Python 3 and
OpenSSH's SFTP server for offline working-account provisioning. Silo creates
the working account when it creates a VM; no Silo working account, token,
identity or user data enters the image.
Additional supported Ubuntu releases can be provided as prepared downloads later;
there is no version picker or arbitrary-image compatibility promise in this change.

## Publication and app builds

The public standard container package is
`ghcr.io/0xpolarzero/silo-guest:ubuntu-24.04-v3`, with `-arm64` and `-amd64` tags.
The matching [versioned release](https://github.com/0xpolarzero/silo/releases/tag/guest-ubuntu-24.04-v3)
contains compressed Docker-save archives, package inventories in JSON manifests,
SHA256SUMS, the recipe, setup script and source commit. The image itself retains
Ubuntu's package copyright files under `/usr/share/doc`.

`.github/workflows/guest-image.yml` publishes using GitHub's short-lived job token
with package and release write permissions, only after a reviewer approves the
`guest-image-publish` environment. Create that environment once with required
reviewers and a deployment branch rule for `publish-guest-*`; the workflow refuses
to publish while the environment has no required reviewers. The recipe's OCI source and revision
labels link the image to its code. Check package visibility after first publication and change it to Public if needed;
anonymous pulls must be verified. This publication was already public.
Published version tags are never intentionally reused. For an image update,
increment `GUEST_IMAGE_VERSION` in `app/SiloUI/scripts/build-guest-image.mjs`
(and the recipe as needed); the workflow derives the release tag, title and
container image names from it and from the publishing repository. The workflow refuses
publication once its companion release or an architecture tag exists. If publication
fails halfway, recover the exact already-built artifacts; do not rebuild over the
version. Otherwise increment the version.

`app/SiloUI/guest-image/image-lock.json` pins the exact release archive SHA-256,
length, uncompressed archive length and Docker config digest for each architecture.
Normal `npm run runtime:prepare` downloads that exact archive once and stages it
under `src-tauri/runtime/guest-image`. It does not require Docker. Cached or local
artifacts must pass the same checksum; mismatches never silently reach an app.

To produce a candidate image locally, with Docker available:

```sh
node app/SiloUI/scripts/build-guest-image.mjs arm64
node app/SiloUI/scripts/build-guest-image.mjs amd64
```

Build outputs are ignored under `src-tauri/guest-image-artifacts/<architecture>`.
The Dockerfile-specific ignore file limits the Docker context to the recipe and
setup script. Build credentials and unrelated app files are not sent to Docker.
The base Ubuntu index is pinned. Apt packages are resolved at image publication
and their complete versions recorded; this is a tested, immutable distributed
artifact, not a promise that rebuilding the recipe later yields identical bytes.
App builds reuse the publication, not a fresh apt installation.

After publication, review both attached manifests and copy them into the lock's
`images.arm64` and `images.amd64` entries. Verify both archives against those
manifests before committing the lock. Updating a lock does not update existing
VMs; restored backups also retain their guest systems.

## Guest image v3 publication

The v3 recipe adds `sudo`, `python3` and `openssh-sftp-server`. Account setup
uses these tools locally and refuses an image missing them. New-VM creation
must not download or repair packages to establish the working account. The
optional desktop retains its separate package and KasmVNC downloads.

The public [v3 release](https://github.com/0xpolarzero/silo/releases/tag/guest-ubuntu-24.04-v3)
was produced by [publication run 35546417121](https://github.com/0xpolarzero/silo/actions/runs/35546417121)
from source `a9827c263df3daee28959b2c2073d85c6f980e9d`. The checked-in lock
records these published archives:

| Architecture | Compressed bytes | SHA-256 |
| --- | ---: | --- |
| ARM64 | 85,767,229 | `03f592e602afb0fff724a1f82a5866571356d398b4a3edae1bc15d3a7360efc0` |
| AMD64 | 87,768,822 | `8a3bf159c1d038626ef98a6e7c505ba1834a259f41886f4d14eba6a99d4f9566` |

Earlier local candidates passed seven Docker tests per architecture with
networking disabled. The ARM64 candidate passed account provisioning,
exec/SSH identity, SFTP/SCP permissions, Git/LFS roundtrips and restart
persistence with `--net none`; all eight missing-tool cases failed preflight
without package-manager calls. The isolated macOS debug bundle also passed
this suite using its bundled candidate. Evidence is under
`target/verification/working-account/offline-v3/` and `offline-v3-packaged/`.

Those candidates differ from the published archive hashes. The actual published
ARM64 archive subsequently passed all 13 offline live test groups using the
signed packaged runtime, with its public archive hash verified. Evidence:
`target/verification/working-account/offline-v3-published/live.log`.
The GUI was not launched, and Linux/KVM execution remains untested.

## Guest image v4 recipe (unpublished)

`GUEST_IMAGE_VERSION` is `ubuntu-24.04-v4`. `guest-image/image-lock.json` still
pins the published v3 images; v4 is not published and no app uses it. Publication
needs the owner's reviewer approval in the `guest-image-publish` environment and
is not triggered by the recipe change. When v4 is published, copy both manifests
into the lock and add a changeset in the same change that first uses it.

v4 builds on the unchanged v3 layer (`setup-github.sh`, sudo, Python 3, OpenSSH
SFTP server) and adds, in one further layer:

- **Desktop.** The package list of `src-tauri/guest/setup-desktop.sh` with the same
  `--no-install-recommends` (Xfce session, panel, settings, xfwm4, Thunar, terminal,
  Greybird, Xvfb, PulseAudio, AT-SPI core and the X utilities), and the pinned
  Selkies 2.0.0 `.deb` for the build architecture from `desktop-streamer-lock.json`.
  The `.deb` is downloaded, SHA-256 verified, installed and deleted inside one
  `RUN`; the lock and the poller are `RUN --mount=type=bind` inputs. Never `COPY` a
  package file and delete it later: that keeps it (about 60 MB) in a layer.
  The runtime pieces of `setup-desktop.sh` (Selkies web-client patch, connection
  credentials, receipts, `silo-desktop`) are not part of the image.
- **ChatGPT and LCU system libraries.** The LCU `SYSTEM_PACKAGES` (checked against
  v0.8.0,
  [source](https://github.com/0xpolarzero/lcu/blob/v0.8.0/scripts/install.py)),
  a superset of the ChatGPT Linux `.deb` dependencies on Ubuntu 24.04, so LCU
  installs with `--skip-system --offline`. No OpenAI file and no installed LCU
  are in the image.
- **LCU archive.** `src-tauri/guest/lcu-lock.json` is the one place that pins LCU
  (version, and URL and SHA-256 per architecture; the ChatGPT app lock's
  `lcuVersion` must agree, which a test checks). The same `RUN` downloads the
  archive for the build architecture, verifies it with `sha256sum --check` and
  keeps it unextracted as `/usr/local/share/silo/lcu/lcu-<version>-linux-<arch>.tar.gz`
  (5.6 MB); the lock is a bind mount, never a `COPY`. The marker lists the
  `lcu-archive` capability. `verifyGuestImage` re-checks the archive hash against
  the lock and that `/opt/lcu`, `/usr/lib/chatgpt` and `/opt/silo` do not exist. A VM
  installs the archive against the mounted app at boot
  ([built-in computer use](SiloUI-DESKTOP.md#built-in-computer-use)); if the lock is
  bumped without a new image the VM downloads and verifies the new archive instead.
- **Accessibility defaults.** `gsettings-desktop-schemas`, the dconf stack,
  `/etc/dconf/profile/user` (`user-db:user`, `system-db:local`) and
  `/etc/dconf/db/local.d/00-silo-accessibility` with
  `toolkit-accessibility=true`, compiled by `dconf update`. This sets
  `org.a11y.Status.IsEnabled` in each session (Firefox exposes web content; GTK and Qt
  already do).
- **Chromium/Electron poller.** `src-tauri/guest/silo-accessibility.py` is installed
  as `/usr/local/libexec/silo-accessibility` and autostarted by
  `/etc/xdg/autostart/silo-accessibility.desktop` in any Xfce session. It calls
  `getAttributes()` and `getRelationSet()` on each application root and its first
  five children, which makes Chromium expose full web trees (Chrome 154: 4 to 242
  nodes; ChatGPT Electron: 2 to 28). It skips handled applications and backs off
  from 2 s to 10 s when nothing changes. It needs `python3-pyatspi`.
  Applications are identified by process id (never by name, which is a call into the
  application); AT-SPI calls time out after 1 s, a sweep is bounded to 6 s, and an
  application that responds slowly is skipped for 60 s. Autostart never restarts
  anything and libatspi aborts the process (exit 133) when the accessibility bus
  cannot be activated, so the same file also acts as its own supervisor: by default it
  waits (backoff up to 30 s, 10 minutes at most) until `org.a11y.Bus.GetAddress`
  succeeds, then runs `--worker` as a child and restarts it after abnormal exits
  (backoff 1 s to 30 s, giving up after 10 consecutive runs shorter than a minute).
- **Text editor.** GNOME Text Editor (GTK4) replaces Mousepad and is the system
  default for `text/plain` and a few common text types in `/etc/xdg/mimeapps.list`
  (`xdg-mime query default text/plain` gives `org.gnome.TextEditor.desktop`). GTK
  3.24's AT-SPI `PasteText` has a use-after-free that crashes every GTK3 text view.
  When launching it for automation, use `gnome-text-editor --standalone` so each
  launch is its own process rather than a request to an existing instance.

The apt lists and caches are removed in the same layer, and
`/usr/local/share/silo-packages.txt` is regenerated after the desktop packages.
`verifyGuestImage` also checks the desktop, poller, dconf and editor defaults, and
that Mousepad is absent. Measurements are in [guest image size](SiloUI-GUEST-IMAGE-SIZE.md).

## Runtime behavior

The app validates the bundled image before importing it into its private
MicroSandbox cache. It decompresses a bounded temporary Docker archive because
the bundled runtime's `image load` does not accept an outer gzip stream. Creation
uses the verified cached image with pulling disabled. Missing/corrupt/wrong-CPU
images fail visibly; there is no package-install or online-image fallback.
GitHub access, Git identity and secrets remain separate live configuration.

## Sources

- [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry): OCI/Docker support, job-token publication, source labels, default private visibility and anonymous public pulls.
- [Docker build context](https://docs.docker.com/build/concepts/context/): Dockerfile-specific ignore files restrict uploaded build inputs.
- [Docker save](https://docs.docker.com/reference/cli/docker/image/save/): portable image archive export.

See [the initial size measurement](SiloUI-GUEST-IMAGE-SIZE.md) for the earlier
experiment. Final published archive sizes are authoritative in the image lock.

## Verification on 2026-09-10 (guest image v1)

The image publication run succeeded:
https://github.com/0xpolarzero/silo/actions/runs/34452627515
Source recipe commit: `e9d90f58acb45689931e371d008fd0c81015571a`.
Anonymous GHCR requests returned HTTP 200 for the multi-architecture image and
both platform manifests. Each platform's config digest matches the corresponding
published archive manifest and the checked-in lock. Compressed archive sizes are
67,674,633 bytes (ARM64) and 69,442,016 bytes (x86-64).

Local verification used Apple Silicon and disposable MicroSandbox homes/VMs:

- Published archives passed checksum/size verification, and the packaged app
  resource matched the ARM64 lock.
- Offline Docker tool checks passed on both architectures in the publication job.
- MicroSandbox imported the archive, created with `--pull never`, booted to run
  Git/LFS/gh and integration checks, and returned to Stopped. Registry proxy
  access was blocked during the isolated import/creation check.
- Two concurrent calls to the production import helper performed exactly one
  cold-cache import. A later call used a runner that rejects any attempted
  reimport. Registry access was blocked and temporary archives were removed.
- Existing live GitHub bootstrap/identity and secrets rotation/removal tests
  passed using the new image. These tests require HTTPS test endpoints; they are
  separate from the offline image test. No real account credentials were used.
- The real app created `image-check`, displayed “Preparing the bundled VM image…”
  in the existing progress row, and settled at Stopped. The disposable VM was
  removed and the pre-existing `dev` VM stayed Stopped. No onboarding reset or
  user secret change was performed. Native accessibility observations were used;
  the screenshot provider was unavailable.

Backup verification exposed two existing compatibility gaps relevant to freshly
created Silo VMs. Backup now accepts and restores only the exact credential-free
GitHub bootstrap network preset; custom policies, host secret references and
nonempty secret values remain rejected. The pinned MicroSandbox patch compares
cache metadata JSON structurally when serialized map ordering differs, while
all image blobs/filesystem artifacts retain byte-for-byte comparison. Existing
cache contents are never overwritten on equivalence or conflict.

Final checks passed: all 584 frontend tests, 249 native tests plus five build
configuration tests, and four opt-in live tests (concurrent image import,
GitHub/identity, secrets, and backup/restore). Backup restored root and workspace
files, Git identity and the default GitHub profile into both cold and warm caches.
The debug app was rebuilt with `npm --prefix app/SiloUI run desktop:build:debug`;
its bundled image matched the lock and `codesign --verify --deep --strict` passed.
The rebuilt production-mode app was reopened at
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app` and showed only the
preserved `dev` VM, Stopped. It remains open for testing. This is a local debug
build, not a notarized release.

Linux hardware/KVM and a Linux desktop bundle have not been exercised locally.
The two architecture image builds do not substitute for those checks. No optional
Ubuntu downloads or selection UI is implemented in this slice.

## Guest image v2 verification on 2026-09-14

Version 2 adds curl to new VMs. Existing VM disks and restored backups retain
their packages; install curl inside those VMs with
`apt-get update && apt-get install -y curl` (as root).

[Image publication](https://github.com/0xpolarzero/silo/actions/runs/34837327776)
built ARM64 and AMD64 and ran curl, Git, Git LFS, gh and credential-helper checks
with container networking disabled before publishing. Curl also read a local
file through its file protocol. Both manifests record curl 8.5.0-2ubuntu10.13.

Both downloaded archives passed compressed SHA-256, compressed size, uncompressed
size and Docker configuration digest checks before updating the application lock.
The six guest-image staging tests, 16 release-tooling tests, type checking and
lint passed locally. These checks establish image contents and packaging inputs;
they do not establish live VM networking or installation/upgrade acceptance.

A disposable ARM64 MicroSandbox VM also booted from the verified downloaded v2
archive with `--pull never`. `curl --version` and
`curl -fsS --max-time 20 https://example.com -o /dev/null` both exited successfully.
The test used a separate `/private/tmp/silo-curl-vm-check` home and the existing
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/MacOS/msb` helper
with its bundled `Contents/Frameworks/libkrunfw.5.dylib`. The disposable VM was
stopped afterward. This checks the new image on the existing VM engine, not a
rebuilt or installed 0.4.2 app. No user VM was modified.
