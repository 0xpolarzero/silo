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
| RL-02 | P2 | Linux verification seeds production paths for a Dev binary | Fixed and folded: `5a14fe19` |
| RL-03 | P2 | Desktop smoke isolation leaves HOME-dependent state live | Fixed and folded: `024c8268` |
| RL-04 | P2 | Direct publication bypasses the explicit stable-release opt-in | Confirmed; fix pending |

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

**Status.** Fixed and folded in `5a14fe19`. The new path regression failed before the fix; both path tests, all eight wrapper tests and both workflow-pin checks pass. These tests execute the actual wrapper and extracted harness expressions, not WebDriver. This is internal verification tooling and needs no application changeset.

### RL-03 Desktop smoke isolation leaves HOME-dependent state live

**P2.** Confirmed at `9ea078cd`. Locations: [test-linux-desktop.py](../app/SiloUI/scripts/test-linux-desktop.py), `run` environment setup; [remote.rs](../app/SiloUI/src-tauri/src/remote.rs), `directory`, `read_config_in`, and `start`; [runtime.rs](../app/SiloUI/src-tauri/src/runtime.rs), `runtime_home_alias`.

**Trigger.** Run the documented desktop smoke command on an account that already has Silo or Silo Dev host state. The smoke harness copies the caller's environment and replaces only XDG CONFIG/DATA/CACHE roots.

**Evidence.** `HOME` remains inherited. Native startup calls `remote::start`; its directory comes directly from HOME plus the current channel's private directory, reads or creates the remote host configuration, and binds the channel's control socket. Runtime aliases also use HOME. A disposable XDG directory therefore does not isolate those paths. With the Dev workflow fixed in RL-02 this is `.silo-dev`; explicit production-package smoke uses `.silo`. No real host state was accessed in this review.

**Consequence.** A supposedly isolated smoke run can read existing remote-host settings, create persistent host state, contend with a user's control socket, or repoint an enabled management bridge to the test app. Its temporary XDG state can disappear while aliases remain in the caller's home. Hosted CI has disposable accounts; the documented local invocation does not provide that boundary.

**Correction.** Create HOME inside the smoke fixture before starting any native process and pass it alongside the XDG roots. Preserve inherited executable/tool search paths. Keep the separately supplied lifecycle fixture contract separate from this automatically created smoke fixture.

**Rejecting test.** Execute the real smoke environment prelude against a synthetic caller HOME containing sentinel channel state. HOME and all three XDG roots passed to the app must be inside the temporary task root, and the sentinel must remain unchanged. Native GUI qualification remains separate.

**Status.** Fixed and folded in `024c8268`. The environment regression failed for HOME before the fix; all 13 focused environment/path/wrapper/pin tests pass. This is internal verification tooling and needs no application changeset.

### RL-04 Direct publication bypasses the explicit stable-release opt-in

**P2.** Confirmed at `1aeac26d`. Locations: [publish-release.py](../app/SiloUI/scripts/publish-release.py), `main` version gate; [publish-release.yml](../.github/workflows/publish-release.yml), dispatch inputs and publication command; [release.mjs](../app/SiloUI/scripts/release.mjs), publication dispatch.

**Trigger.** A maintainer directly dispatches the publication workflow for a prepared `v1.0.0` or later draft, bypassing the local npm wrapper. Manual workflow dispatch is a documented retry path.

**Evidence.** `sync-release.mjs` and `release.mjs` enforce `assertPreStable` unless `--allow-stable` is explicit. The Python backend accepts every nonzero three-part version, including `1.0.0`; its publication path and the workflow read no stable-release opt-in. The early build workflow also accepts synchronized 1.x metadata, as its existing `1.2.3` fixture demonstrates. Given a complete valid newer draft, ordinary signature/checksum/identity gates do not reject its major version. This is source-confirmed policy bypass; no GitHub publication was attempted.

**Consequence.** The final publication boundary does not enforce the repository's requirement to keep Silo below 1.0.0 until explicitly authorized. Environment review alone does not express the promised distinct stable-release decision.

**Correction.** Require an explicit stable-release flag in the final Python publication gate and carry it through the workflow's boolean input and the existing local wrapper option. Keep parsing/comparison of historical public versions independent of this policy so a prior 1.x tag does not cause unrelated parsing failures. The early build gate still needs the same policy before owner-approved 1.x release qualification.

**Rejecting test.** Direct draft creation and publication for `1.0.0` and later must fail before any GitHub call without opt-in; explicit opt-in must reach the ordinary asset gates. The local wrapper must dispatch the workflow opt-in only when explicitly requested. Execute the workflow command with a fake Python verifier and verify its argument list in both modes, without signing or contacting GitHub.

## Verification and reproducibility

RL-01: `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_desktop_release` passed 8 tests. The new regression first failed in 3 subcases. Failure/passing output is retained under ignored `app/SiloUI/src-tauri/target/verification/release-review-2026-10-02/rl01-{before,after}.log`.

Before the fix commit: Node 24.11.1 `typecheck` passed; `lint` passed with 12 existing warnings; `cargo +1.94.0 fmt --manifest-path app/SiloUI/src-tauri/Cargo.toml --check` passed. Native checks use the shared `/tmp/silo-codex-target`; Node dependencies use the existing main-checkout installation. A fixture or source review does not qualify a signed release or installed application.

RL-02: `PYTHONPATH=app/SiloUI/scripts python3 -m unittest test_linux_verification_release test_desktop_release test_workflow_pins` passed 12 tests. Typecheck, lint (5 existing warnings after integration updates), and Rust formatting passed before its fix commit. `rl02-{before,after}.log` retains the failing/passing evidence in the same ignored directory.

RL-03: the same focused command passed 13 tests. Lint (2 existing warnings) and Rust formatting passed. Typecheck at `60c1b862` failed on two stale `ComputerUseProvider` imports introduced by concurrent integration changes; the next integration fold supplied corrected imports. The failure preceded the fix commit and did not involve the changed Python files. Typecheck is rerun after integration. `rl03-{before,after}.log` retains the focused regression evidence.

## Next action

Trace release validation through platform artifacts and publication, then check host-name consumers against both build channels.
