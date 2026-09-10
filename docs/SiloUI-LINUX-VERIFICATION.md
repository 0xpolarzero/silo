# Linux verification

Linux parity needs separate evidence for each layer. Compilation alone does
not prove the WebKit UI, desktop services, or hardware virtualization works.

| Layer | Command | What it proves |
| --- | --- | --- |
| Frontend | `npm test -- --maxWorkers=2` | Component behavior and bridge contracts on Linux; test adapters remain outside production. |
| Native | `cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1` | Linux application discovery, login entries, settings, resource checks, files, network, GitHub boundary behavior, secrets, and backup validation. |
| Desktop | `xvfb-run -a dbus-run-session -- python3 scripts/test-linux-desktop.py` | Real production WebKit, native IPC, dependency failure gating, page navigation, inline validation and persisted settings. |
| GNOME integration | `sh scripts/test-linux-gnome.sh` | Real GNOME Wayland, tray reopen/quit, native backup picker and visible notification delivery. |
| Hardware | `python3 scripts/test-linux-runtime.py` | Real KVM creation, bundled image import/cache reuse, guest tools/identity, backup/restore data round trips, live secret changes and interrupted restart recovery. |

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
sudo apt-get install -y --no-install-recommends build-essential pkg-config libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libdbus-1-dev libclang-dev libcap-ng-dev cmake webkit2gtk-driver xvfb xauth dbus-x11 python3-selenium
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
The AMD64 CI job requires real KVM tests after successful build and desktop
checks. ARM64 hosted runners have no `/dev/kvm`, so that CI hardware step is
explicitly skipped; the separate local Lima hardware evidence below covers
ARM64. The hardware script itself exits nonzero when KVM is unavailable,
rather than marking an unexercised VM workflow successful.

## Coverage limits

An OrbStack Linux machine without `/dev/kvm` can run native and WebKit tests but
cannot prove MicroSandbox lifecycle behavior. CPU emulation does not supply KVM.
The script checks the actual KVM API and creates a VM handle before running
hardware tests; checking for the device file alone is insufficient.

GitHub-hosted Ubuntu offers Android hardware acceleration, but general nested
virtualization is not a guaranteed service. The workflow probes the actual host
instead of assuming it is available. If a runner lacks usable KVM, that
architecture still needs a Linux KVM host before claiming full runtime parity.

Xvfb alone does not prove desktop services. Separate GNOME 46 X11 and native
Wayland runs now prove the UI; the Wayland run also proves tray reopen/quit,
a visible production notification and the native backup picker. These sessions
use nested software rendering. Physical GPU behavior, HiDPI and multiple
monitors, KDE/other desktop environments, and every external terminal/editor
application remain unverified. Do not generalize the GNOME evidence to every
Linux desktop.

## Recorded local evidence, 10 September 2026

An isolated Ubuntu 24.04 ARM64 OrbStack machine ran the following successfully:

- Bundled MicroSandbox, Git and guest image preparation, followed by the real
  production Tauri debug build. The first runtime link failed because
  `libcap-ng-dev` was missing; installing it fixed the build. Both Linux build
  workflows now install it, and Linux packages declare `libcap-ng0` / `libcap-ng`.
- 608 frontend tests in 65 files. At that stage, the deliberate 64-card capacity interaction
  received a 15-second timeout; its previous 5-second timeout failed in the full Linux
  suite but the isolated behavior passed. No global timeout was increased.
- 291 native tests and 5 build-configuration tests after the final recovery changes; 10 opt-in hardware/account
  tests excluded from the default native run.
- Eleven real WebKit assertions: first-run onboarding, truthful missing-KVM
  failure and disabled Continue, dependency retry, five main page routes,
  secret inline validation and Escape, actual XDG login enable/disable, and
  persisted settings after full native application quit/relaunch. The final
  integrated sources were rebuilt after the final native run and all eleven
  WebKit checks passed again; evidence is under `test-results/linux/arm64-final/`.

