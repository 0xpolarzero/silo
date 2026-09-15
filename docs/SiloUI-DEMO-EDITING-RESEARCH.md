# Product demo editing research

Reviewed September 14, 2026 for the Silo film. These are practitioner guidelines,
not evidence that this particular cut converts or that one duration is universally best.

| Source | Relevant guidance | Application to Silo |
| --- | --- | --- |
| [Screen Studio: product demos](https://screen.studio/create/product-demo-videos) | Focused zooms, adjustable cursor size, cuts and speed changes help screen recordings communicate. | Establish the screen, cut to the active controls, shorten cursor travel. No continuous drift. |
| [Material: choreography](https://m1.material.io/motion/choreography.html) | Motion should direct attention and explain relationships between elements. | Show the controlling laptop and executing Office Mac simultaneously, with matched sandbox state. |
| [Material: duration and easing](https://m1.material.io/motion/duration-easing.html) | Responsive motion uses bounded durations and appropriate acceleration/deceleration. This is interface guidance, not a film timing rule. | Use roughly eight rendered frames for cursor travel, then hold still for the action. The exact duration is an editorial choice. |
| [Descript: product demo production](https://www.descript.com/blog/article/how-to-create-an-amazing-product-demo-video) | Explain the benefit through a story and use editing to shorten lengthy demonstrations. | Prepare one project, control it from the other computer, finish on its browser result. |
| [Wistia: video length](https://wistia.com/blog/optimal-video-length) | Duration depends on purpose and audience intent; promotional clips differ from instructional videos. | Treat this as a concise showcase. Keep setup prerequisites in documentation. |

## Decisions for v4

- 38 seconds, down from 57. No additional feature tour after the port opens.
- Edit the remote code before exposing the port. The browser reveal is the final
  result, followed by a two-second brand close.
- Show GitHub permissions, secrets, and backup on the owner. Keep the VM stopped
  until the laptop starts it remotely. Do not imply credential synchronization.
- Show both computers during the remote start. Matching sandbox states and an
  owner notification make the command’s destination explicit.
- Replace long cursor glides with brief travel, action, and a still result.
- Use fixed wide and close crops with an editorial cut between them. Avoid
  perpetual scaling, oscillation, floating windows, and decorative motion.
- Remove the procedural music completely. The current export is silent and
  should work without audio. A replacement soundtrack would need to support
  this finished edit rather than set its pace.

## Verification limits

Rendered frames establish layout and scripted state, not live SSH, notification
latency, or conversion performance. A useful next audience check is whether an
unprompted viewer can identify which computer receives the click, which runs the
sandbox, and what the final browser address accesses.

## Correction after reviewing v4

A crop change during repository selection looked like the app had removed its
sidebar and resized the page. v5 keeps the entire GitHub interaction in one fixed
wide frame. The same rule now applies to secrets and backup interactions.
Production UI fidelity takes priority over an editorial crop change. The bespoke
repository overlay was also replaced with the app's real combobox popup.

## Concrete film references for direction alignment

Reviewed September 14, 2026. Direction remains pending the user's reaction;
these references do not authorize another implementation revision.

- [Arc Max | Bringing AI to Arc Browser](https://www.youtube.com/watch?v=ttylMKwIe7c),
  The Browser Company, 17 seconds. Inspected playback and sampled frames in the
  browser. Tight crops show individual interactions, including a tab title and
  an attachment download. Use as a reference for compressed action/result beats
  and a short trailer's energy. Silo needs more time to establish two computers.
- [Introducing Raycast Pro](https://www.youtube.com/watch?v=Ho4JNQMEgSA),
  Raycast, 2:10. Inspected playback and sampled frames in the browser. Framed
  command UI, textured backgrounds, and feature typography provide a visual
  finish reference. Its longer feature-tour structure is not the recommended
  pacing model for Silo.

Working direction to discuss: a motion-designed product launch film. Preserve
the real UI; create momentum through purposeful framing, cuts, and actions with
visible consequences. Borrow Arc's brevity and Raycast's finish without adopting
their product copy or treating a montage as a substitute for the remote story.
Audio was muted during inspection; no soundtrack assessment was made.

## v7 implementation after direction approval

The user approved the Arc/Raycast direction. v7 compresses the film to 30 seconds,
removes the opening slogan and custom Silo forms, adds a deliberate laptop-to-pair
camera reveal, and keeps the actual UI still during ordinary interactions.
Three brief chapter wipes separate preparation, connection, and development;
other feature changes cut directly. Sparse original sound effects replace music.
The final port result is followed only by a one-second brand close.

## Next production stage: tools and diagnosis

First draft preserved in commit `c432f54`. Research reviewed September 14, 2026.
No new visual direction or tool installation has been applied.

- [Higgsfield AI Motion Designer](https://higgsfield.ai/ai-motion-designer)
  documents an agent working directly in After Effects with native editable
  layers, text, timing and animation, using the user's assets and references.
  Higgsfield documents both a ChatGPT entry point and MCP access. These are
  vendor capabilities, not a workflow tested in this repository.
- [Higgsfield's local After Effects bridge](https://github.com/higgsfield-ai/fnf-local-pluging-bridge-mcp)
  documents a local stdio runtime and Codex installer. This local adapter says
  it requires an installed/licensed After Effects and scripting permissions,
  but no Higgsfield account or cloud relay. Do not conflate it with the hosted
  generation product and its subscription requirements. Neither AE nor a
  Higgsfield control tool was available in this session's tool inventory.
- [Remotion's Three.js integration](https://www.remotion.dev/docs/three)
  provides a code-based route for 3D composition; changing editors is not a
  prerequisite for changing the visual treatment.

Editorial assessment: v10 remains a feature walkthrough. Its repeated full-window
framing leaves controls small, the device illustrations are schematic, and the
rhythm follows settings pages rather than a dramatic action/result sequence.
More transitions or sound effects would not resolve those structural weaknesses.

Recommended next proof: design one 8–12 second remote-control sequence using
faithful UI footage, intentional framing, clear action matching, and readable
results. Compare that short sequence directly against the chosen reference
before rebuilding the whole film. Preserve the user's constraints: neutral
surroundings, direct cuts, no invented Silo controls, no decorative sound effects.
After Effects is a candidate finishing tool; retain Remotion as a source of
repeatable, exact UI footage. Use 3D only if it makes computer ownership clearer.
