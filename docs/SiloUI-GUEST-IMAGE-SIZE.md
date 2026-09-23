# Guest image size measurement

Measured 2026-09-09 on Apple Silicon using Docker/OrbStack, linux/arm64.
This is a packaging experiment, not an implemented MicroSandbox image import.

Built Ubuntu 24.04 with the unchanged `app/SiloUI/src-tauri/guest/setup-github.sh`,
then removed apt download/index caches and the temporary setup script in the same
layer. Base index: `sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254`.
No credentials or user VM files were included.

| Measurement | Bytes |
| --- | ---: |
| Docker image layer size | 233951371 |
| Docker save archive | 238564864 |
| gzip-compressed Docker save archive | 66494292 |
| gzip-compressed current macOS debug Silo.app | 48890698 |
| Current app allocated disk space (du -sk × 1024) | 124321792 |

Adding this compressed guest archive means approximately 66.5 MB more download
and installed app storage. Sum of the separately compressed app and image is
115.4 MB; this is not a measured final DMG. Current app plus compressed archive
is approximately 190.8 MB installed, before runtime extraction/cache and VM data.
All displayed MB are decimal. The 234 MB image layer size is not a prediction of
MicroSandbox's exact cache or per-VM allocated disk consumption.

Offline `docker run --rm --network none` verified Git 2.43.0, Git LFS 3.4.1,
and gh 2.45.0. This checks included tools, not actual VM boot or GitHub integration.
The disposable Docker image was removed; builder cache was not globally pruned.
No x86-64 image or release-signed app was measured. No other development toolchains
are included. These totals include Ubuntu itself, not just added tools.

Commands: docker build --platform linux/arm64; docker image inspect; docker image
save; gzip; tar -czf for the current app; du -sk for installed app allocation.

Background sources: [MicroSandbox OCI images](https://microsandbox.dev/platform/local)
and [Docker image build practices](https://docs.docker.com/build/building/best-practices/).

## Current v3 archives and Bluefin comparison, 2026-09-22

The September 9 experiment above predates the current published image. Reading
`app/SiloUI/guest-image/image-lock.json` gives these pinned v3 archive sizes
(decimal MB):

| Architecture | Compressed archive | Uncompressed Docker-save archive |
| --- | ---: | ---: |
| ARM64 | 85.77 MB | 295.77 MB |
| AMD64 | 87.77 MB | 269.18 MB |

These are archive lengths, not measured allocated disk use inside a VM. The
base includes Ubuntu and the CLI/account tools described in
[guest images](SiloUI-GUEST-IMAGES.md). Xfce, KasmVNC and desktop tools are
installed separately by `src-tauri/guest/setup-desktop.sh`. Local candidate
archives have different hashes; the table uses the published lock, not those
candidates.

The [desktop research](SiloUI-LINUX-DESKTOP-RESEARCH.md#costs-and-limits) budgets
an additional 0.5–1.5 GB download and 2–5 GB installed for the desktop plus light
browser use. Both ranges are explicitly unmeasured estimates, excluding
profiles and caches. They do not establish the current recipe's actual size.

[Bluefin's installation documentation](https://docs.projectbluefin.io/installation/#disk-usage),
checked September 22, reports approximately 12.4 GB installed for Bluefin and
13.2 GB for Bluefin LTS, including their default Flatpak applications. Developer
mode raises these to 17.4 GB and 14.5 GB respectively. These are upstream disk
usage figures, not compressed download sizes or measurements made in Silo.

An exact desktop-to-desktop ratio remains unmeasured. A valid comparison needs
fresh installations with the same applications, separate compressed transfer
and installed-space measurements, and explicit treatment of shared image
caches and per-VM writable data. No VM was launched or changed for this check.
