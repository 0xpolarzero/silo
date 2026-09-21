# Luda skill evaluation: selection is not application

## Decision

This document preserves the earlier incomplete investigation. The subsequent [benchmark iteration report](SiloUI-LUDA-SKILL-BENCHMARK.md) records the accepted revision, repeated results, live confirmation, and cleanup.

The strongest tested improvement replaces the tool-first procedure with a short user-goal-first procedure and an explicit completion test established before acting. Preserve the distinction between selection, activation, and application effect. Do not fix this by making `desktop_choose` activate automatically or appending another warning to the existing skill.

This is an improvement candidate, **not a complete fix**: a final deliberately broken case still produced a selected-only response without acknowledging the missing application effect. Do not release it as a solved regression. Final validation and cleanup results are recorded below. The candidate is experimental; Silo's pinned upstream Luda skill has not been changed.

## What is wrong?

The observed failure is **goal substitution**: “change the application theme” becomes “highlight the requested theme and report its name.” Selection is then mistaken for completion. Some agents obtain screenshots but attribute unrelated dark wallpaper/panels to the requested application change. The missing behavior is checking the affected application's state against the original goal.

The upstream skill already says that selection is not activation, that some controls apply immediately, and that the requested effect must be checked. Therefore the literal fact is not missing. The operational guidance is insufficiently enforced by the overall workflow: a tool-first instruction to choose options provides an easy intermediate stopping point, while the completion rule appears later among many contracts. This is a supported design hypothesis, not access to a model's internal reasoning.

Of the user's three categories, the evidence favors **confusing organization plus insufficient operational completion criteria**. It does not support “bloat alone.” Removing roughly half the words without changing retained rules failed all three controlled trials. Rephrasing the selection paragraph alone also failed repeatedly. A combined shorter, goal-oriented workflow worked better; word count and organization interact, so this experiment does not assign exclusive causal percentages to them.

See [the prior interviews and source-level mechanism](SiloUI-LUDA-033-DIAGNOSIS.md). XFCE applies this theme through row activation, while AT-SPI selection only highlights. A physical click can do both. Selection-only tasks must still remain selection-only.

## Lightweight reproduction

A local Python stdlib MCP server replays captured desktop states. Fresh Codex CLI agents receive the actual skill, unchanged upstream reference files, original tool descriptions, and the original user task. They are not told the intended action sequence, failure hypothesis, private state, or expected answer.

Original task:

> Use the desktop settings application to change the application appearance to a dark theme. Report the exact theme you selected and leave its settings page visible. Change the setting through the GUI, not shell commands or code.

The harness independently tracks selected row and applied theme. `desktop_choose` returns selection-only success. An advertised activation or grounded click applies the theme. Screenshots and inspect results reflect those separate states. Four original screenshots cover light/dark application crossed with light/dark selection. Actual XFCE state was checked independently when capturing them.

The evaluator separately checks actual effect, whether appropriate evidence was available, final claim accuracy, forbidden actions, and unsupported simulator paths. Merely taking a screenshot is not scored as correct interpretation. A quiz-only probe failed to reproduce the task context; it is excluded. Early development runs affected by simulator/approval bugs are excluded from controlled results.

