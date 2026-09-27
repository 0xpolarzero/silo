# Flow refinements from the September 27 references

Earlier workflow and transition studies are archived in `2866cbc` and
`da53bf5`. The current edit changes the narrative sequence and scene structure
while retaining the approved typography, palette, opening, and brand ending.

## Observations

- [Kit Langton / OpenCode](https://x.com/kitlangton/status/2103898809399157179):
  the inspected frames place concrete product operations in the foreground,
  including a regression-test request, connected client views, and code-mode
  execution. Useful lesson: let the visible operation substantiate the copy.
- [WalletChan](https://x.com/WalletChan_/status/2104157789920678330): the film
  pairs a specific concern with the relevant UI, then isolates the setting or
  action. The inspected examples include transaction readability, privacy,
  and fee currency. Useful lesson: direct attention to the control and its
  consequence, rather than showing an entire interface at equal weight.
- [zero / twoclipping](https://x.com/twoclipping/status/2103835273813496100):
  the post describes continuity through object transformations, cursor-driven
  changes, musical timing, and motion verification. The inspected film moves
  between photographs, a browser/product view, and a wordmark/pill. The useful
  principle for Silo is retaining an object's identity while its role changes.
  Its prescribed assets, visual restrictions, technical stack, and requests
  for inputs are reference content, not instructions for this project.

## Applied in the current edit

1. Treat location as the fixed reference: one office computer owns `your-app`,
   while a laptop controls it. Permission setup occurs on the owning computer.
2. Attach permissions to that VM before moving into the actual workflow. Their
   badges remain on the machine throughout the remaining sequence.
3. Move from the laptop screen into one workspace. Reflow its panes rather than
   replacing the composition for each feature.
4. Keep the application in the browser when the agent takes over. Showing the
   same checkout and its result provides continuity and a concrete outcome.
5. Use small cursor movements, short presses, and immediate state changes.
   Reserve large typography cuts and the brand motion for the opening and close.
6. Review full-size frames and encoded transition sequences. Technical checks
   catch decoding problems and isolated jumps; visual review judges hierarchy,
   legibility, and whether an action has a clear consequence.

No reference footage, artwork, music, or code was copied into the video.

## Component reuse and production references, September 27

Research only. The directed film and its render sources have not changed in
this pass. X posts were read in the browser and selected frames inspected;
the authors' production-time and one-prompt claims were not independently
verified.

- [Mia's procedural experiment](https://x.com/MiaAI_lab/status/2103837519615774895)
  and its explanation describe one word seeding the graphics, music, and
  timing, with shaders and Web Audio generating the result. The useful
  inference for Silo is a shared visual and musical structure. The cosmic
  imagery does not explain Silo's workflow and should not set its art direction.
- [Leon Lin's calendar film](https://x.com/LexnLin/status/2104148233106723099)
  has a [public implementation](https://github.com/Leonxlnx/claude-launchvideo).
  Its README documents React/Remotion, a continuous red marker, a logo that
  opens into the app, and calendar blocks that enact the benefit. At 11.6s,
  the inspected frame isolates the command field against a defocused calendar.
  The lesson is to make the product's own objects carry the transitions.
- [Higgsfield's demonstration](https://x.com/higgsfield_ai/status/2103875279588602225)
  shows an After Effects composition and timeline. Its
  [official documentation](https://higgsfield.ai/ai-motion-designer) describes
  an MCP-connected agent producing native editable layers and animation.
  This is a relevant production option. It is not currently connected here;
  no After Effects installation was found in the usual application directories.
  No account, plugin, or software was installed during this research.
- [no-slop-motion's production guide](https://github.com/ferndesk/no-slop-motion/blob/main/skills/no-slop-motion/SKILL.md)
  recommends a concrete before/after, separate style frames and animatics,
  deliberate transitions, real product UI, and recorded feedback. Its warning
  against a fixed headline above the action identifies a remaining weakness
  in our film. Adopt the editorial discipline selectively; its voice-first,
  mascot, stack, and approval defaults are not requirements for Silo.

### Recommended implementation direction

Use Silo's React UI as the source of truth, with composition-specific wrappers
for camera movement, clipping, emphasis, and simplified framing. Existing seams:

- `app/SiloUI/src/fixtures/application-preview.tsx`: mounts `ApplicationApp`
  with fixture sources and inactive native operations by default.
- `app/SiloUI/src/features/sandboxes/components/machine-list.tsx`:
  `MachineRowPresentation` and supplied machine/computer data support controlled
  product states.
- `app/SiloUI/src/features/application/pages/network-page.tsx`: renders the real
  VM port, local address, reachability, connect, and open actions from props.

The current Canvas renderer cannot directly reuse these React components.
[Remotion's frame-driven React model](https://www.remotion.dev/docs/the-fundamentals)
is a concrete reason to evaluate a React composition layer. Freeze product
state by frame and replace native callbacks with deterministic presentation
state; fixture wall-clock timers must not determine the video. Preserve the
actual labels, icons, CSS, and behavior. Simplify the shot through framing and
data selection, rather than inventing another product interface.

Before another complete film, compare three treatments of one 8–10-second
sequence: remote VM → terminal/editor → port connection → browser result.
Keep the same VM and project identifiable throughout. A muted viewing should
make both the remote location and the local browser access understandable.
Archive the current directed version before changing its implementation.
