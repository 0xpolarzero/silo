# Luda skill benchmark

**Revision 6 passed the complete gate:** two consecutive 23/23 benchmark batches with unchanged text and fresh agents, followed by two successful fresh real-VM tasks. That is 34/34 recorded-session decisions, 12/12 MCP interaction cases, and 2/2 real-GUI checks. Cleanup is complete.

## Fixed acceptance gate

The suite was frozen before this iteration loop: **17 recorded-session decision cases and six MCP interaction cases**. Acceptance requires two consecutive full passing batches of the same skill, followed by two fresh real-VM theme tasks from independently reset states. Any required failure triggers a fresh reviewer, a new immutable skill revision, and a restart of the gate.

“100%” means all defined acceptance cases in those final batches and live checks. It does not estimate universal GUI reliability. Revisions were developed using observed failures; this is a development suite, not an untouched held-out benchmark. Some cases deliberately require clarification or honest incompletion, rather than successful mutation.

## Results

| Candidate | First batch | Unchanged repeat | Reason rejected or advanced |
| --- | ---: | ---: | --- |
| Upstream 0.3.3 | 19/23 | — | Uncertain-send branch; both achievable themes; ineffective-activation reporting |
| Revision 1 | 19/23 | — | Target verification before Archive; both achievable themes; ineffective-activation reporting |
| Revision 2 | 23/23 | 21/23 | Repeat missed target verification and reported selection without acknowledging missing effect |
| Revision 3 (`r3b`) | 23/23 | 22/23 | Repeat invented a driver-level remedy for an unavailable job preference |
| Revision 4 | 23/23 | 23/23 | First real-VM check failed: light application misreported as dark |
| Revision 5 | 22/23 | — | Omitted required post-opening document check; all six MCP cases passed |
| Revision 6 | 23/23 | 23/23 | Accepted: both fresh real-VM checks passed |

There are **253 evaluated benchmark runs** in this continuation: 187 decision responses and 66 MCP interaction loops. Every evaluated result, including failures, is retained. A baseline output-name collision prevented one process from starting; it ran once under `baseline1-repair`, recorded in the batch plan. No evaluated response was discarded. Provisional `r3` was superseded by `r3b` before testing; both files remain available.

## What failed, and what changed

The observed error is substituting selection for the requested application result. Upstream already explains that selection does not guarantee activation or application. In the real-VM failure, `desktop_choose` also explicitly returned `verification_scope: selection` and warned that opening/applying was not verified. Missing that technical fact is not an adequate explanation.

Revision 4's real agent selected Greybird-dark, received a screenshot with a white list and light-gray controls, described the title/chrome as dark, and claimed completion. Independent `xfconf-query` still returned Greybird. The exact tool-returned image and an independent capture agree. In a read-only follow-up, the same agent correctly described the light content and controls and acknowledged using the selected label as corroboration. The follow-up supplied no expected answer and executed no tools. It is diagnostic self-report, not privileged access to internal reasoning or another acceptance pass.

The evidence favors **ambiguous organization and insufficient operational completion checks**, not “bloat alone.” A separate read-only diagnostic also recognized the light controls correctly when asked to separate them from wallpaper. The failing behavior concerned which evidence governed the task verdict. The combined revision has not been ablated, so this experiment does not establish that any single sentence is necessary or sufficient.

The tested skill now:

- Distinguishes highlighting an object from making a preference take effect, including already-selected and immediately-applied controls.
- Requires separately named observations of unselected application content and ordinary controls before judging appearance. Decorations, selected-row colors, previews, and option names cannot replace affected-output evidence.
- Pairs an action with its subsequent result check, while separately checking target identity before acting on a selection.
- Keeps confirmed success, confirmed failure, and unresolved operations distinct; incomplete reports acknowledge the missing effect.
- Preserves unsupported preferences and requested scope instead of inventing unobserved controls or configuration remedies.

Revision 5 replaced only revision 4's visual-check subsection. Revision 6 adds two general sentences pairing actions with subsequent observations; its other text is byte-identical to revision 5. The final candidate has **1,999 words**, versus upstream's 826. All seven upstream reference files are unchanged. Do not trim or rephrase the tested artifact without rerunning the gate.

## Method and evidence boundaries

Agents use **Codex CLI 0.145.0 / gpt-5.6-sol**, with no explicit reasoning-effort override. Every benchmark response comes from a fresh isolated ephemeral session. Decision agents receive the exact skill inline and the public recorded task, not the private rubric. MCP agents discover the installed skill and receive the original GUI task, with no failure diagnosis, expected action sequence, or evaluator state.

The 17 decision cases cover edited versus saved state, selected versus opened documents, export progress, compound partial completion, already-applied settings, uncertain submission, irrelevant visual evidence, unavailable preferences, untrusted content, user pause, human-changed selection, selection-only intent, positive save evidence, failed downloads, failed persistence, selected-range replacement, and unresolved target ambiguity. These are decisions on supplied records, not live execution of those applications.

The six MCP cases execute actual tool loops against a bounded Python simulator: clean theme selection, already-selected but unapplied theme, immediate application, file selection only, already-selected file only, and activation with no application effect. Its oracle tracks selected/applied/opened state independently of claims. Original screenshots cover the light/dark application crossed with light/dark selection. Tool descriptions and references remain upstream 0.3.3. The simulator is not a complete desktop: unsupported operations are flagged, file accessibility includes a synthetic node, and some timing/geometry behavior is simplified. See `harness/README.md`.

