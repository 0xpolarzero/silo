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
| VM tools | [Working account](SiloUI-WORKING-ACCOUNT.md), [VM migration](SiloUI-WORKING-ACCOUNT-MIGRATION.md), [Linux desktop](SiloUI-DESKTOP.md), [agent desktop tools](SiloUI-LUDA.md), [Files](SiloUI-FILES.md), [network](SiloUI-NETWORK-PLAN.md), [terminal handoff](SiloUI-TERMINAL-HANDOFF.md), [editor and browser handoff](SiloUI-EDITOR-HANDOFF.md) |
| Logs | [Retained history, search and export](SiloUI-LOGS.md), [sandbox failure reporting](SiloUI-FAILURE-REPORTING.md) |
| Storage | [Workspace reclamation policy and verification](SiloUI-STORAGE-RECLAMATION.md), [disk discard regression](SiloUI-STORAGE-DISCARD-RESEARCH.md) |
| Desktop behavior | [Settings](SiloUI-SETTINGS.md), [native menus](SiloUI-NATIVE-MENUS.md), [status panel](SiloUI-STATUS-PANEL.md) |

## Research and design evidence

- [Landing page reference](SiloUI-LANDING-REFERENCES.md): approved Zed direction, product evidence, and website implementation.

Research records the inputs to a decision. Follow the implementation documents
above for current behavior and build commands.

- [Jev for natural-language commands](SiloUI-JEV-RESEARCH.md): primary-source findings, command-palette fit, limitations and proposed evaluation.

- [Domain research](SiloUI-DOMAIN-RESEARCH-2026-09-19.md): domain availability, registrar pricing, and naming options checked on 2026-09-19.

- [Logging and retention audit](SiloUI-LOGGING-AUDIT.md): current storage limits, log and activity presentation, and retention gaps.