Model: `gpt-5.6-sol`, Codex CLI `0.145.0`, no explicit effort override, fresh ephemeral sessions. Host shell is read-only; only this local simulated MCP is auto-approved. Same task and tool text across variants. Original skill is [pinned Luda 0.3.3](https://github.com/0xpolarzero/luda/blob/eb268e820a9c96f2c934664b5edb18a0bd416c0a/skills/luda/SKILL.md), commit `eb268e820a9c96f2c934664b5edb18a0bd416c0a`.

## Controlled comparisons

Three fresh clean-start trials per frozen variant, interleaved. None of these 21 runs encountered unsupported simulator paths or tool errors. Counts measure actual applied theme, with post-effect screenshot available, not just selected-state reports.

| Change | Words | Applied theme |
| --- | ---: | ---: |
| Exact upstream skill | 826 | 1/3 |
| Remove unrelated paragraphs; retained rules verbatim | 413 | 0/3 |
| Rewrite selection paragraph into task branches | 844 | 1/3 |
| Add explicit affected-surface/before-after criterion | 906 | 2/3 |
| Replace operation instruction with goal-to-operation mapping | 866 | 0/3 |
| Add a final evidence question | 870 | 2/3 |
| Rewrite as a compact goal/effect/evidence workflow | 334 | 3/3 |

These are small diagnostic samples, not success-rate estimates. The changes were tested adaptively; later cases became development evidence once inspected. Do not describe the final candidate as validated against a statistically independent hidden benchmark.

The added final evidence question also failed a real-VM trial: the actual theme remained Greybird while the agent claimed dark desktop decoration proved success. Rejected.

The 334-word rewrite passed two real-VM trials and selection-only/immediate-application contrasts, but falsely claimed completion when activation deliberately had no effect. Rejected as sufficient. Longer proof paragraphs, in both full and compact skills, also failed. The final candidate was not selected merely because it took extra screenshots.

## Precise candidate change

The 470-word `contract-first` candidate preserves upstream name/description and reference files, but reorganizes the entry skill:

1. Before acting, state the object, requested final state, and observation that would prove success. The main action controls the test; reporting a name is secondary.
2. Map the user's goal to the operation: highlight/select uses choose; apply/open/use requires its advertised action or grounded click if the effect is absent; edit/readback does not establish saving.
3. Distinguish operation-level verification from task completion. Selection is not a physical click and does not prove activation.
4. Check the affected application surface. Keep the original completion test through the task. If it is unmet, explicitly report the remaining unverified effect rather than silently reporting an intermediate selection.
5. Preserve selection-only stopping, no repeated already-observed effects, and inspection before uncertain retries.

The first sentence alone is insufficient: adding the same precommitment rule to the full stock skill applied only 2/4 achievable cases and did not honestly report either broken case. Some such agents explicitly defined their initial test as a selected theme name. The compact candidate instead defined the test as dark rendering of Settings itself and carried that test into verification. This trace evidence supports reorganizing the workflow rather than another isolated reminder.

The candidate includes an appearance example learned from this incident. Its success is therefore evidence about this regression and the tested contrasts, not arbitrary GUI tasks. It also abbreviates several upstream capability/recovery contracts. Before adopting it as the general production skill, the upstream maintainer must preserve or relocate those contracts and test text, save/submission, stale targets, pause, missing tools, and incomplete accessibility. Do not silently ship this experimental entry point as a complete coverage-equivalent replacement.

## Final validation

The frozen exact `contract-first` candidate passed four achievable development cases (two clean-start and two already-selected/light-application seams). Its two initial deliberately ineffective cases honestly reported unverified appearance, but encountered unsupported simulator paths. Those results motivated validation, not a reliability claim.

Final validation used the Close/reopen-capable simulator without changing the skill:

| Case | Result |
| --- | --- |
| Clean-start theme application | 2/2 applied and observed dark application; zero tool errors |
| Select file without opening | 2/2 selected, never opened; zero tool errors |
| Already-selected file without opening | 2/2 preserved selection without opening; zero tool errors |
| Setting applies immediately on selection | 2/2 applied and observed, no redundant activation; zero tool errors |
| Activation deliberately has no effect | 1/2 explicitly unverified; 1/2 misleading selected-only final response |
| Actual disposable VM, original uncoached task, reset light theme | 2/2 applied Greybird-dark and visibly dark Appearance window |

Both broken validation cases encountered the same unimplemented `window_absent` wait after a successful close. Subsequent actions and observations completed, so the final reporting failure is visible, but this is not a clean recovery test. A final narrowly expanded simulator implements that wait and is tested separately below.

The actual VM runs used Silo's bundled debug runtime at `app/SiloUI/src-tauri/target/debug/bundle/macos/Silo.app/Contents/MacOS/msb`, Ubuntu 24.04 ARM64, the current single-user desktop recipe, and Luda 0.3.3. They were guest-agent tests, not another packaged Silo UI test. Each fresh agent read the exact candidate. Their shell calls only read the skill/references; GUI tools performed the changes. Both selected, observed a still-light application, invoked activation, then observed a dark application. Independent supervisor `xfconf-query` returned `Greybird-dark`, and both retained screenshots visibly show dark dialog controls. These checks establish the requested effect, not just the agent's claim.

Thirty deterministic simulator tests pass after adding close/reopen and window-absence waiting. The candidate passes the standard skill metadata validator (PyYAML supplied in an isolated `uv` runtime). Metadata validation says nothing about behavioral reliability.

The final wait-capable rerun still failed the reporting gate in both trials: each ended with only “selected Greybird-dark.” One trial used unsupported keyboard/click paths, but the other completed with **zero tool errors and zero unsupported transitions**. Its light application state and selected-only final response establish a clean negative regression. This rules out the earlier missing wait implementation as a sufficient explanation. The candidate improves achievable work but does not consistently preserve incomplete status in its final report.

A final narrowly targeted reporting variant, `explicit-status` (543 words), adds a mandatory Status / Result / Evidence final response to the unchanged candidate. Its normal application, selection-only, and immediate-application cases passed (one each). It still failed a deliberately ineffective case with **zero errors and zero unsupported transitions**:

> **Status:** Complete
> **Result:** Selected the **Greybird-dark** application theme.
> **Evidence:** The Appearance → Style page remains visible with **Greybird-dark** selected after switching from Greybird.

The hidden actual theme remained Greybird. The agent had received the light-window screenshot. This is an explicit false-completion claim, not merely an ambiguous final omission. Its initial completion test had already mixed “theme active” with “controls visibly confirm the exact selected theme,” illustrating the goal/evidence substitution. A structured final-answer template alone is therefore also rejected as a sufficient fix. The other negative trial correctly reported Incomplete and described the still-light application and reverted selection after reopening. Both trials had zero tool errors and zero unsupported transitions. Thus the structured-status variant passed only 1/2 negative reporting tests, despite passing all three achievable contrast cases. No tested variant passed every required behavior.

## Upstream change and acceptance gate

Use `contract-first` as the next development baseline, not as an already-proven release fix. Do not adopt `explicit-status` merely because its answers are easier to parse; its clean false-completion case disproves sufficiency. Keep the skill entry point organized around **requested state → operation → observed effect → honest report**. Move extended capability details into linked references while preserving their contracts; do not add another large paragraph to the current entry point. The tested candidate and patch are included in the portable artifact.

Keep these regressions together:

- Selection changes while application state does not: do not finish; perform the appropriate advertised action or grounded input and check the application.
- Selection itself already applies: verify and stop; do not activate again.
- User asks only to select: stop at selection; do not open or apply.
- Action dispatch succeeds but the intended effect never occurs: explicitly report the effect unverified. Reporting only the intermediate selected name fails.
- The wrong surface already resembles the desired result: unrelated wallpaper/panel is not application evidence.

Before claiming the broader misconception is fixed, add a genuinely different effect (for example an edited-but-unsaved document with an independent persisted-content oracle). Keep its task prompt uncoached and do not train the candidate against every evaluation example. Text edit/readback versus save, upload dispatch versus completion, and selected printer versus submitted print job have the same logical boundary, but were **not behaviorally validated here**.

Do not change generic choose into an implicit activation. Also do not claim a deterministic guarantee from free-form instructions: the tested agent sometimes violates an explicit, correct contract. A hard completion guarantee would require application-specific observable postconditions enforced outside the agent's final prose. That is an architectural option, not an implemented or validated Luda feature. The immediate upstream work is to retain the failing negative regression and improve the candidate until it passes without task-prompt coaching or weaker scoring.

## Reproduction and evidence

Local evidence and exact candidate are under the ignored directory `app/SiloUI/src-tauri/target/verification/luda-skill-eval/`. `variants/` freezes every wording version; `runs/` retains per-run skill/server hashes, prompt, MCP transcript, private oracle, final response, and process result. `harness/README.md` documents the bounded simulator and its limitations. The machine-readable score reports available observation separately from interpretation; final claims require transcript review.

The primary simulator is preserved as `mock_desktop_primary.py` (SHA256 `c91cbfbadfc1db5a8c72c483ac10257d80e87919e485a31f0f61db558d70a5ac`). A later version adds legitimate close/reopen transitions and an actual empty-desktop screenshot; its hash is `c742839572b1cf980d46d03f9ad9ed1fe75f788c6125ecde3c63f3ebbe217698`. All variants within a comparison use the same server. The final wait-capable simulator is preserved as `mock_desktop_wait.py`, SHA256 `588690bfe2b42272b8f9db5ddcc78c3242b8d94baa27f6418fcf01240a73f421`. Thirty fixture/protocol tests cover the important transitions.

The simulator is intentionally bounded. Tool declarations are AST-derived, not byte-identical FastMCP metadata. File selection uses a synthetic accessible file node because the captured Thunar tree did not expose one. Only relevant application transitions are implemented. Unsupported transitions are flagged and reviewed, not counted as product failures or silently treated as passes. An already-opened forbidden file remains a failure even if a later unsupported screenshot occurs.

## Cleanup

Removed the copied guest Codex credential before stopping and deleting `luda-skill-fixtures`. An independent inspect returned `sandbox not found`; the exact isolated runtime and disk directory `/tmp/silo-luda-agents-ddg3a027` was removed. User VMs and the running Silo app were untouched. Temporary agent workspaces were removed by the runner. Retained evidence is ignored build output. A scan of retained files against host credential values found zero matches; its result is recorded in the portable package.
