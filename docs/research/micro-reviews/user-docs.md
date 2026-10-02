# Bundled help fix-loop review

Scope: `app/SiloUI/docs/silo-help.html`, checked against app code. The initial audit remains in the shared `codex-micro` worktree. This supplement records the isolated fix loop; no app or VM was launched.

## USER-DOCS-1 — P3 — Checkpoint deletion needs the owning computer

- **File:line:** `app/SiloUI/docs/silo-help.html:18`.
- **Trigger/consequence:** The documented Delete menu item is absent for connected-computer checkpoints.
- **Evidence:** `checkpoint-panel.tsx:58,269` restricts deletion to local checkpoints; `production-source.ts:1508` rejects remote deletion.
- **Fix:** Explain that users must open Silo on the owning computer.
- **Test:** New bundled-help regression failed before the correction; it and the existing checkpoint-panel suite passed afterward (26 tests total). Typecheck, focused lint and whitespace checks passed.
- **Status:** Fixed and folded, `83b99c54`.

## USER-DOCS-2 — P3 — Safari hostname guarantee excludes supported macOS versions

- **File:line:** `app/SiloUI/docs/silo-help.html:14`.
- **Trigger:** Use Safari on macOS 14 or 15 without custom localhost-subdomain DNS configuration, then open a published sandbox website.
- **Evidence:** Help promises these addresses work “In every browser, including Safari.” `src-tauri/tauri.conf.json:86` supports macOS 14.0 onward. `network.rs:947–949` opens a generated `.localhost` name, and `applications/macos.rs:43–55` passes that URL unchanged to the selected browser. [WebKit bug 160504](https://bugs.webkit.org/show_bug.cgi?id=160504#c19) reports failure on macOS 15.7 and success on macOS 26.0; [the WebKit maintainer confirms](https://bugs.webkit.org/show_bug.cgi?id=160504#c20) implementation in OS frameworks. This is source and primary-report evidence; no Safari session was exercised.
- **Consequence:** The help promises a working address that Safari cannot resolve on supported systems, and describes the IP-copy fallback only as a remedy for servers rejecting hostnames.
- **Suggested fix:** State Safari's macOS 26 requirement, direct earlier-macOS users to Chrome or Firefox, and explain that the existing `127.0.0.1` fallback shares its cookie hostname with other local services.
- **Test that would catch it:** Check that the bundled Network instructions qualify Safari support by macOS version and preserve the separate sandbox address plus the IP fallback. Existing network UI fixtures verify the address and fallback actions.
- **Validation:** The new help regression failed before the correction. Both help regressions and all 22 network-page tests passed afterward (24 tests total); typecheck, focused lint and whitespace checks passed.
- **Status:** Fixed and folded, `af57838d`.

## USER-DOCS-3 — P3 — Troubleshooting assumes every Details section has a copy control

- **File:line:** `app/SiloUI/docs/silo-help.html:56`.
- **Trigger:** An update fails with `errorDetails`; follow the help's instruction to expand Details and use its copy control.
- **Evidence:** `features/updates/updates.tsx:58–60` renders the error and an expandable Details section containing a paragraph. It has no copy control. The help makes the copy instruction conditional only on Details being available.
- **Consequence:** Users collecting update diagnostics are directed to a control that does not exist.
- **Suggested fix:** Keep the instruction to expand diagnostics, but qualify copying with “when one is offered.”
- **Test that would catch it:** A bundled-help content regression should require the copy-control availability qualification in the troubleshooting paragraph; the update error details remain expandable without a copy control.
- **Validation:** The new help regression failed before the correction; it and the existing update-card suite passed afterward (29 tests total). The correction changes only the help instruction.
- **Status:** Fixed and folded, `d5830840`.

## USER-DOCS-4 — P3 — Reclamation is described as shrinking the workspace disk

- **File:line:** `app/SiloUI/docs/silo-help.html:23`.
- **Trigger/consequence:** Read Storage help before reclaiming; “shrinks the workspace disk” implies changing disk size even though workspace capacity remains unchanged.
- **Evidence:** `runtime/storage.rs:473–516` guards and restores disk length and measures host allocation; `runtime/storage/tests.rs:748–812` covers releasing allocated blocks without shortening the disk. `workspace-storage-panel.tsx:192` explicitly says files and capacity stay the same.
- **Fix:** Describe releasing unused allocation on the computer while preserving workspace files and capacity, and retain the runtime/checkpoint exclusion.
- **Test:** The bundled-help regression failed on the old description. Focused help and Storage UI tests, typecheck, focused lint and whitespace checks validate the correction.
- **Status:** Fixed and folded, `6f5ca5ae`; 29 focused help/Storage tests passed, plus typecheck, focused lint and whitespace checks. The audit merge was resolved in `e2cb0c54`, preserving the original review below.

## USER-DOCS-5 — P3 — Duplicating settings does not preserve manual desktop startup

- **File:line:** `app/SiloUI/docs/silo-help.html:10`.
- **Trigger:** Duplicate an older sandbox whose desktop has `startWithSandbox: false` on a computer with built-in computer use.
- **Evidence:** `machine-editor.tsx:162–173,236` replaces that setting with automatic startup for new built-in sandboxes. `desktop/computer-use.test.tsx:367–373` already verifies the duplicated settings are saved with `startWithSandbox: true`.
- **Consequence:** The help promises the same settings, but the new sandbox starts its desktop automatically when the source would not.
- **Fix:** State the built-in desktop exception in the Duplicate settings instructions.
- **Test:** The new bundled-help regression failed on the unqualified promise. The help regression and existing computer-use suite cover the corrected instruction and its creation behavior.
- **Status:** Fixed and folded, `efc28d5f`; 118 focused help/computer-use tests passed, plus typecheck, focused lint and whitespace checks.

## USER-DOCS-6 — P3 — System issue recovery still directs users to relaunch

- **File:line:** `app/SiloUI/docs/silo-help.html:56`.
- **Trigger:** Follow the bundled troubleshooting instructions after a dependency check fails.
- **Evidence:** `system-issue-page.tsx:20–31` offers Retry checks and displays specific recovery instructions. `production-surface.tsx:86` reruns dependency checks and initializes live updates through that action; `production-surface.test.tsx:160–192` covers retry and recovery. `application-lifecycle.test.tsx:501–510` covers fixing KVM access then retrying. The help still prescribes relaunching to rerun checks.
- **Consequence:** Users bypass the recovery action and the displayed host-specific fix; quitting to relaunch also stops local sandboxes.
- **Fix:** Direct users to follow the displayed recovery instructions and choose Retry checks.
- **Test:** The bundled-help regression failed on the old relaunch instruction; existing recovery tests cover the action it now names.
- **Status:** Fixed and folded, `b1e072ec`; 21 focused help/production-recovery tests passed, plus typecheck, focused lint and whitespace checks.

## USER-DOCS-7 — P3 — Checkpoint deletion instructions omit local dependencies and overstate retention

- **File:line:** `app/SiloUI/docs/silo-help.html:18`.
- **Trigger:** Delete a checkpoint with no forks while the owning sandbox's lineage or a later checkpoint still needs it; alternatively delete the last dependent checkpoint after its source sandbox was deleted.
- **Evidence:** `runtime/checkpoints.rs:2386–2417` reports same-sandbox lineage and later-checkpoint/export blockers. The deterministic `checkpoints_that_forks_later_checkpoints_or_pending_starts_depend_on_are_refused` test at line 5606 covers both local blockers with no fork. `deleting_the_last_dependent_checkpoint_releases_the_deleted_sources_member` at line 5960 releases retained data while the dependent sandbox remains configured. `checkpoint-panel.tsx:244,269` displays the reason and disables Delete.
- **Consequence:** The help tells users to select Delete when it is disabled for local dependencies and incorrectly says retained fork data stays until the last dependent sandbox is deleted.
- **Fix:** Qualify Delete availability, name same-sandbox and saved-state dependencies, and explain that removing the final dependency releases retained data.
- **Test:** A new bundled-help regression failed before the correction; the checkpoint panel suite verifies disabled Delete and visible reasons. Native dependency tests were inspected, not rerun, because only help text changed.
- **Status:** Fixed and folded, `e7223a1b`; 33 focused help/checkpoint-panel tests passed, plus typecheck, focused lint and whitespace checks.

## USER-DOCS-8 — P3 — Update instructions incorrectly cover the Dev build

- **File:line:** `app/SiloUI/docs/silo-help.html:53`.
- **Trigger:** Open bundled help in Silo Dev and follow the automatic or manual release-check instructions.
- **Evidence:** `tauri.dev.conf.json` overlays the base bundle configuration without replacing its help resources; `app_menu.rs:374–376,394` opens `docs/silo-help.html`. `updates.rs:218` disables automatic checks for Dev and `updates.rs:386–394` returns from manual checks before contacting the release feed. `docs/SiloUI-BUILD-CHANNELS.md:11` records that Silo Dev never updates itself or installs a production release.
- **Consequence:** Dev users are told that a check queries releases and can update the app, although that channel has no feed.
- **Fix:** Qualify the instructions as production-only and state the Dev channel's update behavior.
- **Test:** The new bundled-help regression failed before the qualification. Help and existing update-card tests cover the corrected instructions and the production update controls.
- **Status:** Fixed and folded, `d8508ef9`; 36 focused help/update-card tests passed, plus typecheck, focused lint and whitespace checks.

## USER-DOCS-9 — P3 — Older desktop startup skips a required update

- **File:line:** `app/SiloUI/docs/silo-help.html:38`.
- **Trigger:** Open an installed, stopped legacy desktop whose state has `updateRequired: true`, then follow the help's manual startup instruction.
- **Evidence:** `linux-desktop-viewer.tsx:34,49–50` replaces Start desktop with Update desktop in this state. `linux-desktop-native.test.tsx:263–284` verifies that updating makes Start desktop available without starting or attaching the desktop. `guest/setup-desktop.sh:156–158` requires the desktop session to be stopped, while `desktop.rs` executes the installer inside the running sandbox.
- **Consequence:** The documented manual startup path is unavailable until an explicit update, and the help provides no update steps.
- **Fix:** Explain the conditional update prerequisite, running-sandbox/stopped-desktop requirements, and the explicit Start desktop step afterward.
- **Test:** A new help regression failed on the missing prerequisite; existing deterministic desktop-viewer tests verify required and optional update behavior.
- **Status:** Fixed and folded, `e6d100e9`; 28 focused help/desktop-viewer tests passed, plus typecheck, focused lint and whitespace checks.

## USER-DOCS-10 — P3 — Settings menu path uses the production name in Dev

- **File:line:** `app/SiloUI/docs/silo-help.html:50`.
- **Trigger:** Follow the macOS Settings menu path in bundled help while using Silo Dev.
- **Evidence:** `app_menu.rs:165,177–183` names the application submenu with `channel::current().product_name()`; `channel.rs:65–66` returns Silo Dev in the development channel. Both builds bundle this same help.
- **Consequence:** The documented Silo menu does not exist in the Dev build, although the Settings action and shortcut are available under Silo Dev.
- **Fix:** Name both application-menu paths while retaining the macOS shortcut.
- **Test:** The bundled-help regression failed on the missing Dev menu path. Focused menu and help tests verify the correction; native naming code was inspected without launching an app.
- **Status:** Fixed and folded, `6b505e81`; 13 focused help/menu tests passed, plus typecheck, focused lint and whitespace checks.

## USER-DOCS-11 — P3 — Computer-use setup needs a running desktop too

- **File:line:** `app/SiloUI/docs/silo-help.html:34`.
- **Trigger:** Stop the built-in desktop while leaving its sandbox running, install an agent from Terminal, and follow the setup instruction.
- **Evidence:** `computer-use-panel.tsx:248` passes desktop state to the setup control; `ComputerUsePanel` disables setup when that state is not running. `computer-use.test.tsx:110–115` verifies disabled setup while stopped. `silo-computer-use.py:434–452` checks the desktop session and reports `desktop-session-not-running` when it cannot become ready.
- **Consequence:** A running sandbox alone does not make the documented setup action available; the user must start its desktop too.
- **Fix:** Name both prerequisites and direct users to start a stopped desktop from its viewer.
- **Test:** The new bundled-help regression failed before the correction. Focused help/computer-use tests, typecheck, focused lint and whitespace checks validate the corrected prerequisite.
- **Status:** Fixed in the accompanying `docs(help): require a running desktop for agent setup` commit; 127 focused help/computer-use tests passed, plus typecheck, focused lint and whitespace checks.

Second-loop verification used Node.js 24.11.1. The combined Vitest run of `bundled-help`, `checkpoint-panel`, `workspace-storage-panel`, `network-page`, `updates`, `computer-use`, `production-surface`, `linux-desktop-native`, and `app-menu` tests with `--maxWorkers=1` passed all 271 tests in nine files. Findings 4–10 each had a failing help regression before their text changed, a patch changeset, focused tests, typecheck, focused oxlint, and whitespace checks. Changes were folded individually after merging current integration. No app, packaged bundle, or VM was launched; UI behavior was tested with deterministic fixtures, and native behavior was checked in source.

First-loop verification used Node.js 24.11.1: `npm --prefix app/SiloUI test -- src/test/bundled-help.test.ts src/features/application/components/checkpoint-panel.test.tsx src/features/application/pages/network-page.test.tsx src/features/updates/updates.test.tsx --maxWorkers=1` passed all 76 tests. `npm --prefix app/SiloUI run typecheck`, focused oxlint for `src/test/bundled-help.test.ts`, and `git diff --check` passed. No Rust files changed, so Rust formatting and native tests were not applicable. No packaged bundle or live data was inspected.

## Original read-only audit

### Bundled help review

Scope: `app/SiloUI/docs/silo-help.html`, checked against current frontend and native implementation. Read-only source review; no app launch, builds, or tests. Checked both earlier review reports and `docs/SiloUI-CODE-REVIEW-PASS-3-*.md`; excluded the previously reported full-checkpoint import mismatch (R-28).

#### USER-DOCS-1 — P3 — Checkpoint deletion instructions omit the owning-computer requirement

- **File:line:** `app/SiloUI/docs/silo-help.html:18`.
- **Trigger:** Connect another computer, open one of its sandboxes' Checkpoints tabs, and follow “Delete checkpoint data through Delete… in the checkpoint's actions menu, then confirm.” The help's checkpoint instructions cover connected sandboxes and qualify Export as local at line 17, but give no such restriction or alternative for Delete.
- **Evidence:** `app/SiloUI/src/features/application/components/checkpoint-panel.tsx:58` defines local as `!workspace.computer`; lines 268–269 include the Delete item only for local sandboxes. `app/SiloUI/src/desktop/production-source.ts:1508` explicitly rejects remote deletion with “Delete checkpoints of this sandbox in Silo on its own computer.” This is an intentional product restriction, not an offline-state failure.
- **Consequence:** Users following the bundled help cannot find the instructed action for connected sandboxes and receive no instruction to switch to the owning computer to remove checkpoint data.
- **Suggested fix:** Qualify checkpoint deletion as local and tell users to open Silo on the sandbox's owning computer to delete its checkpoints.
- **Test that would catch it:** Render the Checkpoints panel with a connected-computer fixture and assert that Delete is absent while Fork and Restore remain available; check that the bundled help explicitly directs remote checkpoint deletion to the owning computer. Include a local fixture with a deletable checkpoint as the positive control.
