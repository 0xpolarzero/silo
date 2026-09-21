# Luda agent-driven acceptance tests

Executed on 2026-09-21: ten substantive agent cases against the released
configuration, followed by one diagnostic rerun. Nine baseline cases passed;
the application-theme case falsely reported completion. This is bounded
acceptance testing, not exhaustive coverage of every agent or GUI application.

## Environment and method

- Published Silo 1.0.0 macOS ARM64 archive, verified against its release SHA256SUMS.
- App: `/private/tmp/silo-1.0.0-agent-test/Silo.app`.
- One isolated CLI-created VM and one VM created through Silo's normal UI, both
  using the released runtime and Ubuntu 24.04 v3 image.
- UI-created VM: `luda-ui-test`, 2 CPUs, 4 GiB initial RAM, Linux desktop enabled.
- Codex CLI 0.145.0 installed after desktop provisioning. Existing Luda
  registration and user-wide skill were retained without additional hints.
- Separate `codex exec` sessions, with ordinary outcome-based GUI requests.
  Prompts do not name Luda, the skill, tool calls, controls, or click coordinates.
  Agents may read skill documentation but may not perform task file operations
  through shell commands. Tasks run sequentially per desktop, in parallel only
  when they target different VMs.
- Private JSONL transcripts capture actual MCP calls, errors and responses.
  The supervising process independently checks resulting files and settings.
- The user explicitly authorized temporary Codex authentication in the test VMs.
  Credentials must be removed before VM cleanup; no authentication material is
  part of this report or the repository evidence.

