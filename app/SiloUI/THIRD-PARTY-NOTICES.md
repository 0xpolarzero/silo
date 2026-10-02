# Bundled MicroSandbox runtime

Silo builds the MicroSandbox v0.7.6 source with Silo patches for networking, storage, restore, and desktop lifecycle policy. macOS packaging adds the app's code signature:

- `msb`, licensed under Apache-2.0.
- `libkrunfw` 5.6.1. The library code is LGPL-2.1-only. Its embedded Linux kernel and kernel patches are GPL-2.0-only or compatible licenses.

Upstream provenance:

- Release: https://github.com/superradcompany/microsandbox/releases/tag/v0.7.6
- MicroSandbox source: https://github.com/superradcompany/microsandbox/tree/09df3d4b9d832adaede1fb9a198cfc660bfab8cd
- libkrunfw source: https://github.com/superradcompany/libkrunfw/tree/cf4c22b9f05c680928e6d96a9d198f5845573a87

The license texts are bundled under `microsandbox/licenses/`. Redistribution requirements and the pinned artifact hashes are recorded in `docs/SiloUI-RUNTIME-PACKAGING.md` in Silo's source tree.

# Bundled Git and Git LFS

Silo stages the required Git client runtime from the target archive in dugite-native v2.53.0-4, commit `4098283a7ecb8a227b9d43580336c78a06f90e5d`. Dugite-native is the portable Git distribution maintained for GitHub Desktop. Silo retains Git, Git LFS, HTTPS transport, templates, and Linux certificates. It excludes Scalar, Git Credential Manager, server programs, and unrelated helpers.

The archive contains:

- Git 2.53.0, commit `67ad42147a7acc2af6074753ebd03d904476118f`, licensed under GPL-2.0.
- Git LFS 3.7.1, commit `b84b33847fe6458f36ef521534dc0eac953cb379`, licensed under MIT plus component terms recorded in its license.
- Git HTTPS helpers and templates.
- Curl's converted Mozilla CA certificate bundle on Linux, licensed under MPL-2.0.

Upstream provenance:

- Dugite-native release: https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4
- Dugite-native source: https://github.com/desktop/dugite-native/tree/4098283a7ecb8a227b9d43580336c78a06f90e5d
- Git source: https://github.com/git/git/tree/67ad42147a7acc2af6074753ebd03d904476118f
- Git LFS source: https://github.com/git-lfs/git-lfs/tree/b84b33847fe6458f36ef521534dc0eac953cb379
Exact license texts are bundled under `git-support/licenses/`. Git LFS's license includes the copied Go code terms and directs distributors to the licenses of its Go modules; external distribution still requires that dependency-license review. Linux Debian and RPM packages depend on the distribution's libcurl package. AppImage builds copy the build distribution's eligible libcurl dependency chain and must retain the licenses collected by linuxdeploy. Exact target archives, SHA-256 values, packaged path rules, platform limits, and corresponding-source review requirements are recorded in `docs/SiloUI-RUNTIME-PACKAGING.md` in Silo's source tree.

# Bundled Git LFS SSH transfer server

Silo builds charmbracelet/git-lfs-transfer from commit
`971c0284dc33b1ed3f7ed9dde5d4fc0cee62db6b`, licensed under MIT, for Linux
ARM64 or x86-64 guests. This server implements the upstream Git LFS pure SSH
protocol. Silo copies it into a temporary guest directory for each authorized
publish operation; the guest does not receive GitHub write credentials.

- Source: https://github.com/charmbracelet/git-lfs-transfer/tree/971c0284dc33b1ed3f7ed9dde5d4fc0cee62db6b
- Source archive SHA-256: `92d6720202aa5a059c6683df78f1fa47722c0c48ff1dc4ebfc0bc8137d988702`
- Upstream dependencies: https://github.com/charmbracelet/git-lfs-transfer/blob/971c0284dc33b1ed3f7ed9dde5d4fc0cee62db6b/go.mod

The MIT license, Go runtime license, and license/notice files for every linked
external Go module are bundled under `git-support/lfs-transfer/`. The module
list comes from `go list -deps` for the actual guest build target; upstream
`go.sum` and the Go checksum database verify module source. Corresponding
source and redistribution review remain part of release preparation.

# Bundled LCU release archive

Silo's guest image (v4 and later) stages the unextracted LCU release archive for the sandbox's built-in computer use. LCU is MIT-licensed; the license text is inside the archive. The image holds only the archive, in `/usr/local/share/silo/lcu/`; LCU itself is installed from it in the sandbox when computer use is set up.

- Project: https://github.com/0xpolarzero/lcu
- Release: https://github.com/0xpolarzero/lcu/releases/tag/v0.8.1
- Linux ARM64 archive SHA-256: `441649e7afe14dc948caaa5bd94034567e4404fc8c0bb6a450bd692b73161806`
- Linux x86-64 archive SHA-256: `8b0934f8c0c79d40a5073f180db33db8f1568af00177befa4b8da677694731bc`

The pinned URL and hashes are in `app/SiloUI/src-tauri/guest/lcu-lock.json`. The image contains no ChatGPT application.
