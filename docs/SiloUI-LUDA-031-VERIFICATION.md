# Luda 0.3.1 upgrade verification

Verified on 2026-09-21 using two disposable ARM64 Ubuntu 24.04 v3 VMs and real
Codex CLI 0.145.0 sessions. The source archive is pinned by commit and SHA-256.
The upgrade VM first installed the prior 0.3.0 desktop recipe, then ran the new
`setup-tools` recipe. The other VM installed the new desktop recipe directly.

## Silo changes

- Pin Luda 0.3.1, commit `979efeb740ef2b1aadcf5f49eebd4f3837ecde2f`, archive SHA-256
  `809b94d63c2cb39e8de90a7e6ee8c3104d1a0b37df158215ff9a82194692205c`.
- Set `XDG_CURRENT_DESKTOP=XFCE` in managed desktop startup, including repair of
  existing installations. Do not terminate open applications during repair;
  existing users restart the desktop and reconnect agents afterward.
- Install `greybird-gtk-theme` on fresh desktops and on repair if absent.
- Reinstall after failed/interrupted upgrades. Previously, the new commit in a
  failed state file plus an old executable could cause repair to register the
  old runtime and incorrectly mark the new release ready.
- Report valid installed Luda versions rather than accepting only `0.3.0`.

Both VMs passed independent checks of all seven MCP registration files, their
working-account ownership, updated skill content, the installed 0.3.1 release,
XFCE identity, and installed dark-theme CSS. Fresh provisioning took 105 seconds.

## Agent acceptance results

Eleven fresh agent sessions ran without Luda-specific prompting: eight passed
and three failed independent checks, across 195 MCP calls. All agents discovered
and read the installed skill. Their shell calls only read skill documentation;
GUI tools performed task mutations.

| Task | Environment | MCP calls | Independent result |
| --- | --- | ---: | --- |
| Create Unicode document | Fresh | 15 | Pass, exact saved contents |
| Move and rename in file manager | Fresh | 30 | Pass, destination verified and original absent |
| Edit, save, close and reopen | Fresh | 18 | Pass, exact saved contents |
| Expense form | Fresh | 24 | Pass, exact JSON including dropdowns and checkbox |
| Dark application theme | Fresh | 8 | Fail, selected row but actual theme unchanged |
| Dark application theme | Upgraded | 9 | Fail, selected row but actual theme unchanged |
| Discard unsaved changes | Upgraded | 26 | Pass, original saved text retained |
| Unicode path and document | Upgraded | 46 | Fail, final period omitted |
| Missing file | Upgraded | 9 | Pass, honest absence and no created file |
| Stopped desktop | Upgraded | 0 | Pass, honest unavailability and no service changes |
| Read after desktop restart | Upgraded | 10 | Pass, existing document read unchanged |

There were seven recoverable MCP errors: five BUSY responses and two
NOT_INTERACTABLE responses on hidden form choices. There were no STALE_TARGET
responses. Counts exclude the scripted diagnostic activation and cursor proof.

## Remaining agent failures

The upgraded VM's theme task completed in 63 seconds and nine MCP calls, with no
`STALE_TARGET` error. However, its completion claim was false: the agent selected
`Greybird-dark` with `desktop_choose`, observed its selected state, and stopped.
Independent `xfconf-query` still returned `Greybird` for `/Net/ThemeName`.

This is a distinction between selection and activation. XFCE 4.18 connects the
application-setting callback to `row-activated`, with single-click activation
enabled. AT-SPI table selection changes the selected row without activating it.
A controlled follow-up `desktop_invoke(action="activate")` on the inspected row
changed the actual setting to `Greybird-dark`. Luda's table receipt correctly
verified selection; the agent treated that as proof of the requested application
outcome. Do not make every table selection activate rows as a generic workaround.
The skill needs to distinguish these outcomes and verify application state.

A second independent settings agent on the fresh VM repeated the same selection
without activation in 44 seconds and eight calls. Its actual theme also remained
`Greybird`. Both false completion claims are retained in the evidence.

The Unicode-path task saved the requested Unicode directory and filename but
omitted the final period in the requested document content. Its reopen check
confirmed its own shortened text and claimed success. This is a content-verification
failure, not evidence of a Unicode transport defect.

Primary sources:
[Luda 0.3.1 release](https://github.com/0xpolarzero/luda/releases/tag/v0.3.1),
[XFCE appearance callbacks](https://github.com/xfce-mirror/xfce4-settings/blob/xfce4-settings-4.18.4/dialogs/appearance-settings/main.c),
[Luda table selection](https://github.com/0xpolarzero/luda/blob/v0.3.1/src/luda/ax_worker.py).

## Visible agent pointer

Luda's separate overlay rendered on the live desktop: cyan movement and pink
action feedback. A captured frame also shows the real guest agent's pink marker
at the folder-name field it was editing. A diagnostic overlay was rendered at a
second location and verified through screenshot pixels. These are visual markers,
not movement of the human's pointer. Tool actions may jump between targets.

Evidence: `target/verification/luda-031/cursor-move.png` and `cursor-action.png`.
The latter contains both the real agent marker and the diagnostic marker.

## Automated and packaging checks

- 39 Python installer, desktop-recipe, and desktop-service tests passed.
- Seven targeted Rust desktop tests passed.
- 18 desktop frontend tests passed; frontend typecheck and lint passed.
- The final debug app built successfully at
  `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`.

Native UI execution was blocked by the remote-management instance lock held by
`/Applications/Silo.app`. Its process and VMs were left untouched. Thus this run
proves the bundled guest recipes and real GUI agent path, not user interaction
with a newly launched Silo viewer. The first disposable VM attempt used a stale
cached v2 image; that VM was removed and recreated with the rebuilt v3 image
before any acceptance cases. Raw evidence remains in ignored directories
`app/SiloUI/src-tauri/target/verification/luda-031/` and `luda-031-fresh/`.

## Cleanup

Both temporary Codex credential copies were removed and checked absent before
VM deletion. Both VMs and their isolated runtime/disk directories were removed,
and no copied test runtime process remained. Test harnesses and private evidence
were retained under ignored verification directories; the evidence credential
scan found no credential values. The user's existing Silo process and VMs were
not stopped or modified.
