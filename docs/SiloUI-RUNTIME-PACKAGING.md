# SiloUI runtime packaging

Status: packaging and dependency-inventory preparation is complete. Native onboarding still uses fixtures. This work does not install, repair, start, or create a MicroSandbox.

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
Contents/Resources/microsandbox/THIRD-PARTY-NOTICES.md
Contents/Resources/microsandbox/licenses/*
```

The app, sidecar, and library are signed together. The app and `msb` carry Apple's [Hypervisor entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.hypervisor). Library validation is not disabled. Signing changes Mach-O bytes, so the release hashes prove staged inputs, while the macOS packaged integrity check must validate the app signature. The app bundle declares macOS 14.0; the upstream `msb` Mach-O declares 11.0.

The later launcher must use only these private paths and set `MSB_PATH`, `MSB_LIBKRUNFW_PATH`, and an app-controlled `MSB_HOME`. Upstream resolves both environment paths first in its [runtime configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/config/mod.rs). It must not search `PATH` or a user's global MicroSandbox directory.

MicroSandbox is Apache-2.0. libkrunfw is LGPL-2.1-only and embeds GPL-2.0-only or compatible Linux sources. Exact license texts and source commits are in the bundle. Before external distribution, choose and review a compliant corresponding-source conveyance method. The current preparation is not release legal approval.

## Dependency assessment

No SiloUI native code currently invokes Git, Git LFS, tar, gtar, or zstd. The visible backup and repository operations are fixtures.

| Current row | Finding | Recommendation requiring approval |
| --- | --- | --- |
| `git` | No current native consumer. A later repository feature can deliberately use a fixed Git executable or an established library such as [gix](https://docs.rs/gix/latest/gix/). | Remove from onboarding now. Defer any check to the repository feature and its selected adapter. |
| `git-lfs` | No current native consumer. It matters only for repositories that use [Git LFS](https://git-lfs.com/). | Remove from onboarding now. Check it only when an enabled repository requires host-side LFS. |
| `tar / gtar` | No current native consumer. MicroSandbox implements snapshot tar handling in Rust in its [snapshot archive module](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/snapshot/archive.rs). Silo does not use the separate upstream installation shim that shells out to tar. | Remove from onboarding now. Select a library when Silo's real backup boundary is implemented. |
| `zstd` | No current native consumer. The same upstream snapshot module performs zstd compression internally. | Remove from onboarding now. Select a library when Silo's real backup boundary is implemented. |

The remaining thresholds also lack a current SiloUI requirement:

- `macOS 26+`: unsupported by the package evidence. The app declares 14.0, but compatibility still needs a real oldest-host test before changing the label.
- `Apple Silicon`: supported. The pinned upstream macOS release has only an arm64 artifact.
- `20 GiB free`: no measured Silo plan supports this fixed minimum. Upstream currently defaults each managed writable root disk to 4 GiB in its [sandbox configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/sandbox/config.rs), but actual image, workspace, and backup budgets vary.
- `16 GiB memory`: no measured Silo plan supports this fixed minimum. Upstream defaults one sandbox to 512 MiB in its [global configuration](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/sdk/rust/lib/config/mod.rs).

Questions for the user:

1. May we remove the `git`, `git-lfs`, `tar / gtar`, and `zstd` onboarding rows and defer each check to its actual feature?
2. May we replace or defer `macOS 26+`, `20 GiB free`, and `16 GiB memory` after compatibility and capacity tests establish real thresholds?

This preparation intentionally leaves those rows and labels unchanged.

## Proposed real checks

1. Resolve the app-private manifest, sidecar, and library by fixed platform layout; validate the manifest schema, pinned target and versions, files, and the macOS bundle signature or Linux staged hashes. Run only packaged `msb --version` with fixed arguments, bounded output, private environment paths, an empty `MSB_HOME`, and fixed per-probe and total timeouts; require its output to match the pinned version.
2. On macOS require macOS at or above the bundle minimum, `arm64`, and Apple's documented [`kern.hv_support`](https://developer.apple.com/documentation/hypervisor) value of `1`. On Linux require the CPU to match a packaged `aarch64` or `x86_64` target, glibc 2.28 or newer, and [`KVM_GET_API_VERSION`](https://docs.kernel.org/virt/kvm/api.html#kvm-get-api-version) on `/dev/kvm` to return `12`; close the descriptor without calling `KVM_CREATE_VM` or otherwise creating a VM. These host requirements match the upstream [MicroSandbox platform requirements](https://github.com/superradcompany/microsandbox/blob/5eca4de8bf233e57f114140f8c076ea8c96f21ab/docs/cli/overview.mdx).
3. Treat missing, unsupported, permission-denied, timed-out, malformed, and invoke-failure results as unsuccessful; none may pass by fallback or absence.
4. Expose one native Tauri command through the existing typed onboarding source. Keep deterministic fixtures isolated to tests and explicit fixture launches. Do not add Git, archive-tool, installation, repair, sandbox-creation, legacy handshake, or `msb doctor` checks.
5. Add focused native success and failure tests. Assert the exact complete state and that `Continue` enables only after every required check succeeds. Assert the exact failure detail and remediation, disabled `Continue`, and keyboard Space toggling of the disclosure's `aria-expanded` state and detail visibility.

## Verification record

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

Linux Tauri bundling, KVM access, VM startup, and oldest-supported-macOS behavior were not tested. Linux execution coverage is limited to read-only `--version` under Docker. No VM, installer, repair, sandbox, or `msb doctor` command ran.
