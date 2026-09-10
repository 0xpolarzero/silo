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
