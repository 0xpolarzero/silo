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
- **Status:** Fixed in the accompanying `docs(help): qualify diagnostic copy instructions` commit.

Final verification used Node.js 24.11.1: `npm --prefix app/SiloUI test -- src/test/bundled-help.test.ts src/features/application/components/checkpoint-panel.test.tsx src/features/application/pages/network-page.test.tsx src/features/updates/updates.test.tsx --maxWorkers=1` passed all 76 tests. `npm --prefix app/SiloUI run typecheck`, focused oxlint for `src/test/bundled-help.test.ts`, and `git diff --check` passed. No Rust files changed, so Rust formatting and native tests were not applicable. No packaged bundle or live data was inspected.
