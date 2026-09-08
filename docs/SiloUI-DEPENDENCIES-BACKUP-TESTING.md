# SiloUI dependencies and VM operation UI testing

This guide tests the current Tauri app. It does not apply to the Swift reference app under `app/Silo`.

## What is native

The Dependencies step calls the typed `read_dependencies` Tauri command on every normal desktop launch and on **Retry checks**. The command performs only bounded, read-only probes:

- macOS: the app requires its declared macOS 14 floor, the packaged Apple-silicon target, and `kern.hv_support=1`. Apple documents `kern.hv_support` as the runtime availability probe and requires the Hypervisor entitlement: <https://developer.apple.com/documentation/hypervisor>.
- Linux: the app requires a packaged `aarch64` or `x86_64` GNU/Linux target, glibc 2.34 or later, and permission to open `/dev/kvm`; it calls only `KVM_GET_API_VERSION` and requires API 12. The KVM API documents that system query separately from `KVM_CREATE_VM`: <https://docs.kernel.org/virt/kvm/api.html#kvm-get-api-version>. GNU's glibc 2.34 release record is <https://sourceware.org/pipermail/libc-announce/2021/000032.html>.
- Bundled tools: Silo resolves only the packaged `msb`, libkrunfw, Git, Git LFS, and manifest paths. It validates pinned manifest data, validates every packaged macOS component signature or each Linux staged hash, then runs bounded `msb --version`, `git --version`, and `git-lfs version` commands in isolated environments. Tauri documents its sidecar and resource layouts at <https://v2.tauri.app/develop/sidecar/> and <https://v2.tauri.app/develop/resources/>.

The pins remain MicroSandbox 0.6.17, libkrunfw 5.6.1, Git 2.53.0, and Git LFS 3.7.1. A version check plus a platform signature or pinned staged hash is package-readiness evidence. It does not prove VM startup, GitHub authentication, network transport, notarization, or release-signing identity.

VM creation, VM lifecycle, backup, and restore engines are not native in this piece. A normal desktop launch returns explicit **VM operation unavailable**, **Backup is unavailable**, or **Restore is unavailable** results from those entry points. It never reports fixture completion. The approved create/start resource notices and backup/restore states are production React components driven only by the explicit debug fixture mode below.

## Build and verify

Run from the repository root:

```bash
npm --prefix app/SiloUI test
npm --prefix app/SiloUI run typecheck
npm --prefix app/SiloUI run lint
cargo test --manifest-path app/SiloUI/src-tauri/Cargo.toml
npm --prefix app/SiloUI run desktop:build:debug
codesign --verify --deep --strict --verbose=2 \
  "app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app"
```

The verified macOS bundle is:

```text
app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app
```

If another process already uses that bundle identity, build a disposable verification flavor instead of stopping it or trusting an ambiguous window:

```bash
cd app/SiloUI
npx tauri build --debug --bundles app --config \
  '{"productName":"Silo UX Verification","identifier":"org.silo.preview.uxverification","bundle":{"macOS":{"signingIdentity":"-"}}}'
```

This changes only the generated debug flavor. It does not change Silo's checked-in product name or identifier. Its bundle is `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo UX Verification.app`.

## Normal native check

First confirm that an unrelated instance is not using the bundle. Do not terminate a process you do not own. Launch the built executable with an isolated settings directory so the test cannot replace normal settings:

```bash
mkdir -p /tmp/silo-native-dependency-test-settings
env SILO_SETTINGS_DIR=/tmp/silo-native-dependency-test-settings \
  SILO_ONBOARDING_COMPLETE=0 \
  "$PWD/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app/Contents/MacOS/silo-preview"
```

This opens Setup without erasing or rewriting the user's normal settings. Expected behavior:

1. **System** and **Bundled tools** initially show checking states. **Continue** is disabled.
2. A healthy Apple-silicon Mac shows **2 of 2 checks passed** and **3 of 3 checks passed**. Expand each disclosure with a click, keyboard Space, or Enter.
3. The current host values appear as one caption per check. Expected pinned tool values are `msb 0.6.17`, `libkrunfw 5.6.1`, `Git 2.53.0`, and `Git LFS 3.7.1`.
4. **Continue** enables only when all five current required results pass. Missing, failed, unreadable, timed-out, malformed, bridge-error, and stale results remain unsuccessful.
5. **Retry checks** appears after a failure. It resets every item to checking and performs the same read-only probes again. It does not install, repair, create a VM, start a daemon, use `sudo`, or change permissions.
6. Application preference rows, navigation, footer, focus rings, Space disclosure behavior, and light/dark theme remain available.

