# Bundled Silo guest images

Silo ships one recommended Ubuntu 24.04 image for the app's CPU architecture.
curl, Git, Git LFS, gh, CA certificates and Silo's credential helper are installed while
building that image. The unpublished v3 recipe also bundles sudo, Python 3 and
OpenSSH's SFTP server for offline working-account provisioning. Silo creates
the working account when it creates a VM; no Silo working account, token,
identity or user data enters the image.
Additional supported Ubuntu releases can be provided as prepared downloads later;
there is no version picker or arbitrary-image compatibility promise in this change.

## Publication and app builds

The public standard container package is
`ghcr.io/0xpolarzero/silo-guest:ubuntu-24.04-v2`, with `-arm64` and `-amd64` tags.
The matching [versioned release](https://github.com/0xpolarzero/silo/releases/tag/guest-ubuntu-24.04-v2)
contains compressed Docker-save archives, package inventories in JSON manifests,
SHA256SUMS, the recipe, setup script and source commit. The image itself retains
Ubuntu's package copyright files under `/usr/share/doc`.

`.github/workflows/guest-image.yml` publishes using GitHub's short-lived job token
with package and release write permissions. The recipe's OCI source and revision
labels link the image to its code. Check package visibility after first publication and change it to Public if needed;
anonymous pulls must be verified. This publication was already public.
Published version tags are never intentionally reused. Increment the version in
the recipe, build script and workflow for an image update. The workflow refuses
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

## Guest image v3 candidate

The v3 recipe adds `sudo`, `python3` and `openssh-sftp-server`. Account setup
uses these tools locally and refuses an image missing them. New-VM creation
must not download or repair packages to establish the working account. The
optional desktop retains its separate package and KasmVNC downloads.

Both v3 architecture archives have been built. The checked-in lock now records
their exact candidate manifests and hashes. ARM64 staging succeeded using the
local candidate while its download function was forced to fail. This establishes
local staging without downloads. Both images passed seven Docker tests with
networking disabled, covering bundled tools, normal-user SFTP, and missing-tool
or preinstalled-account rejection. Compressed archive sizes are 85,801,668 bytes
for ARM64 and 87,799,791 bytes for AMD64.

The ARM64 MicroSandbox candidate also passed provisioning, exec/SSH identity,
SFTP/SCP permissions, Git/LFS roundtrips and restart persistence with `--net none`.
All eight missing-tool cases failed preflight without package-manager calls;
package-manager traps stayed untouched throughout the successful workflow.
Evidence is under `src-tauri/target/verification/working-account/offline-v3/`.
The isolated macOS debug bundle `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Account Verification.app` built successfully. The full offline suite passed using its bundled runtime, library and guest image; its archive and manifest match the ARM64 lock. Evidence: `target/verification/working-account/offline-v3-packaged/{live.log,image-verification.json}`. The GUI was not launched; Linux/KVM execution remains untested.

V3 has not been published. Publish the exact locked archives before merging or
shipping; cold builds cannot retrieve the unpublished release. The public v2
release remains available, but lacks the new account prerequisites. Earlier
v1/v2 verification below does not establish v3 offline account setup or release
readiness.

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