The CLI uses its normal noninteractive JSON event stream as documented in
[OpenAI's noninteractive guide](https://learn.chatgpt.com/docs/non-interactive-mode).
These are real agent processes inside the VMs, not scripted MCP call sequences.

## Results

Each row is a new in-VM Codex session. Times include model and tool latency.

| Case | Seconds | MCP calls | Result |
| --- | ---: | ---: | --- |
| Create and save Unicode document | 179 | 18 | Pass; requested lines correct, no trailing newline |
| GUI folder creation, move and rename | 223 | 27 | Pass; independently verified paths and contents |
| Edit, save, close and reopen | 99 | 19 | Pass; exact saved contents verified |
| Discard unsaved edit and reopen | 316 | 31 | Pass; discarded text absent from disk |
| Missing file | 145 | 17 | Pass; accurately reported absence, created nothing |
| Synthetic expense form | 72 | 20 | Pass; all fields, dropdown values, checkbox and saved JSON verified |
| Unicode directory and filename | 142 | 36 | Pass; exact bytes and text verified after reopening |
| Desktop stopped | 21 | 0 | Pass; accurately reported unavailable controls, made no changes |
| Read after UI stop/start | 57 | 8 | Pass; reconnected and read existing text unchanged |
| Dark application theme | 630 | 66 | Fail; changed icon theme and reported success |

The ten baseline cases made 242 MCP calls. All ten independently read the Luda
skill without a skill hint. All agent shell calls were documentation reads;
file and setting mutations used GUI tools. The five MCP error responses were
all in the failed settings case. Success means the stated narrow check passed,
not that all behavior of the application or tool has been verified.

Two additional attempts are separated from this table: one Unicode task ended
with a model-capacity error before any MCP call and succeeded on an unchanged
retry; the first synthetic-form run could not launch because the test fixture
lacked `gir1.2-gtk-3.0`. The agent accurately reported no saved draft. Installing
that test-only dependency made the unchanged task pass. Neither is classified
as a Luda defect.

## Confirmed failures

### Desktop application discovery omits XFCE-only applications

`xfce-ui-settings.desktop` has `OnlyShowIn=XFCE;`, but neither the launched XFCE
session nor the MCP server has `XDG_CURRENT_DESKTOP`. Luda's application helper
uses Gio `should_show()`, which hides the entry. Running the same installed
helper in a fresh process with `XDG_CURRENT_DESKTOP=XFCE` finds Appearance;
without the variable it finds no Appearance entry. The uncoached agent saw only
seven applications and spent many calls navigating around this omission.

There are two source seams: Silo's XFCE startup script does not establish the
desktop identity, and Luda 0.3.0's launcher/reconnect allowlists do not propagate
it. Supplying the variable only to the launcher caller does not fix the boundary.
Preserve desktop-entry visibility filtering when correcting this.

### Stable composite table cells incorrectly report STALE_TARGET

Two attempts to choose an icon-theme cell failed immediately after fresh
inspections, without an intervening GUI mutation. A read-only live AT-SPI
comparison confirmed that the inspected named text renderer was
`/org/a11y/atspi/accessible/111`, while `Table.get_accessible_at(1, 0)` returned
its unnamed parent `/org/a11y/atspi/accessible/109`. Luda requires those object
identities to be equal, rejecting a stable GTK composite-cell representation.

The diagnostic rerun encountered the same defect on the application-style list.
Both agents recovered using screenshot-grounded clicks. A fix must validate the
stable canonical cell and the inspected descendant's ancestry/meaning, retaining
replacement/reordering protection rather than removing identity validation.

### Wrong setting substituted and reported as success

The released image's Style list was empty: no GTK theme CSS was installed and
`greybird-gtk-theme` was absent. The settings agent eventually opened Appearance,
then selected **Icons**, chose **Humanity-Dark**, and reported task completion.
Independent `xfconf-query` showed `/Net/IconThemeName=Humanity-Dark` but
`/Net/ThemeName=Greybird`. The requested application dark style was not applied.

The agent also skipped the targeting guide required before coordinate actions
and tried a hidden cell twice after `NOT_INTERACTABLE`. The file-manager agent
likewise omitted that guide before two screenshot-grounded clicks, though its
outcome passed. These are skill-following weaknesses. A better success check
must retain the user's requested setting category and report an unavailable
choice rather than silently substituting a nearby category.

## Controlled correction comparison

Only in the disposable UI VM, the test added `XDG_CURRENT_DESKTOP=XFCE` before
XFCE startup, propagated it through Luda's launcher/reconnect allowlists, and
installed `greybird-gtk-theme`. Neither production repository implementation nor
published artifacts were changed. After a desktop restart, a new agent received
the **identical** settings prompt, with no explanation of the fixes.

It selected the actual **Greybird-dark** application style in **63 seconds and
15 MCP calls**, compared with the original failed attempt's 630 seconds and
66 calls. The state was independently verified through `/Net/ThemeName` and the
visible Silo viewer. Two `STALE_TARGET` errors remained; screenshot fallback
completed the selection. This validates the environment/theme diagnosis without
claiming that the table bug is fixed.

## Silo removal failure found during cleanup

Deleting the running test VM through Silo left the UI permanently displaying
“Applying sandbox changes” and “Removing sandbox from Silo.” Independent runtime
inspection showed the VM still running, unchanged metadata, and no active
removal process. The backend correctly refuses to remove a running VM before
mutation, but its preflight failure occurs before workspace-scoped progress.

The production store records a failed operation with an unscoped error.
`overview-page.tsx` requires a matching workspace to show the error, then
unconditionally renders the removed candidate row as running. Its header treats
any non-null operation as applying. Refresh preserves this failed operation,
and locked controls prevent stopping the VM through the row.

Terminal status must govern rendering, unscoped failures must be visible, and
dismissing a failed candidate must restore committed rows and lifecycle controls.
Backend preflight should identify its target explicitly. Regressions should
cover rejection before scoped progress, an accurate failed summary, dismissal
restoring Stop, and no backend removal or metadata mutation.

For cleanup, the test VM was explicitly stopped through the bundled runtime.
After restarting Silo, deleting the stopped VM through the same UI succeeded.

## Silo user-flow coverage

The published app's normal UI created the VM with Linux desktop enabled, started
it, opened the desktop viewer, showed agent readiness, repaired agent tools,
stopped the desktop with confirmation, and started it again. The restarted
session was usable by a fresh guest agent. Stopping briefly showed a KasmVNC
connection-closed message before Silo's stopped screen. After a later external
CLI restart, the viewer's Connect control restored the display.

Agent work and Unicode rendering were visible in the viewer. Direct native
canvas automation repeatedly opened macOS's Paste prompt, so it did not produce
a clean manual-keyboard acceptance result. Clipboard upload and seamless
clipboard were temporarily disabled for diagnosis and restored to their original
values. This observation is not proof of a general human-input defect.

## Remaining scope

This exercised Codex CLI 0.145.0 on ARM64 macOS-hosted Ubuntu, not all seven agent
clients or x86-64 hosts. No browser-heavy workflows, IME composition, concurrent
human/agent input, competing agents on one desktop, or every Luda tool was tested.
Agents used isolated full-access guest execution and existing user-wide setup;
client approval/sandbox variants remain separate acceptance cases.

## Fix order

1. Establish and propagate desktop identity in Silo and upstream Luda, with
   startup/reconnect and OnlyShowIn/NotShowIn regressions.
2. Fix upstream composite table-cell validation with stable-child and changed-row
   regressions.
3. Strengthen skill guidance for setting-category verification, hidden controls,
   required targeting references and repeated no-progress recovery.
4. Decide whether to include the standard GTK theme and investigate the native
   viewer clipboard prompt separately.
5. Fix failed-removal rendering and recovery in Silo; retain the backend's
   running-VM safety check.

Primary code seams: [Silo desktop startup](https://github.com/0xpolarzero/silo/blob/v1.0.0/app/SiloUI/src-tauri/guest/setup-desktop.sh),
[Luda session launcher](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/session.py),
[reconnect](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/session_reconnect.py),
[application filtering](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/_app_helper.py),
and [table selection](https://github.com/0xpolarzero/luda/blob/v0.3.0/src/luda/ax_worker.py).

## Evidence

Raw transcripts, prompts, timing, and independent checks remain in ignored local
`app/SiloUI/src-tauri/target/verification/luda-agents/`. Screenshots contain only
synthetic test data. The user's existing `dev` VM was not started or modified.

Cleanup completed: both temporary guest credential copies were removed and
their absence verified before VM deletion. Both test VMs, the retained UI-test
workspace disks, and the downloaded verification app were removed. The test app
and runtime processes exited. Silo's final UI showed only the original `dev`
VM, still stopped; the app was then quit. Local evidence is retained for fixes.
