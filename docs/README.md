# Silo documentation

The application lives in [`app/SiloUI`](../app/SiloUI): React in `src/`, Rust and
native integration in `src-tauri/`, and build tooling in `scripts/`. Start with
the [repository README](../README.md) for development commands.

## Implementation and operations

These documents describe the Tauri app. Dated verification results establish
coverage for that run, not a guarantee that every platform or live VM workflow
has been exercised.

| Area | Documents |
| --- | --- |
| Build and release | [Release workflow](SiloUI-RELEASES.md), [Linux system updates](SiloUI-LINUX-UPDATES.md), [distribution acceptance](SiloUI-DISTRIBUTION-PLAN.md), [release history](releases/) |
| Runtime | [Packaging](SiloUI-RUNTIME-PACKAGING.md), [runtime and backup decisions](SiloUI-RUNTIME-BACKUP-FINDINGS.md), [bundled guest images](SiloUI-GUEST-IMAGES.md), [SSH agent TLS regression](SiloUI-ZCODE-TLS-INVESTIGATION.md) |
| Platform verification | [Linux](SiloUI-LINUX-VERIFICATION.md), [macOS VM library loading](SiloUI-LIBRARY-CONSTRAINTS.md), [dependencies and backup testing](SiloUI-DEPENDENCIES-BACKUP-TESTING.md) |
| Remote management | [Remote computers and Quit behavior](SiloUI-REMOTE-COMPUTERS.md) |
| GitHub and secrets | [GitHub implementation](SiloUI-GITHUB-IMPLEMENTATION.md), [secrets](SiloUI-SECRETS.md) |
| VM tools | [Files](SiloUI-FILES.md), [network](SiloUI-NETWORK-PLAN.md), [terminal handoff](SiloUI-TERMINAL-HANDOFF.md), [editor and browser handoff](SiloUI-EDITOR-HANDOFF.md) |
| Logs | [Retained history, search and export](SiloUI-LOGS.md) |
| Desktop behavior | [Settings](SiloUI-SETTINGS.md), [native menus](SiloUI-NATIVE-MENUS.md), [status panel](SiloUI-STATUS-PANEL.md) |

## Research and design evidence

Research records the inputs to a decision. Follow the implementation documents
above for current behavior and build commands.

- [Logging and retention audit](SiloUI-LOGGING-AUDIT.md): current storage limits, log and activity presentation, and retention gaps.

- [Development and release optimization plan](SiloUI-WORKFLOW-OPTIMIZATION-PLAN.md): measured bottlenecks, ranked changes, and benchmark acceptance gates.
- [Server-free GitHub research](SiloUI-GITHUB-SERVER-FREE-RESEARCH.md): primary sources and authorization constraints behind the native implementation.
- [GitHub client-secret release audit](SiloUI-OAUTH-RELEASE-AUDIT.md): public 0.1.1 package inspection, live App settings, and independent PKCE enforcement checks.
- [Workflow performance](SiloUI-WORKFLOW-PERFORMANCE.md): implementation, controlled measurements and hosted comparison.
- [Native compilation experiment](SiloUI-NATIVE-COMPILATION-EXPERIMENT.md): measured test-target reduction and the compiler-cache acceptance gate.
- [Frontend test performance](SiloUI-FRONTEND-TEST-PERFORMANCE.md): controlled environment-split measurements.
- [Guest image size experiment](SiloUI-GUEST-IMAGE-SIZE.md): measured image-size tradeoffs.
- [Historical ext4 discard investigation](../artifacts/ext4-raw-image-root-cause.html): upstream MicroSandbox v0.6.8 reproduction and regression requirements; not current app validation.
- Branding studies: [logo system](../artifacts/silo-logo-system.html), [proportions](../artifacts/silo-proportion-study.html), [structure](../artifacts/silo-structure-study.html), and [top-down study](../artifacts/silo-top-down-study.html).

Shared branding files live in [`assets/`](../assets/). Generated native bundles,
logs, and Rust outputs belong in the ignored `app/SiloUI/src-tauri/target/` tree;
frontend build output belongs in the ignored `app/SiloUI/dist/` tree.

- [Managed SSH access](SiloUI-MANAGED-SSH.md): client keys, local/network listeners, ownership, lifecycle and verification.
