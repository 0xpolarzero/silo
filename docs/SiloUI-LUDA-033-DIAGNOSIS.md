# Luda 0.3.3 selection-completion diagnosis

## Question and method

Follow-up to [the 0.3.3 verification](SiloUI-LUDA-033-VERIFICATION.md): why did
agents stop at theme selection despite explicit selection-only guidance?

A new isolated ARM64 Ubuntu 24.04 VM uses Silo's bundled runtime and current
0.3.3 desktop/tools recipes. Guest Codex CLI 0.145.0 runs fresh persistent sessions
with the original GUI-only theme task. Session metadata reports `gpt-5.6-sol`
with no explicit reasoning-effort override. No tool sequence is supplied.

Immediately after the task, the supervisor records `/Net/ThemeName` and a
screenshot. It resumes the **same session**, first requesting a neutral evidence
audit without tools or disclosing the independent result, then discloses the
unchanged setting and requests a concise explanation. These retrospective
explanations are compared with recorded calls; they are not proof of a model's
internal cause. A corrective turn can test whether the available tools work.

Original prompt:

> Use the desktop settings application to change the application appearance to a dark theme. Report the exact theme you selected and leave its settings page visible. Change the setting through the GUI, not shell commands or code.

The initial audit asks for exact observations supporting the requested change,
fields or visible features relied on, and anything those observations do not
establish. The subsequent disclosure gives the independent Greybird result and
quotes the selection-only scope warning. Exact prompts, transcripts, and desktop
captures are retained under the ignored directory
`app/SiloUI/src-tauri/target/verification/luda-033-diagnosis/`.

## First preserved session

The original task reproduced the failure: the agent selected Greybird-dark,
inspected its selected state, and finished. The actual theme remained Greybird.

Before being told that result, the agent's audit listed `effect="verified"`,
`selected=true`, `changed=true`, and the row's selected/showing/visible states.
It then acknowledged that the tool explicitly did not prove application and
that it had not inspected rendered colors. Its audit concluded that the evidence
was insufficient to establish the appearance change.

After disclosure, it said:

> I stopped on the `selected: true` / `changed: true` cue. That directly conflicted with the explicit selection-only warning and was insufficient for a completion claim.

It identified `effect="verified"` alongside `changed=true` as confusing, while
acknowledging the same result accurately scoped verification to selection.
That attribution is a hypothesis from the agent's report. The trace proves the
scope error and omitted application check, not which wording caused it.

Asked to complete the original task and verify the application effect, without
being told an action sequence, the same agent invoked the advertised `activate`
action, observed dark controls, and completed. The independent setting became
Greybird-dark. The task is achievable with the installed semantic tools.

## GUI mechanism

The guest has XFCE settings `4.18.4-0ubuntu3` and GTK `3.24.41-4ubuntu1.3`.
Primary upstream sources explain the distinction:

- [XFCE Appearance setup](https://github.com/xfce-mirror/xfce4-settings/blob/xfce4-settings-4.18.4/dialogs/appearance-settings/main.c#L1156-L1159)
  enables activation on a single click and connects `row-activated` to the theme
  callback. The callback's name includes `selection_changed`, but its signal is
  row activation.
- [XFCE callback](https://github.com/xfce-mirror/xfce4-settings/blob/xfce4-settings-4.18.4/dialogs/appearance-settings/main.c#L171-L218)
  reads the selected row and writes `/Net/ThemeName`.
- [GTK accessibility selection](https://github.com/GNOME/gtk/blob/3.24.41/gtk/a11y/gtktreeviewaccessible.c#L728-L756)
  calls `gtk_tree_selection_select_path`; it does not activate the row.
- [GTK accessibility activation](https://github.com/GNOME/gtk/blob/3.24.41/gtk/a11y/gtktreeviewaccessible.c#L1218-L1235)
  calls `gtk_tree_view_row_activated`.

Thus a real single click can both select and apply, while accessibility selection
only highlights. The live corrective turn agrees with that mechanism. No
application-specific autoactivation should be added to generic selection: that
would break requests to select a file without opening it.

## Second preserved session

A second fresh stock session also selected the row and stopped; the independent
setting remained Greybird. Before disclosure, its audit said the newly selected
theme "normally applies immediately in Xfce," while admitting that it had not
checked rendered appearance. After disclosure, it acknowledged the scope error.
Asked to substantiate its specific immediate-application claim, it replied:

> It was a general UI assumption, not established by this session’s tool results or screenshots.

It also acknowledged that nothing established equivalence between
`desktop_choose` and a physical click. This is a concrete unsupported assumption
in its own audit, consistent with the omitted activation and outcome check in
the trace. It does not establish that every failing agent has the same cause.

The two failures support a more specific diagnosis than "the task is difficult":
these agents treated the state of a control as proof of the application's state,
under a familiar UI assumption, and failed to enforce the explicit scope of
verification. The second agent's audit demonstrates that assumption; the first
agent identified generic success fields as its stopping cue. The existing skill
and next-step warning were present and read, so their absence is ruled out.

## Narrow diagnostic intervention

In the disposable guest only, changed the successful choose feedback from
`effect="verified"` to `effect="selection_verified"`. All other fields, the skill,
selection behavior, and original user prompt stayed unchanged. A fresh session
received the modified label, still inspected only the selected row, and stopped.
The independent theme remained Greybird.

The label-only trial initially received `BUSY` from `desktop_doctor` and
`desktop_windows`, then proceeded through successful application discovery,
launch, inspection, selection, and re-inspection. The selection response did
contain the experimental label. Those two transient errors were absent from
both stock reproductions and the corrective turn; their cause was not diagnosed.

This one observation rules out "renaming the generic effect label is sufficient"
for this reproduction. It does not prove that the old label never contributes.
Restored the stock module before the next experiment. This experimental value is
not a proposed API contract or a production change.

## Generic evidence-rule experiment and visual misattribution

With the stock tool module restored, inserted a generic completion-evidence
section into the disposable guest skill. It required independent evidence of
the user-requested effect, warned against assuming accessibility selection runs
the same callback as a physical click, rejected re-inspection of selection as an
application completion check, and required a fresh screenshot when accessibility
only exposes selection. It preserved selection-only stopping behavior.

A fresh agent read the modified skill. It selected Greybird-dark and observed a
screenshot but still stopped; `/Net/ThemeName` remained Greybird. The screenshot
shows light-gray Appearance controls and a white theme list, surrounded by the
pre-existing dark wallpaper and panel.

In its neutral audit, this agent cited the highlighted row and "dark-styled
desktop chrome," then claimed the requested change was observably applied.
When given the unchanged setting and told to distinguish application controls
from the unchanged background, it answered:

> The dark wallpaper and panel do not distinguish an application-theme change from the pre-existing desktop background.

It explicitly withdrew the applied-theme claim. This demonstrates a bad visual
evidence attribution in the audit, not just failure to take a screenshot.
A fresh screenshot is not sufficient unless the agent checks the affected
application surface and the expected change. The generic added paragraph did
not solve this observation. It was restored afterward; no experimental tool or
skill modifications are included in Silo.

## Findings and limits

| Check | Observation |
| --- | --- |
| Stock fresh sessions, original task | 2 failures; both interviewed in their original sessions |
| Corrective turn in first session | Applied Greybird-dark with advertised `activate`; independent state and visible dark dialog confirmed |
| Effect-label-only change, fresh session | Failed despite receiving `selection_verified` |
| Generic completion-evidence rule, fresh session | Took screenshot but misattributed unchanged dark desktop decoration to application theme; failed |

The immediate application mechanism is established by source and the live
corrective control: selection highlights, activation applies. The two stock
traces establish that agents omitted activation and independent effect
verification despite receiving the correct guidance. One stock agent explicitly
acknowledged importing a general UI assumption. The screenshot-rule agent
explicitly cited the wrong visual surface, then withdrew its claim.

Neither the generic success label nor insufficient prose alone explains all
observations. Two proposed wording changes failed their small diagnostic tests.
Do not present another prose-only change as a proven fix. These are a few
controlled observations with the guest's default `gpt-5.6-sol`, not a success-rate
estimate or evidence about every model/client.

A useful upstream regression must evaluate the actual application effect and
false completion claims, not just whether the result contains warning text or
the agent performs an extra inspection. Its visual oracle must distinguish the
affected application from unrelated desktop decoration. Preserve a separate
selection-only regression to prevent accidental activation. The next candidate
needs fresh-agent testing against those acceptance criteria before release.

All interview turns used no tools, so the audits did not change the desktop.
Across the task and corrective turns there were 42 MCP calls and two reported
tool errors, both the transient `BUSY` responses noted above. The experiments
modified only the disposable guest; repository changes are documentation only.

## Cleanup

Restored experimental guest changes, removed copied Codex credentials, stopped
and deleted the disposable VM, verified its absence, and removed its isolated
runtime and disks. User VMs and the running app were untouched. Retained private
transcripts, prompts, screenshots, and harnesses in the ignored evidence path;
a scan against host credential values found no matches.