OrbStack explicitly failed the hardware probe with missing `/dev/kvm`.
A separate disposable Lima VM provides the hardware evidence below. The GitHub-hosted two-architecture workflow
was pushed to the approved public `verify-linux-parity-20260910` test branch.
The first hosted run exposed two long form/navigation tests exceeding their
5-second limits; only those tests receive 15 seconds. It also confirmed hosted
ARM64 has no KVM and that changing the primary group through `sudo -g` prompts
for a password. The AMD64 hardware step uses `sudo runuser` with the existing
KVM group, without broadening device permissions. Screenshots are `test-results/linux/onboarding.png` and
`settings.png`; detailed success/failure reports are `desktop.json` and
`runtime.json` in the same ignored directory.

### Additional architectures and real KVM

An existing local Ubuntu 24.04 AMD64 OrbStack machine runs through Rosetta on
Apple Silicon. The complete frontend suite passed: 609 tests in 65 files.
Its patched MicroSandbox, bundled Git and AMD64 Ubuntu guest image also staged
successfully, and the final native suite passed 291 tests plus 5 build-configuration
tests (10 opt-in tests excluded). The production Tauri debug build and all eleven
WebKit assertions then passed, including real XDG autostart and full native
quit/relaunch persistence. Evidence is under `test-results/linux/amd64-final/`.
The emulated frontend run used `--testTimeout=30000 --maxWorkers=2` after five tests hit
5-second time limits under CPU contention. This changes only that test command,
not application behavior or the default test configuration. The first AMD64
WebKit run reached the correct app but clicked during a transient layout state;
the existing bounded semantic-click wait now also retries WebDriver
`ElementNotInteractableException`. It still uses normal clicks and fails after
the same 45-second deadline.

For real hardware tests, a temporary Lima 2.2.0 Ubuntu 24.04 ARM64 VM uses Apple's
Virtualization framework with `nestedVirtualization: true` on an M4 Max host.
It has 4 CPUs, 8 GiB RAM and a 24 GiB sparse disk. Its only shared directory is a
read-only export of synthetic test binaries and the bundled public guest image;
no host home, credentials or existing sandbox data are shared. The normal user
runs tests with the existing `kvm` group. Device permissions remain unchanged.
Both KVM API version 12 and actual VM-handle creation succeeded.

The Linux test executable was built from the final integrated native sources
with synthetic GitHub configuration. Each hardware test runs independently with
`--ignored --nocapture --test-threads=1`, a ten-minute limit, and an assertion that
exactly one test passed. The executable and bundled MicroSandbox firmware are
copied into the temporary VM; the compiled guest-image path points to its
read-only export. Its evidence output directory is writable by the test user.
An initial backup test completed every disk assertion but failed writing its
final evidence because that directory belonged to root; the complete test passed
after correcting only this temporary directory's ownership.

