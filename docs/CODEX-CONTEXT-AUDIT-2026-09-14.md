# Codex skills and context audit

Reviewed 2026-09-14. Recommendation: narrow Smithers activation and global behavioral rules before shortening the Silo runbook.

## Basis and scope

OpenAI recommends precise skill triggers, minimal root routers with optional references, task-specific repository guidance, and explicit completion boundaries. It warns that excessive descriptions get shortened and that rigid procedures and approval language can impede Astra. These are design recommendations, not measurements of this installation. [Rethinking skills and prompts for GPT-6 Astra, September 11, 2026](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

Inspected the active session instructions and skill catalog, global and repository AGENTS.md, the Smithers root's routing and operating policies, the local command-skill inventory, show-me, openai-docs, and selected bundled skill metadata and sizes. This is not a line-by-line audit of every bundled skill or a runtime benchmark. Smithers text was inspected as review material, not invoked to operate a workflow.

Counts below use whitespace-separated words, not model tokens. Root bodies are loaded on use; catalog descriptions are already present in this session. Do not add every installed skill body's size and call that baseline context.

| Local source | Measured size |
| --- | --- |
| `~/.codex/AGENTS.md` | 36 lines, 337 words |
| Repository `AGENTS.md` | 77 lines, 735 words |
| `~/.codex/skills/smithers/SKILL.md` | 1,200 lines, 10,613 words |
| `~/.agents/skills/smithers-*/SKILL.md` | 79 command skills; 1,761 words in their description fields |
| `~/.agents/skills/show-me/SKILL.md` | 127 lines, 460 words |

## Findings, in priority order

### 1. Smithers activates on ordinary work and imposes unrelated policy

The root description includes ordinary implementation/review requests and claims authority over report format even without workflows. Lines 56–97 route nearly every nontrivial single-goal task into a oneshot. Lines 185 onward prohibit direct implementation for broadly described work. Lines 294–319 require HTML for written deliverables. None of these boundaries depends on the user actually needing durable execution.

Consequence: routine coding or analysis can acquire an extra agent, workflow monitoring, and an HTML artifact. The description visible in this session is shortened before its full routing policy appears.

Proposed trigger: “Operate Smithers runs and author durable workflows. Use when the user requests Smithers or a workflow that must survive interruption.”

Make the root a short router to operating, authoring, recovery, and UI references. Retain the nested-run guard, public Gateway boundary, persisted run identity, and relevant workflow testing requirements. Remove unrelated report-format policy and fixed model rankings from universal routing. Preserve an explicitly requested model; otherwise use configured defaults.

### 2. The command catalog duplicates CLI discovery

There are 79 separately advertised Smithers command skills, including aliases and internal protocol commands. Sampled wrappers repeat command help. Their descriptions consume baseline context even for Silo work with no Smithers involvement.

Expose the root plus only workflows with genuinely distinct intent. Discover individual flags with command help after selecting Smithers. If these files are generated, fix the generator or installer upstream; deleting generated copies alone will not last. The generator's location was not established in this review.

### 3. Global challenge instructions are applied outside product discovery

Global lines 7–16 require repeated challenges, a commercial demand test, and categorical language regardless of task. Line 22 requests a question in every dialogue response. This can turn a bounded repair into a product interview and penalize honest uncertainty.

Retain evidence-based disagreement and direct prose. Scope commercial demand questions to product and business decisions. Replace the twice-per-person ritual with questions only when the answer changes the decision. Replace “Never hedge” with “Distinguish observed facts, inferences, and unknowns.” Keep the user's preference for questions in chat without requiring a question every time.

The named gstack challenge mode is not an available skill in the active catalog. State its useful behaviors directly instead of implying that a particular installed workflow exists. The empty “Fix upstream” heading also needs an actionable sentence.

### 4. Several rules create predictable stopping or scope problems

Smithers lines 58–66 require a questions-only stop for ambiguity; lines 247–253 ask again before workflow creation; lines 738–779 escalate uncertainty broadly. These conflict with the session's instruction to continue authorized work and ask only for missing decisions. Lines 255 onward require visualization offers and UI suggestions on every run, encouraging extra scope.

Use one boundary: continue reversible work within the requested scope; ask when a missing decision blocks progress or the next action exceeds authorization. Define completion once. Show a run view when useful, without requiring repeated offers or a new custom UI.

The global mandates for TDD, two designs, two adapters, separate reviews, aggressive parallelism, and all test layers also need task boundaries. Keep regression tests for changed behavior and architecture guidance for consequential design; do not apply the whole process to documentation or a typo.

### 5. OpenAI Docs has a useful router but an excessive ordering contract

`~/.codex/skills/.system/openai-docs/SKILL.md:12` mandates search before reading local context even when the user supplied the exact official URL. This also conflicts with the session's local-code-first instruction for OpenAI usage questions. The skill repeats source-order exceptions across several paragraphs.

Retain current official citations and the reference router. Allow direct retrieval of a supplied source and local inspection for local configuration questions. Shorten its catalog description to the actual domain rather than enumerating nearly every product feature. This is a bundled/system skill; submit an upstream correction rather than treating a cache edit as durable configuration.

### 6. Visual triggers overlap; bundled body length alone proves little

show-me and visualize both trigger on visual explanation. Prefer one clear dispatch boundary: show-me for explicitly requested concise code diagrams; visualize for interactive exploration. The Sites description already excludes unrelated web-project development, a useful boundary worth retaining.

Some artifact roots are large, including the spreadsheet and live Excel skills. Their tools and rendering requirements may justify that detail. Only metadata and size were checked here; no body-level removal recommendation follows from size alone. Prioritize demonstrated overactivation over indiscriminate deletion.

## Keep in the Silo context

Keep exact commands and paths, synthetic native-test configuration limits, bundled runtime preservation, changeset requirements, credential handling, process ownership checks, and the distinction between fixture checks and live VM evidence. These encode local facts and real side effects. In particular, Quit stopping local VMs is not generic safety boilerplate.

The repository already says to run checks appropriate to the change. Do not remove useful commands because the model usually remembers to test. Build recipes can move behind a conditional release-guide link if maintained in both places, but this is lower priority than Smithers routing.

## Validation and next action

No skill or active instruction was changed. This file records the review; no application test was required. Two pre-existing modified research documents were left untouched.

Test proposed instructions against the current baseline on five bounded cases: a typo, a reproducible UI fix, an ambiguous product claim, an explicit durable Smithers workflow, and a packaged-app inspection. Compare task correctness, completion, unnecessary questions, skill reads, tool calls, elapsed time, and token usage where available. Require no new safety or completion failures before accepting efficiency improvements. There is no before/after performance evidence yet.

Next action: narrow the Smithers root trigger and command-skill exposure, then run those comparison cases before changing further instructions.
