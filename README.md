# Silo

<img src="assets/silo-logo.svg" alt="Silo" width="96">

Silo is a desktop app for creating and managing persistent Linux microVM development environments with MicroSandbox. The application uses React, TypeScript, Rust, and Tauri and lives in [`app/SiloUI`](app/SiloUI).

Manage VMs, open terminals and editors over SSH, browse files, configure network connections, grant GitHub repository access, manage host-held API secrets, and back up local workspaces. Connect another computer running Silo to manage its VMs from the same interface. Closing the window keeps Silo available in the status bar; quitting stops this computer's Silo VMs. Remote management requires Silo to remain running on the owning computer.

## Install

Download a package from [Silo releases](https://github.com/0xpolarzero/silo/releases) and follow the app's onboarding. Supported packages target Apple Silicon macOS 14 or newer and Linux x86-64/ARM64 on Ubuntu 24.04-compatible systems. Linux VM execution requires KVM. See the [release guide](docs/SiloUI-RELEASES.md) for signing, installation, and update details.

## Develop

Use Node.js 24, Rust, Python 3.11 or newer, and the host's Tauri build prerequisites. Runtime preparation also requires the Rust 1.94.0 toolchain for the pinned MicroSandbox build and network access on a cold cache. Native builds require GitHub App configuration; follow [local setup](docs/SiloUI-RELEASES.md#local-setup) before building. Keep the ignored local configuration private.

Run commands from the repository root:

```sh
npm --prefix app/SiloUI ci
npm --prefix app/SiloUI run desktop
```

For a browser-only UI preview, use `npm --prefix app/SiloUI run dev`. Browser fixtures do not execute VMs or validate native integrations.

### Verify

```sh
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
npm --prefix app/SiloUI test
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml
npm --prefix app/SiloUI run test:release
```

Native tests require the GitHub build configuration described above. Automated tests do not replace installed-app, live VM, or real two-computer acceptance checks.

### Build a local macOS app

```sh
npm --prefix app/SiloUI run desktop:build:debug
```

The debug bundle is `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`. For an optimized local app without installer or updater packaging:

```sh
npm --prefix app/SiloUI run desktop:build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

The release bundle is `app/SiloUI/src-tauri/target/release/bundle/macos/Silo.app`. These commands build locally; they do not install or publish the app. Distributable packages and signed updates use the [release workflow](docs/SiloUI-RELEASES.md#release-a-new-version).

## Repository layout

| Path | Contents |
| --- | --- |
| `app/SiloUI/src/` | React UI, production data sources, fixtures, and frontend tests |
| `app/SiloUI/src-tauri/` | Rust backend, native integrations, guest scripts, tests, and packaging |
| `app/SiloUI/scripts/` | Runtime preparation, build, and release tooling |
| `app/SiloUI/.changeset/` | Pending user-facing release notes |
| `app/SiloUI/docs/` | Bundled application help |
| `docs/` | Technical documentation, research, and versioned release notes |
| `assets/` | Shared branding assets |
| `artifacts/` | Design work |
| `.github/workflows/` | CI and release workflows |

## Documentation

- [Documentation index](docs/README.md)
- [Build and release guide](docs/SiloUI-RELEASES.md)
- [Runtime packaging](docs/SiloUI-RUNTIME-PACKAGING.md)
- [Remote computers and Quit behavior](docs/SiloUI-REMOTE-COMPUTERS.md)
- [GitHub integration](docs/SiloUI-GITHUB-IMPLEMENTATION.md)
- [Host-held API secrets](docs/SiloUI-SECRETS.md)

For each user-visible change, add a changeset under `app/SiloUI/.changeset/`. Version preparation and publication are separate, explicit operations; see the release guide.
