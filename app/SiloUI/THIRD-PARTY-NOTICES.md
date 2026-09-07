# Bundled MicroSandbox runtime

Silo stages upstream release artifacts from MicroSandbox 0.6.17 without source-level modifications. macOS packaging adds the app's code signature:

- `msb`, licensed under Apache-2.0.
- `libkrunfw` 5.6.1. The library code is LGPL-2.1-only. Its embedded Linux kernel and kernel patches are GPL-2.0-only or compatible licenses.

Upstream provenance:

- Release: https://github.com/superradcompany/microsandbox/releases/tag/v0.6.17
- MicroSandbox source: https://github.com/superradcompany/microsandbox/tree/5eca4de8bf233e57f114140f8c076ea8c96f21ab
- libkrunfw source: https://github.com/superradcompany/libkrunfw/tree/21cb6dce19a615f63e41ecb913334d18560c1364

The license texts are bundled under `microsandbox/licenses/`. Redistribution requirements and the pinned artifact hashes are recorded in `docs/SiloUI-RUNTIME-PACKAGING.md` in Silo's source tree.
