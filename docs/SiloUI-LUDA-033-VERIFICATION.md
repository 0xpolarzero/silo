# Luda 0.3.3 verification

Tested on 2026-09-21 with a disposable ARM64 Ubuntu 24.04 v3 VM, Silo's bundled
runtime and guest recipes, and fresh Codex CLI 0.145.0 agents inside the VM.

## Release and upgrade

Pinned Luda 0.3.3 at commit `eb268e820a9c96f2c934664b5edb18a0bd416c0a`, source
archive SHA-256 `d937e6dc2754cb934b6ccdf540f23289326ab3e5a8b0bbd802e4c63bbf05dec2`.
The VM first installed the committed 0.3.2 recipe, then upgraded through the
new `setup-tools` recipe. Version 0.3.3 was reported ready. All seven client
registration files, working-account ownership, and updated installed skill
content were independently verified.

The release adds `verification_scope="selection"` and conditional `next_step`
guidance to successful selection results, including unchanged selections.
It preserves selection behavior and does not automatically activate rows.
[Release notes](https://github.com/0xpolarzero/luda/releases/tag/v0.3.3).

## Method

Three fresh agents receive the unchanged request to change application appearance
to a dark theme. Before each attempt, the test sets the baseline to Greybird,
stops and starts the desktop, verifies the baseline and running `xfsettingsd`,
then launches the agent without Luda-specific hints. Afterward, the supervisor
reads `/Net/ThemeName` independently and retains a desktop screenshot. These are
three controlled observations, not an estimated success rate or guarantee.

A separate file trial starts with a new two-file folder, no file selected, and
no editor open. The user prompt requests selecting `target.txt` without opening
it. Before/after desktop captures and window inventory verify the outcome.

## Automated verification and scope

39 Python installer/recipe/service tests, seven Rust desktop tests, and 18
frontend desktop tests passed. Typecheck, lint, and the debug app build passed.
Exact built bundle: `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app`.
No native viewer interaction or all-client live matrix is claimed by these
in-VM tests. Existing user VMs and the installed Silo app are left untouched.

Private evidence is retained under the ignored directory
`app/SiloUI/src-tauri/target/verification/luda-033/`.

## Live results

All three theme attempts failed the requested application effect: the independent
`xfconf-query -c xsettings -p /Net/ThemeName` result remained `Greybird`.
Each agent read the installed Luda skill, discovered and launched Appearance,
called `desktop_choose` on Greybird-dark, received the new selection-only guidance,
and inspected the selected row. None invoked activation or clicked the row.
The first also observed a screenshot; the retained desktop capture shows the
Greybird-dark row highlighted while the application remains light.

| Fresh agent | MCP calls | Tool errors | Actual theme | Final response |
| --- | ---: | ---: | --- | --- |
| theme-1 | 9 | 0 | Greybird | “Selected the exact application theme **Greybird-dark**.” |
| theme-2 | 9 | 0 | Greybird | “Selected the **Greybird-dark** application theme.” |
| theme-3 | 8 | 0 | Greybird | “Selected the **Greybird-dark** application theme.” |

Those statements describe the highlighted selection but leave the requested
change unfinished without disclosing that the theme was not applied. This is
an agent outcome-verification failure, not evidence that `desktop_choose` failed
its documented selection contract. Version 0.3.3 delivers its new guidance
correctly, but that guidance did not resolve these three observations.
The remaining `effect="verified"` field coexists with
`verification_scope="selection"`; whether that wording contributes to the
mistake is an untested hypothesis, not a demonstrated cause.

The first harness readiness check raced `xfsettingsd` startup before any agent
ran. The failure was preserved, and the harness added a bounded daemon wait.
All three reported trials started with the daemon confirmed running.

Both file-selection trials passed. Starting unselected, the first agent used
8 MCP calls, including two single-click attempts and screenshot verification;
starting already selected, the second used 5 calls and left the state unchanged.
Both left `target.txt` highlighted without opening an editor, verified by
independent captures and window inventory. Neither used `desktop_choose`, so
these trials do not exercise its already-selected result branch.

Across all five fresh agents: 39 MCP calls, no reported tool errors, and no shell
commands to manipulate the GUI. Agents used shell only to read the installed
skill. Tool success alone did not establish task success.

## Cleanup

Removed the copied guest Codex credentials before stopping and deleting the
disposable VM. Verified the VM was not found, removed its isolated runtime and
disks, and removed downloaded release sources. Retained private test evidence
and harnesses in the ignored verification directory; scanned them against host
credential values and found no matches. Existing user VMs and app were untouched.

## Follow-up diagnosis

[Preserved-agent interviews and controlled experiments](SiloUI-LUDA-033-DIAGNOSIS.md)
reproduced the failure and distinguished unsupported click-equivalence assumptions
from incorrect visual evidence. The same agent successfully applied the theme
with activation after its missing effect check was challenged.
