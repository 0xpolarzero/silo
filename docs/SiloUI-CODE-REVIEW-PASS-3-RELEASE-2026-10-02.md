# Silo third code review pass: release and CI, 2026-10-02

This pass reviews release tooling, workflow gates, updater artifacts, release documentation, and development/production channel separation. Findings are added as their evidence is confirmed; an empty ledger is not a release-readiness claim.

## Revision and scope

Initial revision: `f94219259d081ae3297887d0a5660faac22f2d3e`, branch `codex/review-release-ci`. Each finding records its confirmation and subsequent fix separately because integration changes during this pass.

The first two reports were read from the main checkout before review. This ledger excludes R-01 through R-38 and previously recorded improvement opportunities, including APT retention (R-13), website/demo CI coverage (R-14), LFS compiler identity (R-20), and independent draft-asset authentication (O-11).

Reviewed boundaries: `app/SiloUI/scripts/`, `.github/workflows/`, `.github/actions/prepare-release-runtime/`, updater configuration and asset contracts, `docs/SiloUI-RELEASES.md`, and host names defined by `src-tauri/src/channel.rs`.

P1 denotes an essential delivery or isolation failure; P2 denotes a concrete correctness, availability, or verification failure; P3 denotes a narrower defect with a practical workaround. Evidence distinguishes executed fixture behavior from source-confirmed consequences.

No release is published, signed, tagged, or pushed. No runtime preparation, app launch, real VM, production HOME, or credential store is used. Tests use synthetic inputs and temporary paths.

## Findings at a glance

| ID | Priority | Finding | Status |
| --- | --- | --- | --- |
| RL-01 | P2 | Wrapper configuration crosses the Cargo argument separator | Fixed and folded: `9baaac4e` |
| RL-02 | P2 | Linux verification seeds production paths for a Dev binary | Confirmed; fix pending |

## Detailed findings

### RL-01 Wrapper configuration crosses the Cargo argument separator

**P2.** Confirmed at `81523e2d`. Location: [build_desktop.py](../app/SiloUI/scripts/build_desktop.py), development configuration insertion and Linux packaging branch.

**Trigger.** Run a supported debug/unbundled build with raw Cargo arguments, for example `desktop:build -- --debug --no-bundle -- --locked`. Linux bundled builds with raw Cargo arguments have the same placement error for their package configuration.

**Evidence.** Calling the actual `build` function with a recording runner produced Tauri arguments `--debug --no-bundle`, then Cargo arguments `--locked --config src-tauri/tauri.dev.conf.json`. The wrapper appends configuration after the separator. A direct, offline `cargo +1.94.0 metadata --no-deps --config app/SiloUI/src-tauri/tauri.dev.conf.json` rejected the JSON at line 1 as invalid TOML, before compilation. Tauri documents [runner arguments and configuration options](https://v2.tauri.app/reference/cli/); the observed command crosses those boundaries.

**Consequence.** Debug builds with ordinary Cargo options fail instead of selecting the development configuration. Linux package layout/updater overrides likewise reach Cargo instead of Tauri. This reproduction establishes rejected builds, not successful production-state access.

**Correction.** Insert every wrapper-owned Tauri configuration before the first `--`, preserving the raw Cargo suffix exactly. Keep the local optimized macOS rejection of unsupported raw arguments.

**Rejecting test.** Exercise the real wrapper with debug macOS, debug Linux, and release Linux arguments containing `-- --locked`. Assert the effective Tauri configuration selects Dev for debug and the private Linux tool layout without updater artifacts; the Cargo suffix must contain only the original Cargo arguments. Preserve no-separator behavior and the optimized macOS rejection.

**Status.** Fixed and folded in `9baaac4e`. The regression failed for all three cases before the fix; all eight desktop-wrapper tests now pass. This is internal build routing and needs no application changeset.

### RL-02 Linux verification seeds production paths for a Dev binary

**P2.** Confirmed at `02344c24`. Locations: [linux-verification.yml](../.github/workflows/linux-verification.yml), debug build and WebDriver steps; [test-linux-desktop.py](../app/SiloUI/scripts/test-linux-desktop.py), `run` fixture identity, settings and autostart paths.

**Trigger.** Run the Linux verification workflow. It invokes `desktop:build -- --debug --no-bundle --ci`, which selects `org.silo.dev`, then invokes the smoke harness without `SILO_LINUX_APPLICATION_ID`.

**Evidence.** The actual wrapper selects `tauri.dev.conf.json` for this command. The harness defaults its fixture identifier to `org.silo.preview`, writes `onboardingComplete` under that identifier, relaunches the Dev binary, and waits for the post-onboarding Backup navigation. Dev reads `org.silo.dev` instead. The harness also waits for `autostart/org.silo.preview.desktop`, while `channel.rs` and `system_integrations/linux.rs` select `org.silo.dev.desktop`. These are two separate waits in the same incompatible fixture setup. No native GUI was launched in this review.

**Consequence.** The Linux desktop verification cannot complete its stated workflow: the seeded settings do not advance onboarding, and correcting only the settings path still leaves the autostart wait broken. A failing smoke job provides no claimed settings/relaunch/autostart evidence.

**Correction.** Pass the exact Dev identifier from the workflow and derive the autostart expectation from the selected channel, preserving production-package qualification when explicitly requested. Label the debug build as development.

**Rejecting test.** Run the actual build-wrapper seam with the workflow's build arguments, resolve its configuration identifier, and evaluate the harness's fixture path expressions with the workflow environment. Settings and autostart paths must match that identifier's channel. Then qualify the full WebDriver smoke on Linux; deterministic path checks alone do not prove native GUI behavior.

## Verification and reproducibility

RL-01: `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_desktop_release` passed 8 tests. The new regression first failed in 3 subcases. Failure/passing output is retained under ignored `app/SiloUI/src-tauri/target/verification/release-review-2026-10-02/rl01-{before,after}.log`.

Before the fix commit: Node 24.11.1 `typecheck` passed; `lint` passed with 12 existing warnings; `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` passed. Native checks use the shared `/tmp/silo-codex-target`; Node dependencies use the existing main-checkout installation. A fixture or source review does not qualify a signed release or installed application.

## Next action

Trace release validation through platform artifacts and publication, then check host-name consumers against both build channels.