- [Development and release optimization plan](SiloUI-WORKFLOW-OPTIMIZATION-PLAN.md): measured bottlenecks, ranked changes, and benchmark acceptance gates.
- [Server-free GitHub research](SiloUI-GITHUB-SERVER-FREE-RESEARCH.md): primary sources and authorization constraints behind the native implementation.
- [GitHub client-secret release audit](SiloUI-OAUTH-RELEASE-AUDIT.md): public 0.1.1 package inspection, live App settings, and independent PKCE enforcement checks.
- [Workflow performance](SiloUI-WORKFLOW-PERFORMANCE.md): implementation, controlled measurements and hosted comparison.
- [Native compilation experiment](SiloUI-NATIVE-COMPILATION-EXPERIMENT.md): measured test-target reduction and the compiler-cache acceptance gate.
- [Frontend test performance](SiloUI-FRONTEND-TEST-PERFORMANCE.md): controlled environment-split measurements.
- [Guest image size experiment](SiloUI-GUEST-IMAGE-SIZE.md): measured image-size tradeoffs.
- [E2B fit for Silo](research/e2b-fit-2026-09-22.md): agent desktop capabilities, snapshots, local hosting requirements and the proposed comparison workflow.
- [Executed local E2B desktop PoC](research/e2b-local-poc-2026-09-22.md): working ARM64 nested desktops, human handoff, memory snapshots, host restart recovery and measured resource costs.
- [E2B + LCU qualification](research/e2b-lcu-qualification-2026-09-22.md): historical LCU, credentials, Git/LFS, SSH and native viewer results, with corrected limits on checkpoint/pause/restore attribution.
- [E2B PoC investigation and completion handoff](SiloUI-E2B-QUALIFICATION-HANDOFF.md): current orchestrator brief, minimal failure reproductions, evidence corrections, model/delegation policy and full remaining qualification gates.
- [E2B qualification work log](research/e2b-qualification-worklog-2026-09-23.md): scratch deployment, isolated SDK controls, changes made, and remaining runtime gates.
- [E2B qualification gate matrix](research/e2b-qualification-gates-2026-09-23.md): investigation status, execution verdicts, evidence, and exact blocked or unrun work.
- [E2B lifecycle source audit](research/e2b-lifecycle-source-audit-2026-09-23.md): D1/D2 call graphs and pause-upload shutdown boundary for the captured source.
- [E2B D1 post-capture reproduction](research/e2b-d1-post-capture-repro-2026-09-23.md): controlled source-built failure, independent state oracles, survivor inventory, and restore limit.
- [E2B D3 artifact audit](research/e2b-d3-artifact-audit-2026-09-23.md): exact failed restore identity, catalog row, panic/upload timeline, and canonical file hashes.
- [E2B D3 controlled restarts](research/e2b-d3-controlled-restarts-2026-09-23.md): exact SDK control across orchestrator and clean host restart, including canonical readback and recovery limits.
- [E2B fresh desktop and synthetic Git qualification](research/e2b-fresh-desktop-qualification-2026-09-23.md): two scratch-candidate runs, current-grant restore, browser/native viewer observations, cleanup, and remaining limits.
- [E2B viewer input readiness](research/e2b-viewer-input-readiness-2026-09-23.md): native pointer/modifier diagnosis and two-viewer ownership evidence.
- [E2B upstream report readiness](research/e2b-d1-report-readiness-2026-09-23.md): D1 checkpoint attribution and exact reproduction threshold; see also [D2 report review](research/e2b-d2-independent-review-2026-09-23.md), [D3 restore review](research/e2b-d3-report-readiness-2026-09-23.md), and [release-source mapping](research/e2b-release-source-mapping-2026-09-23.md).
- [E2B causal bounds, late session](research/e2b-causal-bounds-2026-09-23-late.md): D1 fault at the real `ResumeSandbox` call boundary, an actual kernel `fsync` EIO reproducing the exact historical pause error on the pinned release binary, D3 cache-topology finding plus an activity control, Gate A/R live results, a real-ENOMEM checkpoint reproduction on the release binary, the D2 physical-cause bound, and upstream issues e2b-dev/runtime#3658 and #3659.
- [E2B D3 root cause](research/e2b-d3-root-cause-2026-09-23.md): deterministic 3/3 reproduction of the 41919-descriptor restore panic from hash-verified stored artifacts, clean previous-generation control, capture-time corruption during the documented full-disk window; upstream issue e2b-dev/runtime#3659.
- [E2B real-provider qualification](research/e2b-real-provider-qualification-2026-09-24.md): nine-case GitHub matrix on a disposable private repo — Git/LFS round trips, REST/GraphQL, denied controls and credential-host accounting.
- [E2B viewer input root cause](research/e2b-viewer-input-root-cause-2026-09-24.md): layer-by-layer isolation proving the WKWebView viewer chain delivers modifier-correct input; native-automation failures are macOS synthetic-event trust, not viewer defects.
- [E2B canonical control readback](research/e2b-canonical-readback-2026-09-23.md): exact SDK pause control, transitive file hashes, and why current readback does not prove restart durability.
- [E2B D2 error audit](research/e2b-d2-error-audit-2026-09-23.md): exact rootfs sync error, process/catalog timeline, and present artifact inventory.
- [E2B D2 rootfs sync reproduction](research/e2b-d2-rootfs-sync-repro-2026-09-23.md): controlled source-built pause failure, SDK recovery checks, and limits of the synthetic EIO.
- [E2B credential contract audit](research/e2b-credential-contract-2026-09-23.md): current Silo grant policy, PoC broker gaps, and synthetic receipt evidence.
- [E2B access and viewer audit](research/e2b-access-viewer-audit-2026-09-23.md): transport, native editor, and viewer qualification gaps.
- [E2B replacement plan](SiloUI-E2B-REPLACEMENT-PLAN.md): proposed breaking replacement, before/after flows, explicit deletion map, security and access gates, and implementation acceptance criteria.
- [Codex, E2B and Luda computer use](research/codex-e2b-luda-computer-use-2026-09-22.md): observed native Codex interface, public API distinction, simplicity hypothesis and controlled comparison.
- [Codex Linux engine probe](research/codex-linux-engine-probe-2026-09-22.md): official package distribution and a passing ARM64/X11 accessibility, input and screenshot test.
- [Luda integration plan](SiloUI-LUDA-IMPLEMENTATION-PLAN.md): pinned installer research, single-account scope and verification gates.
- Luda agent evidence: [acceptance tests](SiloUI-LUDA-AGENT-TESTS.md), [initial skill evaluation](SiloUI-LUDA-SKILL-EVALUATION.md), [accepted skill benchmark](SiloUI-LUDA-SKILL-BENCHMARK.md), and [upstream handoff](SiloUI-LUDA-UPSTREAM-HANDOFF.md).
- [Linux desktops for agents](SiloUI-LINUX-DESKTOP-RESEARCH.md): proposed guest desktop, agent compatibility, estimated costs and prototype acceptance.
- [Desktop and streaming assessment](SiloUI-DESKTOP-STACK-ASSESSMENT.md): September 2026 comparison of desktop environments, viewer stacks, Luda compatibility, maintenance evidence and selection criteria.
- [Independent desktop and viewer selection](SiloUI-DESKTOP-SELECTION.md): current selection recommendation without agent-library constraints, evidence notation, weighted measurement rubric, candidate leaderboards, primary-source annexes and qualification protocol.
- [Optional desktop implementation plan](SiloUI-DESKTOP-IMPLEMENTATION-PLAN.md): desktop installation, automatic/manual lifecycle, minimal viewer and verification gates.
- [Historical ext4 discard investigation](../artifacts/ext4-raw-image-root-cause.html): upstream MicroSandbox v0.6.8 reproduction and regression requirements; not current app validation.
- Branding studies: [logo system](../artifacts/silo-logo-system.html), [proportions](../artifacts/silo-proportion-study.html), [structure](../artifacts/silo-structure-study.html), and [top-down study](../artifacts/silo-top-down-study.html).

Shared branding files live in [`assets/`](../assets/). Generated native bundles,
logs, and Rust outputs belong in the ignored `app/SiloUI/src-tauri/target/` tree;
frontend build output belongs in the ignored `app/SiloUI/dist/` tree.

- [Managed SSH access](SiloUI-MANAGED-SSH.md): client keys, local/network listeners, ownership, lifecycle and verification.
