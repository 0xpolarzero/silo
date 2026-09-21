# Jev for natural-language Silo commands

Researched 2026-09-18. Documentation review only; no API calls or application changes.

## Position

Evaluate Jev as a semantic selector for bounded Silo commands. Do not assume it
can independently produce arbitrary, ordered, executable plans. Begin with the
existing command palette and compare against its current keyword matching.

## Primary evidence

- [Introduction](https://docs.typesafe.ai/introduction): TypeSafe AI's Jev accepts
  state and typed questions. Choice selects an option, Score rates against a
  rubric, and Noul returns a yes probability. Questions run independently.
- [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev):
  released in early access September 15, 2026. Describes RLCD training and parallel
  sampling. Speed and price claims are vendor results, not Silo measurements.
- [Function calling](https://docs.typesafe.ai/cookbooks/function_calling): demonstrates
  selecting a function and filling closed-set arguments. Its dispatcher leaves
  unrestricted arguments at defaults; that is not general argument extraction.
- [Smart home demo](https://docs.typesafe.ai/demos/smart-home): uses an LLM to split
  compound requests and generate conversational answers.
- [Confidence](https://docs.typesafe.ai/confidence): Choice and Score confidence
  summarizes the answer distribution. Thresholds require domain evaluation.
- [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): documents
  numerical, reasoning, irrelevant-context and adversarial-input weaknesses.
  Schema validity does not establish correct intent or safe execution.

## Existing seam

`app/SiloUI/src/features/application/components/application-command-menu.tsx`
already implements cmdk with keyword filtering.
`application-commands.ts` supplies command IDs, labels, callbacks and current
availability for navigation, terminal/editor handoff and VM lifecycle operations.
It is a candidate source of command metadata, not a complete asynchronous tool
executor or backend authorization boundary.

## Proposed experiment

1. Collect 50 actual requests and expected actions, targets or clarification.
   Include duplicate VM names on different computers, missing targets, negation,
   unsupported deletion requests and compound instructions.
2. Compare current search, Jev and a small tool-calling LLM on the same cases.
   Measure exact action/target correctness, wrong mutations, abstention, latency
   and user completion time. Set acceptance criteria before seeing results.
3. For Jev, supply allowed commands and concrete computer/VM identities, plus
   explicit unsupported and ambiguous outcomes. Initially show the selected
   action for user execution.
4. Expand only after proof. A known workflow such as start-then-open-terminal
   should await readiness in code. General plans require additional orchestration.

Enforce allowed actions in the executor. Exclude deletion, reset, overwrite and
arbitrary shell execution from the initial surface. Stopping or restarting a VM
can interrupt work even without deleting its disk; treat those separately from
navigation. Recheck state before executing. Send minimal metadata to the hosted
model, not secrets or guest files. Keep ordinary command search available offline.

No benchmark has been run. This establishes architectural fit, not measured
quality, user demand, production reliability or a final provider choice.
