# Silo: development and verification

The application lives in `app/SiloUI/` and uses React/TypeScript with a Rust/Tauri backend. Run the commands below from the repository root unless a command says otherwise.

## Source and layout

- `app/SiloUI/src/`: UI, production data sources, deterministic fixtures, and frontend tests.
- `app/SiloUI/src-tauri/src/`: runtime management, remote computers, native integrations, and backend tests.
- `app/SiloUI/src-tauri/tests/`: Rust integration tests.
- `app/SiloUI/src-tauri/`: guest scripts, runtime inputs, capabilities, and Tauri packaging configuration.
- `app/SiloUI/scripts/`: runtime preparation and release tooling.
- `app/SiloUI/docs/`: bundled application help.
- `docs/README.md`: index of implementation documentation, research, and proposals.
- `docs/SiloUI-RELEASES.md`: authoritative build configuration and release procedure.

Preserve bundled MicroSandbox and Git tools, guest scripts, the Rust vendor patch, and the `silo-remote` SSH bridge. They are part of the current app. Generated `node_modules`, `dist`, Cargo `target`, binaries, and runtime resources are ignored build output; never commit them or private local configuration.

## Setup and commands

Use Node.js 24, Python 3.11 or newer, Rust, and the host's Tauri prerequisites. Runtime preparation requires Rust 1.94.0 for the pinned MicroSandbox build and network access on a cold cache. Supported packages target Apple Silicon macOS 14+ and Linux x86-64/ARM64 on Ubuntu 24.04-compatible systems; Linux VMs require KVM.

Native builds and Rust tests require GitHub App configuration. Follow `docs/SiloUI-RELEASES.md#local-setup`; do not print `github-build.local.json`, signing credentials, or verbose build output containing configuration. For native unit tests only, the release guide permits explicit synthetic GitHub configuration. Never distribute those test executables.

```sh
npm --prefix app/SiloUI ci
npm --prefix app/SiloUI run desktop
```

`desktop` prepares runtime resources and launches native development mode. `npm --prefix app/SiloUI run dev` starts the browser UI preview only.

Run checks appropriate to the change:

```sh
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
npm --prefix app/SiloUI test
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml
npm --prefix app/SiloUI run test:release
```

Frontend tests use Vitest. Use test file arguments to focus a frontend run and a Cargo test filter to focus backend behavior. Keep opt-in live tests separate from ordinary unit tests. Release-tooling changes also need the relevant script tests and workflow checks.

For a local macOS debug bundle:

```sh
npm --prefix app/SiloUI run desktop:build:debug
```

Output: `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`.

For an optimized local macOS app without installer or updater signing:

```sh
npm --prefix app/SiloUI run desktop:build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

Output: `app/SiloUI/src-tauri/target/release/bundle/macos/Silo.app`. This command disables updater artifact creation for this invocation only. The normal `desktop:build` command builds host-platform distribution packages and requires updater signing credentials. Follow the release guide for distributable packages; a local app build does not publish anything.

## Running and debugging

- Rebuild before inspecting a packaged change. Launch the exact bundle path with `open`, not an arbitrary installed copy with `open -a Silo`.
- Before a manual launch, inspect any existing instance and verify its executable path and ownership. Do not interrupt the user's running app or VMs as routine test cleanup.
- Closing the window leaves the app running. Graceful Quit stops Silo-owned local VMs; it does not stop remote VMs. A shutdown failure leaves the app open. Account for these side effects before exercising Quit against real state.
- Use deterministic frontend fixtures for UI-only checks. Use semantic roles and identifiers instead of screen coordinates where available. Native UI automation requires an interactive session and the applicable OS permissions; do not reset permissions globally or dismiss unfamiliar security dialogs.
- Verify process identity before attaching a debugger. Prefer graceful cleanup of processes started for the test; never use `pkill`, `killall`, guessed PIDs, or routine `kill -9`.
- Keep generated evidence under an ignored directory such as `app/SiloUI/src-tauri/target/verification/`. Keep private system logs in a temporary local path and do not publish credentials, VM data, or unredacted logs. Preserve the exact failing output before rerunning.
- Report commands, results, the exact inspected bundle, and whether data was fixture or live. A frontend test proves UI behavior against its supplied data; a build proves compilation and packaging. Neither proves live VM health, two-computer management, installed-app behavior, or release readiness.

## SiloUI release notes

For each user-visible SiloUI feature, fix, or behavior change, include a Markdown
changeset in `app/SiloUI/.changeset/` with `"silo-ui": patch|minor|major` front
matter and a concise user-facing summary. Agents may write the file directly.
Use patch for fixes, minor for compatible features, and major for incompatible
changes. Internal-only changes need no changeset. Do not bump versions, consume
changesets, create release tags, or publish unless requested. Follow
`docs/SiloUI-RELEASES.md` for release preparation and verification.
