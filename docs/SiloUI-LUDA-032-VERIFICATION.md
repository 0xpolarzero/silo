# Luda 0.3.2 verification

Executed on 2026-09-21 against a disposable ARM64 Ubuntu 24.04 v3 VM using
Silo's bundled runtime and guest recipes. The VM first installed 0.3.1 from the
previous committed recipe, then ran the updated `setup-tools` action. Agents
were fresh Codex CLI 0.145.0 sessions inside the VM, using the existing all-agent
registration and ordinary outcome-based prompts without Luda hints.

## Upgrade

Pinned release: `0.3.2`, commit `adba0834504d22e42e97a68e87c7f61759d18aba`.
Source archive SHA-256:
`42362e01b174fe66fb181ffdb8b3e0c117ff71bc8c7b31f8408146a3ef36bc2b`.

The live upgrade reported version 0.3.2 ready. Independent checks verified all
seven client registration files, working-account ownership, installed theme CSS,
XFCE identity, and the new selection-versus-activation guidance in installed
skills. No additional setup changes were required for this release.

## Remaining theme failure

The first fresh agent received the unchanged request to change the application
appearance to a dark theme. It read the installed skill, launched Appearance,
chose `Greybird-dark`, inspected its selected state, and claimed completion.
It made nine MCP calls in 55 seconds, with no activation call. Independent
`xfconf-query -c xsettings -p /Net/ThemeName` still returned `Greybird`.

Thus the new guidance is packaged and installed correctly, but this real agent
still equated selected-row state with application completion. Luda's table
operation itself correctly selected the row. The previous diagnostic established
that invoking the advertised `activate` action changes XFCE's actual setting.
This run does not justify changing every table selection into activation.

Sources: [0.3.2 release](https://github.com/0xpolarzero/luda/releases/tag/v0.3.2),
[installed skill source](https://github.com/0xpolarzero/luda/blob/v0.3.2/skills/luda/SKILL.md),
[choose tool contract](https://github.com/0xpolarzero/luda/blob/v0.3.2/src/luda/server.py).

A second fresh agent repeated the failure in 48 seconds and ten calls on the
same desktop: selected-row verification only, actual setting still `Greybird`.
After an explicit desktop restart, a third fresh agent used a screenshot click
and applied `Greybird-dark`, independently verified in XFCE. That attempt took
41 seconds and nine calls. These observations do not establish that restart
caused the improvement: the agent chose a different interaction method.

Across six targeted tasks, four passed and two failed, with 96 MCP calls.
Theme application succeeded in one of three attempts. The new release is
installed correctly but does not yet make this workflow reliable for agents.

## Other live results

The fenced exact-text task passed in 175 seconds and 46 MCP calls. Independent
filesystem readback confirmed `Résumé — 東京 — café ☕.` including the final
period, with no newline. The prior ambiguity is resolved without a Luda change.

The select-only task passed in 27 seconds and five calls: the file was already
highlighted, so the agent observed it and left it unopened. Window inventory
confirmed no editor reopened; a desktop screenshot confirmed the highlighted
file. This tests restraint on an existing selection, not selecting an initially
unselected row. A direct AT-SPI assertion could not find a named selected node;
its failure halted the planned restart. The second theme attempt consequently
used a fresh agent on the same desktop; a third attempt followed an explicitly
verified stop/start. The harness failure is retained as test evidence.

The missing-file task passed in 75 seconds and 17 calls: it reported absence,
left the file manager at `/workspace`, and created no file.

## Scope and automated checks

39 Python installer/recipe/service tests, seven Rust desktop tests, and 18
frontend desktop tests passed. Frontend typecheck, lint, and the debug app build
passed. Exact built bundle:
`app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`.

This is a live in-VM GUI test of the upgraded setup, not a repeat native-viewer
UI test or proof of every agent client. The user's installed app and existing
VMs were left untouched. The punctuation regression now fences the required
text and explicitly requires the final period. The previous run's punctuation
result is classified as an ambiguous test, not a proven Luda defect.

Raw evidence is retained privately under the ignored directory
`app/SiloUI/src-tauri/target/verification/luda-032/`.

## Cleanup and limits

The temporary guest credential copy was removed and verified absent before
VM deletion. The test VM and isolated runtime/disk directory were removed.
Harnesses and private logs were retained with local evidence; a credential-value
scan found no credentials in the evidence. Existing user VMs were untouched.

Four recoverable tool errors occurred: three BUSY responses and one rejected
extra screenshot argument. There were no stale-target responses. This bounded
run covers one ARM64 upgraded desktop, not a fresh-install matrix or all clients.