- [Apple nested virtualization](https://developer.apple.com/documentation/virtualization/vzgenericplatformconfiguration/isnestedvirtualizationsupported):
  supported Apple Silicon hardware can expose virtualization to a Linux guest.
- [Lima Virtualization framework](https://lima-vm.io/docs/config/vmtype/vz/) and
  [Lima configuration](https://raw.githubusercontent.com/lima-vm/lima/master/templates/default.yaml):
  `nestedVirtualization` enables the supported host capability.
- [OrbStack Linux machines](https://docs.orbstack.dev/machines/): local Linux
  machines and AMD64 execution through Rosetta on Apple Silicon.

All five real KVM tests passed in this VM:

| Test | Result |
| --- | --- |
| Bundled image import, boot and cache reuse | Passed, 10.96 seconds |
| GitHub guest tools and live Git identity | Passed, 27.50 seconds |
| Backup/restore root and workspace without original VM/cache | Passed, 80.70 seconds |
| Live secret changes with the same guest boot | Passed, 56.63 seconds |
| Worker exit, restart recovery and no duplicate restart | Passed, 17.49 seconds |

These tests use real MicroSandbox guests. They do not exercise authenticated
GitHub API requests; that evidence belongs to the separate GitHub test lane.
Full logs and a result JSON are saved locally under
`test-results/linux/kvm-arm64/`. The temporary Lima VM is deleted after evidence
capture. The existing OrbStack machines and macOS application remain untouched.

## Hosted verification, 10 September 2026

[Run 34480478578](https://github.com/0xpolarzero/silo/actions/runs/34480478578)
passed both native architectures at commit `6e32bcf` on the approved
`verify-linux-parity-20260910` branch. It publishes test artifacts only.

| Hosted runner | Frontend | Native | Production WebKit | Real KVM |
| --- | --- | --- | --- | --- |
| Ubuntu 24.04 ARM64 | 609 tests / 65 files | 291 tests + 5 build checks | 11 assertions | Explicitly skipped: runner has no KVM; see five local ARM64 KVM passes above |
| Ubuntu 24.04 AMD64 | 609 tests / 65 files | 291 tests + 5 build checks | 10 assertions | All five real guest tests passed |

Both also passed lint, patched runtime/Git/guest image preparation and the
production Tauri build. Native suites exclude 10 opt-in hardware/account tests;
the separate AMD64 hardware step explicitly runs the five applicable guest
tests. AMD64 WebKit has one fewer assertion because KVM exists, so the
missing-KVM blocking assertion does not apply.

| Real AMD64 KVM test | Duration |
| --- | --- |
| Bundled image import, boot and cache reuse | 12.72 seconds |
| GitHub guest tools and live Git identity | 21.16 seconds |
| Backup/restore root and workspace without original VM/cache | 85.75 seconds |
| Live secret changes with the same guest boot | 27.50 seconds |
| Worker exit, restart recovery and no duplicate restart | 18.50 seconds |

Downloaded artifacts and complete job logs are stored under
`test-results/linux/ci/arm64/` and `test-results/linux/ci/amd64/`.
The AMD64 `runtime.json` records usable KVM and five passing tests; each detailed
log contains an actual one-test pass. This is guest execution evidence, not
only a capability check. Later GitHub-account tests and GNOME-only test tooling
commits are separate from this pinned hosted run.

## GNOME desktop integration

Ubuntu 24.04 ARM64 with GNOME 46 passed the eleven UI assertions on both GNOME
X11 and native Wayland. The final Wayland run passed sixteen assertions:
the same eleven plus real notification-service ownership, AppIndicator
registration and reopening a closed window, native backup file-picker Cancel,
a visible notification from a production health failure, and the real tray Quit
action removing both the window and tray item. The test checks native window
visibility before and after Open; notification visibility belongs to GNOME Shell.
It does not substitute fake desktop services or add production test hooks.

Install these additional **test-machine** dependencies after the normal Linux
preparation above, then run against the freshly built production binary:

```sh
sudo apt-get install -y --no-install-recommends gnome-shell gjs gnome-shell-extension-appindicator xdg-desktop-portal-gnome python3-pyatspi xdotool
PATH="$HOME/.cargo/bin:$PATH" sh scripts/test-linux-gnome.sh
```

The launcher creates temporary XDG state and a private D-Bus session. GNOME runs
as a nested compositor with software rendering; Silo explicitly uses its native
Wayland socket. It removes its own processes and private portal mount after the
run. Existing desktop sessions, app data and sandboxes remain untouched.

Evidence is under `test-results/linux/gnome-wayland/`: `desktop.json` records
all sixteen passes, `gnome-services.json` records the five service assertions,
`gnome-notification.png` shows the real banner, and the D-Bus/GNOME logs record
delivery. All test-owned Silo, GNOME and WebDriver processes were removed.

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

- [GNOME nested Wayland testing](https://wiki.gnome.org/Initiatives%282f%29Wayland%282f%29GnomeShell%282f%29Testing.html):
  a private D-Bus session can run a nested GNOME Wayland compositor.
- [Ubuntu AppIndicator extension](https://github.com/ubuntu/gnome-shell-extension-appindicator):
  the real GNOME extension supplies StatusNotifierItem support.
- [GNOME notifications](https://help.gnome.org/gnome-help/shell-notifications.html):
  desktop banners and the notification list are owned by GNOME Shell.
