# Linux verification

Linux parity needs three independent kinds of evidence. Compilation alone does
not prove the WebKit UI, desktop services, or hardware virtualization works.

| Layer | Command | What it proves |
| --- | --- | --- |
| Frontend | `npm test -- --maxWorkers=2` | Component behavior and bridge contracts on Linux; test adapters remain outside production. |
| Native | `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1` | Linux application discovery, login entries, settings, resource checks, files, network, GitHub boundary behavior, secrets, and backup validation. |
| Desktop | `xvfb-run -a dbus-run-session -- python3 scripts/test-linux-desktop.py` | Real production WebKit, native IPC, dependency failure gating, page navigation, inline validation and persisted settings. |
| Hardware | `python3 scripts/test-linux-runtime.py` | Real KVM creation, bundled image import/cache reuse, guest tools/identity, backup/restore data round trips and live secret changes. |

Run from `app/SiloUI`. Hardware tests use temporary Silo runtime directories and
synthetic secret material. They do not touch existing sandboxes. Desktop tests
use temporary XDG directories and a private D-Bus session; their saved settings
fixture is a file owned by the test, with no hooks or fixtures in production UI.
Authenticated GitHub workflow testing is separate and requires explicitly scoped
test repositories and credentials; these Linux CI jobs never receive credentials.

## Preparation

Use native Ubuntu 24.04 ARM64 or x86-64 with Node 24 and Rust 1.94.0:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libdbus-1-dev libclang-dev libcap-ng-dev cmake webkit2gtk-driver xvfb dbus-x11 python3-selenium
cargo install tauri-driver --version 2.0.6 --locked
npm ci
npm run runtime:prepare
```

Set the three build configuration variables to synthetic values for these tests:
`SILO_GITHUB_APP_SLUG=silo-linux-test`, `SILO_GITHUB_CLIENT_ID=test-client`,
`SILO_GITHUB_CLIENT_SECRET=test-secret`. Never copy a developer's ignored
`github-build.local.json` into a test machine. Build the real app with
`npm run desktop:build -- --debug --no-bundle --ci` before desktop testing.
For memory-limited machines, set `CARGO_PROFILE_DEV_DEBUG=0`,
`CARGO_PROFILE_TEST_DEBUG=0` and bound `CARGO_BUILD_JOBS`.
Do not run Cargo tests concurrently with desktop builds in the same target
directory: a test build can replace the runnable debug executable with a build
that expects the development server. Always rebuild immediately before UI tests.

The test-only `linux-verification.yml` workflow runs both architectures. It has
read-only repository permissions and cannot publish packages or releases.
Evidence and screenshots are stored under ignored `app/SiloUI/test-results/linux/`.
The KVM test exits nonzero when hardware is unavailable, rather than marking an
unexercised VM workflow successful. Desktop checks run before the KVM gate so
those results remain available even on a host that cannot run nested VMs.

## Coverage limits

An OrbStack Linux machine without `/dev/kvm` can run native and WebKit tests but
cannot prove MicroSandbox lifecycle behavior. CPU emulation does not supply KVM.
The script checks the actual KVM API and creates a VM handle before running
hardware tests; checking for the device file alone is insufficient.

GitHub-hosted Ubuntu offers Android hardware acceleration, but general nested
virtualization is not a guaranteed service. The workflow probes the actual host
instead of assuming it is available. If a runner lacks usable KVM, that
architecture still needs a Linux KVM host before claiming full runtime parity.

Xvfb is not a complete GNOME/KDE desktop. Native adapter tests verify autostart
and notification rules, but an actual desktop session is still needed to prove
tray placement, notification delivery, file pickers and terminal/editor handoff
on supported desktop environments. Display scaling and Wayland/X11 differences
also need interactive verification. Do not describe this suite as full Linux
parity until that matrix is exercised.

## Recorded local evidence, 10 September 2026

An isolated Ubuntu 24.04 ARM64 OrbStack machine ran the following successfully:

- Bundled MicroSandbox, Git and guest image preparation, followed by the real
  production Tauri debug build. The first runtime link failed because
  `libcap-ng-dev` was missing; installing it fixed the build. Both Linux build
  workflows now install it, and Linux packages declare `libcap-ng0` / `libcap-ng`.
- 608 frontend tests in 65 files. Only the deliberate 64-card capacity interaction
  gets a 15-second timeout; its previous 5-second timeout failed in the full Linux
  suite but the isolated behavior passed. No global timeout was increased.
- 276 native tests and 5 build-configuration tests; 8 opt-in hardware/account
  tests excluded from the default native run.
- Eleven real WebKit assertions: first-run onboarding, truthful missing-KVM
  failure and disabled Continue, dependency retry, five main page routes,
  secret inline validation and Escape, actual XDG login enable/disable, and
  persisted settings after full native application quit/relaunch.

The hardware probe failed explicitly with missing `/dev/kvm`. No Linux VM
lifecycle, authenticated GitHub operation or AMD64 execution was proven by
this local run. The GitHub-hosted two-architecture workflow is committed but
has not been dispatched: publishing its test branch to the public repository
requires approval. Screenshots are `test-results/linux/onboarding.png` and
`settings.png`; detailed success/failure reports are `desktop.json` and
`runtime.json` in the same ignored directory.

## Primary sources

- [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/): external
  `tauri-driver` can drive native Linux WebKit without adding an embedded server
  or test plugin to the application.
- [Tauri WebDriver CI](https://v2.tauri.app/develop/tests/webdriver/ci/):
  `webkit2gtk-driver` and Xvfb provide native Linux browser automation.
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners):
  Linux hardware acceleration and runner characteristics.
- [GitHub-hosted runner limits](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners):
  nested virtualization is not officially supported.
- [Linux KVM API](https://docs.kernel.org/virt/kvm/api.html): `KVM_GET_API_VERSION`
  and `KVM_CREATE_VM` verify usable hardware virtualization.
