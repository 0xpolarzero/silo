# SiloUI runtime packaging

Status: MicroSandbox, Git, and Git LFS packaging is complete. Native onboarding still uses fixtures. This work does not implement pushes, finish native preflight, install, repair, start, or create a MicroSandbox.

## Pinned runtime

Silo packages the matching artifacts from the official [MicroSandbox v0.6.17 release](https://github.com/superradcompany/microsandbox/releases/tag/v0.6.17). The release source is commit [`5eca4de8bf233e57f114140f8c076ea8c96f21ab`](https://github.com/superradcompany/microsandbox/tree/5eca4de8bf233e57f114140f8c076ea8c96f21ab). That commit pins libkrunfw to [`21cb6dce19a615f63e41ecb913334d18560c1364`](https://github.com/superradcompany/libkrunfw/tree/21cb6dce19a615f63e41ecb913334d18560c1364), and its [release workflow](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/.github/workflows/release.yml) names libkrunfw 5.6.1 and the matching platform assets.

| Rust target | `msb` asset and SHA-256 | libkrunfw asset and SHA-256 |
| --- | --- | --- |
| `aarch64-apple-darwin` | `msb-darwin-aarch64` `2d3b8883da496ca7ec54f4ea122984022160295f9e4df2af198348fd1f24cdde` | `libkrunfw-darwin-aarch64.dylib` `20b588c2031519cee3ad93fee4b2a0ca4805f2a3c721198911a6248fd34f65e0` |
| `aarch64-unknown-linux-gnu` | `msb-linux-aarch64` `bab283cb12902838cff629f10b28683d322ae8ce09cc2d720e90d1b169857878` | `libkrunfw-linux-aarch64.so` `b5d205d504c3e1876c47dbb674534436b7aabc09b0fdb32d98b5fff438d9a5b6` |
| `x86_64-unknown-linux-gnu` | `msb-linux-x86_64` `7f79c9d0996fac42b4879f4798c6f985f7981b005af0a9b4b8b1ab5e590daee4` | `libkrunfw-linux-x86_64.so` `d395efaa21984cc6934c900519909a12c8148d9688cfc88f9da3b42132ae32c2` |

These SHA-256 values were computed from the official release assets. The build rejects other bytes and unsupported targets. Tauri builds select their requested target through [`TAURI_ENV_TARGET_TRIPLE`](https://v2.tauri.app/reference/environment-variables/); `SILO_RUNTIME_TARGET` provides an explicit standalone override, and direct preparation otherwise uses `rustc --print host-tuple`.

Tauri's [`externalBin`](https://v2.tauri.app/develop/sidecar/) packages the target-qualified `msb` sidecar. Tauri [`resources`](https://v2.tauri.app/develop/resources/) package the manifest, notices, and licenses. Both `beforeDevCommand` and `beforeBuildCommand` run preparation before Tauri needs those generated inputs. Preparation uses a checksum-validated build cache and performs no runtime download.

The manifest records the target, versions, release assets, packaged filenames, and staged-input hashes without claiming one cross-platform runtime path. The observed macOS bundle layout is:

```text
Contents/MacOS/msb
Contents/Frameworks/libkrunfw.5.dylib
Contents/Resources/microsandbox/manifest.json
Contents/Resources/THIRD-PARTY-NOTICES.md
Contents/Resources/microsandbox/licenses/*
```

The app, sidecar, and library are signed together. The app and `msb` carry Apple's [Hypervisor entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.hypervisor). Library validation is not disabled. Signing changes Mach-O bytes, so the release hashes prove staged inputs, while the macOS packaged integrity check must validate the app signature. The app bundle declares macOS 14.0; the upstream `msb` Mach-O declares 11.0.

The later launcher must use only these private paths and set `MSB_PATH`, `MSB_LIBKRUNFW_PATH`, and an app-controlled `MSB_HOME`. Upstream resolves both environment paths first in its [runtime configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/config/mod.rs). It must not search `PATH` or a user's global MicroSandbox directory.

MicroSandbox is Apache-2.0. libkrunfw is LGPL-2.1-only and embeds GPL-2.0-only or compatible Linux sources. Exact license texts and source commits are in the bundle. Before external distribution, choose and review a compliant corresponding-source conveyance method. The current preparation is not release legal approval.

## Pinned Git distribution

Silo packages the required client runtime from the matching tar archive in [dugite-native v2.53.0-4](https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4), commit [`4098283a7ecb8a227b9d43580336c78a06f90e5d`](https://github.com/desktop/dugite-native/tree/4098283a7ecb8a227b9d43580336c78a06f90e5d). Dugite-native is the portable Git distribution maintained for GitHub Desktop. The selected release is its current, GitHub-signed release and supplies upstream SHA-256 values. Its [stated roadmap](https://github.com/desktop/dugite-native/blob/4098283a7ecb8a227b9d43580336c78a06f90e5d/README.md#roadmap) tracks stable Git updates. This makes the pin suitable now, but release work must still monitor new Git and dugite-native security releases. Silo retains [Git 2.53.0](https://github.com/git/git/tree/67ad42147a7acc2af6074753ebd03d904476118f), [Git LFS 3.7.1](https://github.com/git-lfs/git-lfs/tree/b84b33847fe6458f36ef521534dc0eac953cb379), Git's HTTPS transport, templates, and the Linux CA certificate bundle. It excludes Scalar, Git Credential Manager, server programs, and unrelated helpers. Later pushes must use only short-lived Silo-controlled credentials.

| Rust target | Dugite-native archive | SHA-256 |
| --- | --- | --- |
| `aarch64-apple-darwin` | `dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz` | `f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe` |
| `aarch64-unknown-linux-gnu` | `dugite-native-v2.53.0-4098283-ubuntu-arm64.tar.gz` | `a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af` |
| `x86_64-unknown-linux-gnu` | `dugite-native-v2.53.0-4098283-ubuntu-x64.tar.gz` | `cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901` |

Preparation uses the same target selection as MicroSandbox, verifies the complete upstream archive before extraction, rejects unsafe archive paths and unsupported targets, retains the explicit client-runtime allowlist, checks Git, Git LFS, HTTPS transport, templates, certificates, executable modes, and contained symbolic links, then replaces `src-tauri/runtime/git/`. It also materializes target-qualified Tauri sidecars for Git and each helper under the ignored `src-tauri/binaries/` directory. Materializing `git-remote-https` removes the upstream helper symlink before relocation, so no packaged link can point into the staging or build tree. Generated archives, caches, sidecars, and extracted files remain ignored. Node and `tar` are build-time tools only; the Tauri app has no Node runtime and performs no runtime download.

Tauri packages the executables next to the app executable and signs each one through its established sidecar path. It packages templates, licenses, the manifest, and the Linux certificate bundle under the resource directory. The later native adapter must resolve these fixed packaged paths:

```text
<executable directory>/git
<executable directory>/git-lfs
<executable directory>/git-remote-http
<executable directory>/git-remote-https
<resource directory>/git-support/share/git-core/templates
<resource directory>/git-support/ssl/cacert.pem       Linux only
<resource directory>/git-support/manifest.json
<resource directory>/git-support/licenses/*
```

It must invoke the packaged `git` by absolute path. It must set `GIT_EXEC_PATH` to the executable directory, `GIT_TEMPLATE_DIR` to the private template tree, and the Linux `GIT_SSL_CAINFO` to the private certificate bundle. Its fixed process environment must set `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CONFIG_GLOBAL=/dev/null`, a Silo-owned `HOME` and `XDG_CONFIG_HOME`, and a fixed `PATH` containing the executable directory and only required operating-system utility shims. It must never inherit the user's `PATH` or Git configuration. Required credentials must be supplied for one operation by the native adapter, not persisted in the VM.

Every packaged Mach-O executable must pass individual signature verification after packaging. A successful `git --version` or outer `codesign --deep` check alone does not establish this. Tauri does not re-sign executable files copied as resources, so Git, Git LFS, and both HTTPS helper names are configured as external binaries instead. Tauri's [macOS bundler source](https://github.com/tauri-apps/tauri/blob/tauri-bundler-v2.9.4/crates/tauri-bundler/src/bundle/macos/app.rs) adds every external binary to the inner-to-outer signing list. It signs each with the configured identity and hardened-runtime option before it signs the outer app. The debug configuration applies ad hoc hardened-runtime signatures. A release build applies the configured Silo identity to every executable through the same Tauri signing operation. Git declares macOS 11.0 and Git LFS declares macOS 12.0. Both are below Silo's declared macOS 14.0 minimum.

The macOS archive contains no private dynamic libraries in the retained runtime. Git links to the system CoreServices and CoreFoundation frameworks plus `libz`, `libiconv`, and `libSystem`. Its HTTPS helper also links to system `libcurl` and `libexpat`. Git LFS links to `libSystem`, `libresolv`, CoreFoundation, and Security. These are platform libraries covered by Silo's macOS minimum.

The Linux archives were built on Ubuntu 22.04 and reference glibc 2.34. Git directly requires glibc and `libz`; Git LFS is static. The HTTPS helper directly requires glibc, `libz`, and `libcurl.so.4`. The Tauri Debian configuration now declares `libc6 (>= 2.34)`, `libcurl4 | libcurl4t64`, and `zlib1g`; the RPM configuration declares `glibc`, `libcurl`, and `zlib`. Tauri's RPM dependency setting cannot express a minimum version, so RPM release validation must separately reject glibc older than 2.34. Tauri's [AppImage bundler source](https://github.com/tauri-apps/tauri/blob/tauri-bundler-v2.9.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs) creates Debian-style data first, placing every external binary in `usr/bin` before linuxdeploy scans the existing ELF files and copies non-baseline shared-library dependencies into the AppDir. A Linux AppImage build must still verify that the produced image contains a usable `libcurl.so.4` chain. MicroSandbox alone can run with glibc 2.28, but bundled Git raises Silo's combined Linux floor to glibc 2.34.

Git and dugite-native use GPL-2.0. Git LFS uses MIT plus its recorded component terms. The Linux CA bundle is curl's conversion of Mozilla's CA store and uses MPL-2.0. Exact pinned license texts are packaged under `git-support/licenses/`. External distribution still requires legal review and a compliant corresponding-source offer for GPL components.

## Approved push boundary

The future native implementation keeps two push routes:

- When VM pushes are enabled, tools in the VM may push through Silo-controlled GitHub access. GitHub credentials remain on the host.
- When VM pushes are disabled, guest pushes stay blocked. The user may select commits and click Push in Silo, which pushes from the host.

App Push never grants standing push permission to the VM. It uses the bundled Git and Git LFS, standard Git transfers, only required committed Git/LFS data, and incremental transfer where the protocol supports it. This section settles packaging and the push boundary. It does not claim that either route or native GitHub credential forwarding is implemented.

## Dependency assessment

No SiloUI native code currently invokes Git, Git LFS, tar, gtar, or zstd. The visible backup and repository operations are fixtures.

| Current row | Finding | Recommendation requiring approval |
| --- | --- | --- |
| `git` | Approved and packaged for future host-side pushes. Native push and preflight invocation are not implemented. | Keep the current row unchanged. Later read-only preflight must run only bundled `git --version`. |
| `git-lfs` | Approved and packaged with Git for future host-side LFS pushes. Native push and preflight invocation are not implemented. | Keep the current row unchanged. Later read-only preflight must run only bundled `git-lfs version`. |
| `tar / gtar` | No current native consumer. MicroSandbox implements snapshot tar handling in Rust in its [snapshot archive module](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/snapshot/archive.rs). Silo does not use the separate upstream installation shim that shells out to tar. | Remove from onboarding now. Select a library when Silo's real backup boundary is implemented. |
| `zstd` | No current native consumer. The same upstream snapshot module performs zstd compression internally. | Remove from onboarding now. Select a library when Silo's real backup boundary is implemented. |

The remaining thresholds also lack a current SiloUI requirement:

- `macOS 26+`: unsupported by the package evidence. The app declares 14.0, but compatibility still needs a real oldest-host test before changing the label.
- `Apple Silicon`: supported. The pinned upstream macOS release has only an arm64 artifact.
- `20 GiB free`: no measured Silo plan supports this fixed minimum. Upstream currently defaults each managed writable root disk to 4 GiB in its [sandbox configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/sandbox/config.rs), but actual image, workspace, and backup budgets vary.
- `16 GiB memory`: no measured Silo plan supports this fixed minimum. Upstream defaults one sandbox to 512 MiB in its [global configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/config/mod.rs).

Pending decisions, unchanged by this work:

1. May we remove the `tar / gtar` and `zstd` onboarding rows and defer each check to its actual feature?
2. May we replace or defer `macOS 26+`, `20 GiB free`, and `16 GiB memory` after compatibility and capacity tests establish real thresholds?

This preparation leaves every row, label, layout, and interaction unchanged.

## Proposed real checks

1. Resolve the app-private manifest, sidecar, and library by fixed platform layout; validate the manifest schema, pinned target and versions, files, and the macOS bundle signature or Linux staged hashes. Run only packaged `msb --version` with fixed arguments, bounded output, private environment paths, an empty `MSB_HOME`, and fixed per-probe and total timeouts; require its output to match the pinned version.
2. On macOS require macOS at or above the bundle minimum, `arm64`, and Apple's documented [`kern.hv_support`](https://developer.apple.com/documentation/hypervisor) value of `1`. On Linux require the CPU to match a packaged `aarch64` or `x86_64` target, glibc 2.34 or newer for the combined package, and [`KVM_GET_API_VERSION`](https://docs.kernel.org/virt/kvm/api.html#kvm-get-api-version) on `/dev/kvm` to return `12`; close the descriptor without calling `KVM_CREATE_VM` or otherwise creating a VM. MicroSandbox alone supports glibc 2.28 under its [upstream platform requirements](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/docs/cli/overview.mdx), but bundled Git raises Silo's current Linux floor to 2.34.
3. Treat missing, unsupported, permission-denied, timed-out, malformed, and invoke-failure results as unsuccessful; none may pass by fallback or absence.
4. Add read-only bundled `git --version` and `git-lfs version` probes to the remaining native preflight integration. Resolve only the private paths and isolated environment above. These probes prove the selected versions, not HTTPS helper or push usability. Keep deterministic fixtures isolated to tests and explicit fixture launches. Do not add archive-tool, installation, repair, sandbox-creation, legacy handshake, or `msb doctor` checks.
5. Add focused native success and failure tests. Assert the exact complete state and that `Continue` enables only after every required check succeeds. Assert the exact failure detail and remediation, disabled `Continue`, and keyboard Space toggling of the disclosure's `aria-expanded` state and detail visibility.

## MicroSandbox packaging verification record

- `npm --prefix app/SiloUI test -- src/test/microsandbox-runtime.test.ts src/features/onboarding/components/onboarding-preparation.test.tsx src/features/onboarding/onboarding-app.test.tsx src/features/onboarding/onboarding-flow.test.tsx src/features/onboarding/onboarding-recovery.test.tsx src/features/onboarding/onboarding-source.test.tsx`: 6 files and 67 tests passed.
- `npm --prefix app/SiloUI test`: 40 files and 369 tests passed.
- `npm --prefix app/SiloUI run typecheck`: passed.
- `npm --prefix app/SiloUI run lint`: passed.
- A disposable fresh-checkout simulation started with the ignored `src-tauri/binaries/` and `src-tauri/runtime/` inputs absent. `npm run desktop` executed `beforeDevCommand`, preparation restored the target-qualified sidecar, manifest, library, and licenses from the validated cache, and a fail-fast Rust wrapper confirmed those files existed at the first Rust invocation. The wrapper then exited intentionally, so this check did not launch the app or another Vite server.
- `cargo test --offline --manifest-path app/SiloUI/src-tauri/Cargo.toml`: 37 tests passed.
- `npm --prefix app/SiloUI run desktop:build:debug`: passed; built `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app`.
- `codesign --verify --deep --strict --verbose=2 "app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app"`: passed. The app, `msb`, and libkrunfw also passed strict component verification; `msb` has `com.apple.security.hypervisor=true`.
- Isolated packaged `msb --version`: returned `msb 0.6.17` and wrote no files under empty `HOME` and `MSB_HOME` directories.
- Exact bundle executable launched with a fresh `SILO_SETTINGS_DIR`, wrote only its isolated `settings.json`, quit through AppleScript, returned status 0, and left no `silo-preview` process.
- `TAURI_ENV_TARGET_TRIPLE=aarch64-unknown-linux-gnu npm --prefix app/SiloUI run runtime:prepare` and the x86_64 equivalent selected the requested cross-build artifact pairs and matched all pinned hashes. Read-only `debian:bookworm-slim` arm64 and amd64 containers each returned `msb 0.6.17` with staged paths mounted read-only and no files under empty `HOME` or `MSB_HOME`.
- Playwright captured current complete collapsed/expanded and dependency-failure collapsed/expanded states at 1160 by 820 under `src-tauri/target/visual-baseline/`. The before screenshots were overwritten, so this evidence verifies current semantics and styling, not a pixel comparison. Keyboard Space toggled the disclosure. Navigation, shared row styling, Applications controls, and footer controls remained unchanged; only approved dependency content and occupied height changed. This is fixture UI evidence, not native preflight evidence.

That MicroSandbox work did not test Linux Tauri bundling, KVM access, VM startup, or oldest-supported-macOS behavior. Its Linux execution coverage was limited to read-only `--version` under Docker. No VM, installer, repair, sandbox, or `msb doctor` command ran.

## Git packaging verification record

- `npm test -- --run src/test/git-runtime.test.ts src/features/onboarding/components/onboarding-preparation.test.tsx`: 2 files and 19 tests passed. These cover target selection, hashes, unsafe archives and links, missing helpers, modes, relocation, manifest paths, Tauri sidecar signing inputs, Linux dependency declarations, and the unchanged dependency view.
- `npm run typecheck` and `npm run lint`: passed. The debug build also reran the TypeScript and Vite production builds successfully.
- `npm run desktop:build:debug`: passed. The bundle is `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app`. A stale ignored `target/debug/git/` directory from the earlier resource layout blocked one rebuild and was removed; a fresh build has no file/directory collision.
- `codesign --verify --deep --strict --verbose=2` passed for the app. Individual strict verification passed for `git`, `git-lfs`, `git-remote-http`, and `git-remote-https`. Tauri replaced every upstream signature with the app's ad hoc debug identity and hardened-runtime signature. The packaged helpers are regular files, not staging-path symlinks.
- `node scripts/verify-git-runtime.mjs ".../Contents/Resources/git-support" ".../Contents/MacOS"` passed with an empty isolated home, disabled system and global Git configuration, a private Git/helper path plus one `/bin/sh` shim, and no global Git executable. Packaged Git returned `git version 2.53.0`; packaged Git LFS returned 3.7.1; the HTTPS helper reached its usage path. A disposable bare remote received one standard Git push and its LFS object. The second identical push reported no changes; this is a repeat/no-op check, not a measurement of incremental-transfer efficiency.
- Target-qualified preparation passed for `aarch64-unknown-linux-gnu` and `x86_64-unknown-linux-gnu`. Disposable Ubuntu 22.04 arm64 and amd64 containers had no global Git, installed only the declared `libcurl4` validation dependency, and ran the exact staged Git, Git LFS, and HTTPS helper. Each pushed Git and LFS data to a local bare remote and completed an unchanged second push. The arm64 artifact reports `git version 2.53.0.dirty`; the manifest requires that exact upstream output.
- ELF symbol inspection confirmed glibc 2.34 for Git and the HTTPS helper on both Linux targets. The helper names `libc.so.6`, `libz.so.1`, and `libcurl.so.4`; Git LFS has no glibc symbol requirement.
- The production UI source did not change. No screenshots were written or overwritten. The existing Git and Git LFS rows remain unchanged.

Tauri's AppImage source path was inspected: it creates Debian-style data first, so the external Git executables are in `usr/bin` before linuxdeploy scans existing ELF files. This coverage does not include a produced Linux Tauri bundle, so it does not prove the final AppImage's libcurl chain. It also excludes an actual HTTPS or GitHub push, real credentials, VM forwarding, KVM, a VM, native preflight commands, oldest supported hosts, notarization, and release-identity signing. It does not implement either approved push route. No user repository changed, and no installer, repair flow, sandbox command, `msb doctor`, or legacy Swift test ran.