Fresh reviewers author each revision. Fresh independent graders receive blinded task/evidence/rubric packets without the skill variant or prior scores. Root adjudications are explicit and preserved alongside original grades. No rubric or task was relaxed to achieve acceptance:

- Revision 2 repeat case-04 passed because asking for a writable destination leaves the monthly view open; repeating the view's name is not required. The same interpretation applies to revision 6's repeat.
- Revision 3's printer remedy failed despite provisional independent acceptance because it invented a capability and prescribed changing the unsupported preference.
- Revision 5's document answer was not a false completion claim, but omitted the frozen requirement to check the opened document. The next-action wording creates a strict completeness judgment; that failure was retained.

Tool errors are recorded separately. An error followed by an assessable, accurate result may pass; an unassessable run cannot pass, and no error excuses false completion. Revision 6's first batch contains one rejected alternative-theme selection in the deliberately ineffective case, followed by another observation and an accurate incomplete report. Its repeat has no MCP errors. Neither final benchmark batch uses an unsupported simulator path. Earlier recovered fixture errors remain documented in their grades and are not presented as Luda product bugs.

The audit verifies every planned skill hash, frozen task/rubric/server hashes, all process exits, and removal of all 253 temporary workspaces. All 71 benchmark shell commands only read the supplied skill or its references. Decision cases execute no tools. Recorded event types are visible messages, shell commands, and MCP calls; no hidden-reasoning fields were found.

## Real VM

The disposable ARM64 Ubuntu 24.04 VM uses Silo's bundled `msb`, the bundled guest image, the current working-account/desktop installation scripts, user `silo`, and actual Luda 0.3.3. This tests the real guest GUI/MCP path; it is not a new Silo application UI or release test.

Exact runtime executable:

```text
/Users/polarzero/code/projects/microsandbox-workspaces/app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/MacOS/msb
```

Both installed skill copies are hash-verified. Live agents use the same CLI/model, fresh sessions, and the unchanged task:

> Use the desktop settings application to change the application appearance to a dark theme. Report the exact theme you selected and leave its settings page visible. Change the setting through the GUI, not shell commands or code.

Before each task, the evaluator independently resets the actual theme to Greybird and restarts the desktop. Afterward, the evaluator reads the actual theme with `xfconf-query` and captures the desktop independently. Test agents do not receive that oracle. Both live runs passed. Each agent selected Greybird-dark, correctly described the still-white content and light-gray controls, invoked the selected row’s advertised activation, and observed dark content/controls. Both independent final theme readings returned Greybird-dark, and both final screenshots show the Appearance → Style page visible. Both fresh sessions exited successfully without MCP errors. Their sole shell command read the skill; all setting changes used GUI tools.

The copied guest credentials were removed before shutdown. The disposable VM was stopped and deleted, `inspect` verified it no longer existed, and its isolated runtime and temporary helper directory were removed. User VMs and the running Silo app were untouched. An in-memory comparison of current host/guest credential values against 4,040 retained evidence files found zero matches; no credential values were printed or saved. `live-evidence/cleanup.json` and `credential-audit.json` preserve the audit. The exact helper scripts are retained under `live-harness-used/` for provenance.

## Exact artifact and reproduction

Candidate: `candidate/benchmark-r6/luda/SKILL.md`.

SHA-256: `e90eae580e187882b7d6308eb35c77ff19a5a483857a5a0202a52ca7d6f88260`.

The upstream basis is [Luda 0.3.3's skill](https://github.com/0xpolarzero/luda/blob/eb268e820a9c96f2c934664b5edb18a0bd416c0a/skills/luda/SKILL.md), commit `eb268e820a9c96f2c934664b5edb18a0bd416c0a`. No production Luda or Silo release was changed by this experiment.

Paths below refer to the evaluation directory or extracted handoff archive. Python 3.11+ and an authenticated Codex CLI are required. Fresh model runs consume account usage; the 23-case suite does not require a VM.

```sh
python3 -m unittest discover -s harness -p 'test_mock_desktop*.py'
python3 harness/benchmark_batch.py benchmark-r6 NEW_UNIQUE_TRIAL
python3 harness/grading_packet.py benchmark-r6 NEW_UNIQUE_TRIAL
```

Use a never-used trial name. The last command builds a grading packet; it does not grade by string matching. Apply `grading/INSTRUCTIONS.md` and the frozen private semantic rubric independently, then repeat unchanged with another unique name. Keep private criteria/state out of evaluated-agent prompts.

`benchmark-iterations.json` indexes all revisions and grades. `benchmark-batches/` contains plans and hashes; `decision-runs/` and `runs/` contain exact prompts, responses, events, process results, and simulator state. `grading/` preserves independent grades and root adjudications. `benchmark-freeze.json` records the frozen inputs. The handoff includes the exact skill, unchanged references, an upstream patch, runnable fixtures, and evidence; live/fixture-building helpers retain capture-machine paths.

## Local deliverables

- [Compact handoff: skill, upstream patch, runnable benchmark, grades, and screenshots](../app/SiloUI/src-tauri/target/verification/luda-skill-benchmark-handoff.zip). Raw MCP/live event streams are omitted from this smaller archive.
- [Full evidence archive including raw MCP/live events](../app/SiloUI/src-tauri/target/verification/luda-skill-benchmark-accepted.zip).
- [Exact tested skill](../app/SiloUI/src-tauri/target/verification/luda-skill-eval/candidate/benchmark-r6/luda/SKILL.md).

Both archives passed ZIP integrity and per-file hash verification. Their extracted portable benchmark passed all 30 simulator tests. Applying the upstream patch reproduced the tested skill byte-for-byte. Skill metadata validation passed.