Close only the instance started by this command. Remove `/tmp/silo-native-dependency-test-settings` and any private screenshots after the check.

## Explicit deterministic Tauri fixtures

Debug bundles accept `SILO_DEBUG_FIXTURE_QUERY` only in debug builds. Pair it with `SILO_SETTINGS_MEMORY=1`; fixture choices then stay in memory and do not read or write normal settings. This is an actual Tauri window using production React components, but all operation outcomes in this section are deterministic simulations.

```bash
APP="$PWD/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo Preview.app/Contents/MacOS/silo-preview"

env SILO_SETTINGS_MEMORY=1 \
  SILO_DEBUG_FIXTURE_QUERY='?view=onboarding&scenario=dependency-failure' "$APP"

env SILO_SETTINGS_MEMORY=1 \
  SILO_DEBUG_FIXTURE_QUERY='?view=app&backup-operation=unsupported-storage' "$APP"

env SILO_SETTINGS_MEMORY=1 \
  SILO_DEBUG_FIXTURE_QUERY='?view=app&backup-operation=restart-required' "$APP"

env SILO_SETTINGS_MEMORY=1 \
  SILO_DEBUG_FIXTURE_QUERY='?view=app&backup-operation=invalid-archive' "$APP"

env SILO_SETTINGS_MEMORY=1 \
  SILO_DEBUG_FIXTURE_QUERY='?view=app&backup-operation=restore-failed' "$APP"

env SILO_SETTINGS_MEMORY=1 \
  SILO_DEBUG_FIXTURE_QUERY='?view=app&resource-notice=start-memory&sandbox-state=stopped' "$APP"
```

Use one fixture instance at a time. Additional `backup-operation` values are `success`, `backup-failed`, `space-blocked`, `stop-failed`, `capture-failed`, `cancel-backup`, `restore-conflict`, `restore-storage`, and `cancel-restore`. The create-storage fixture is `resource-notice=create-storage`.

Expected UI coverage:

- Backup selects VM rows and a destination, distinguishes running and stopped VMs, blocks unsupported shared storage, shows known needed/available destination space, explains **Stop and back up**, presents stop/copy/restart/write-and-verify phases, confirms cancellation and cleanup, preserves earlier backups, and separates a valid backup from restart failure with **Retry start**.
- Restore validates before review, proposes an editable `<source>-restored` name, rejects conflicts and known storage shortages, creates a new stopped VM in the successful fixture, presents validation/write/settings/verification phases, confirms cancellation cleanup, and states that disk files and settings return while running programs do not.
- Resource notices stay absent in the quiet state. Create shows a known storage block only when Save is selected. Start shows the selected VM's configured memory limit and current-pressure advisory with **Start anyway**.
- In a normal native launch, the same Backup and Restore buttons show **Backup is unavailable** or **Restore is unavailable** and make no state changes because no native operation backend exists yet.
- In a normal native launch, Create, Start, Stop, Pause, and Restart show **VM operation unavailable** and make no state changes because no native VM engine exists yet.

## Verification recorded on 2026-09-08

The disposable `org.silo.preview.uxverification` build completed and passed deep ad-hoc signature verification. The live read-only dependency command reported `macOS 26.5 · Apple silicon`, `Apple Hypervisor available`, `Bundled msb 0.6.17 · libkrunfw 5.6.1`, `Bundled Git 2.53.0`, and `Bundled Git LFS 3.7.1`; **Continue** was enabled only after all five results passed. The explicit dependency-failure fixture showed one wrapped integrity error, **Retry checks**, and disabled **Continue**; Retry replaced it with passing checks and enabled Continue. CUA also exercised the selected-VM 32 GB memory warning, unsupported-storage backup block, restore validation with the `dev-restored` default, and light and dark appearance. The unrelated ordinary-bundle process remained running and untouched.

## Linux limit

Rust tests cover version/result mapping, strict manifests, path containment, missing files, and bounded process timeouts on macOS. The Linux code requires glibc 2.34, opens only `/dev/kvm`, and calls only `KVM_GET_API_VERSION`; the prepared Linux binaries and package pins remain covered by packaging tests. This macOS verification did not compile or execute the Linux Tauri bundle, open a real Linux `/dev/kvm`, hash its staged components at runtime, or prove an AppImage dependency chain. Do not report Linux native runtime success until those checks run on supported arm64 and x86_64 Linux hosts.
