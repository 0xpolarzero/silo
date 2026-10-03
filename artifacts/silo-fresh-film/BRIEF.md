# Silo release film: fresh direction

## Assignment

Create a new release film for Silo. The viewer should understand what Silo
lets them do and want to install it. Aim for about 30 seconds; 45 seconds is
the hard maximum. Deliver a finished video with sound, an editable source and
an honest verification record. Start by proving the creative idea in an
8–12 second animatic. The primary agent will review that before the full film.

This is a fresh art direction. There is no prescribed renderer, composition,
palette, scene order or timing inherited from any earlier attempt.

## Read boundaries

Repository: `/Users/polarzero/code/projects/microsandbox-workspaces`.

Allowed local product sources:

- Root `AGENTS.md`.
- `app/SiloUI/src/`: production UI, brand mark, tokens, components and fixtures.
- `app/SiloUI/docs/silo-help.html`: product help.
- `docs/SiloUI-CONNECTIONS.md`: remote ownership and access facts.
- `docs/SiloUI-LUDA.md`: optional Linux desktop and guest agent tools.
- Targeted `app/SiloUI/src-tauri/src/` reads if necessary to settle a product fact.
- `../lcu/`, only for authentic computer-use cursor or product behavior if needed.
- Everything you create in `artifacts/silo-fresh-film/`.
- Third-party library documentation, installed dependencies and the external
  references listed below.

Start component discovery at:

- `app/SiloUI/src/components/silo-mark.tsx`
- `app/SiloUI/src/features/sandboxes/components/sandbox-list.tsx`
- `app/SiloUI/src/features/sandboxes/components/computer-badge.tsx`
- `app/SiloUI/src/features/application/pages/network-page.tsx`
- `app/SiloUI/src/features/application/model/remote-computers.ts`
- `app/SiloUI/src/fixtures/application-scenarios.ts`
- `app/SiloUI/src/index.css`

Do not read, search, list, preview or inspect:

- `demo/`, anywhere, including via Git history, search or imported code.
- Any other `artifacts/` directory, especially `silo-component-film/` and
  `silo-launch-cut/`, including sources, renders, direction notes and assets.
- Existing website films, tours, video components or promotional implementations.
- Other conversation history, task summaries, older plans or commits for videos.
- Root-wide content searches or broad docs searches that can expose those files.
- Unrelated uncommitted work, private configuration or credentials.

Write only to `artifacts/silo-fresh-film/` and temporary files needed for your
render. Do not modify the product, the website, other films or dependencies of
the production app. Do not run native actions or change real VMs. Do not commit
or publish. Parent handles integration. Respect other agents' files.

## Product truth

- Official headline: **Computers for your agents**. Prefer this over invented
  grand promises. Product: **Silo**. URL: **silo.polarzero.xyz**.
- Silo is a desktop app for creating and managing Linux VMs on your computers.
  The physical owner can be this computer or another connected computer.
- One laptop can manage VMs on another computer: start, stop, restart, inspect
  and access them. Silo runs on that owning computer and remote access uses SSH.
- Open a VM in the terminal or editor on the controlling computer and work
  through SSH. Existing tools remain useful. No agent-vendor logo parade.
- Discover/connect a VM's development server and open it in the local browser.
  A forwarded localhost address is local access, not a public deployment URL.
- A VM can have an optional Linux desktop. Silo installs Luda's guest tools
  with that desktop, so a configured agent can use GUI applications and the
  browser there. Show a purposeful sequence with an observable result, not
  one symbolic click. Do not claim every agent executable is preinstalled.
- Optional desktop, remote connection and an agent may be already configured
  in the demonstrated scenario. Illustrations must not imply impossible live
  migration, automatic cloud hosting or no setup ever.
- Supported host platforms are macOS and Linux.

These are story ingredients, not a mandatory feature-by-feature shot list.
Choose an intelligible through-line that makes the relationship between the
viewer, their tools, the remote computer and the agent obvious.

## What the user means by quality

The target is a distinctive, professionally directed short motion film.
The user wants energy, flow, surprise and immediate comprehension. They dislike
generic marketing prose, redundant labels, explanatory footnotes, feature-card
slideshows and a sequence of stationary app windows with cursor clicks.

The animation must express the benefit. A viewer should follow its spatial
and causal logic with little copy. Transitions should develop the idea, not
merely move between screens. Contrast fast transformation with deliberate
rests. Compose for a phone-sized playback as well as a desktop display.

Reuse the app's real design language and appropriate components. Simplify and
recompose them for film readability. Product fidelity does not require putting
an entire unmodified app window in every shot. Do not let the component tree,
renderer defaults or easiest implementation determine the direction.

Physical computer imagery can clarify where work happens. No logo decoration
on hardware without a reason. No explanatory subtitles that repeat visible
action. No decorative arrows, badges, tooltip flashes or click circles unless
they contribute to meaning. No arbitrary duration padding.

The original Codex computer-use cursor is supplied as a raw official asset at
`assets/codex-agent-cursor.png`. Use it for agent actions if applicable. It is a
46×48 PNG intended at 23×24 CSS pixels, with a blue (#339cff) glow; the primary
agent can review its hotspot and wrapper geometry later. It contains no film
design or animation. Human and agent actions should be distinguishable.

## External references

Inspect reference media when accessible. Distinguish actually viewed footage
from descriptions or source code. If X blocks access, use the browser or the
author's public implementation; do not claim to have watched inaccessible
clips. Extract principles, not their imagery, music or branding.

Priority references:

- https://x.com/kitlangton/status/2103898809399157179
- https://x.com/WalletChan_/status/2104157789920678330
- https://x.com/twoclipping/status/2103835273813496100 (thread has process insight)
- https://x.com/rexan_wong/status/2103707054108299437
- https://x.com/miaai_lab/status/2103837519615774895
- https://x.com/lexnlin/status/2104148233106723099
- https://x.com/higgsfield_ai/status/2103875279588602225
- https://github.com/ferndesk/no-slop-motion
- https://github.com/Leonxlnx/claude-launchvideo (public reference implementation)

Earlier visual examples from the user:

- https://x.com/albicodes/status/2103828023556632959
- https://x.com/stephanlivera/status/2103315922098470926
- https://x.com/ajith_io/status/2103449416325890146
- https://x.com/manuelogomigo/status/2103614667038052364
- https://x.com/timkochjar/status/2092278549679886507

## Creative gate

1. Read enough product evidence and accessible references to ground decisions.
   Record sources and access limitations concisely in this new directory.
2. Develop genuinely different organizing concepts. Choose one for a concrete
   reason tied to Silo's promise. State what the viewer understands and what
   makes the visual idea specific. Do not spend time polishing a long pitch.
3. Build an 8–12 second animatic of the most demanding central passage,
   including at least two transitions and a visible product consequence.
   An animated title followed by a UI reveal is insufficient proof.
4. Render an MP4 and representative frames. Show state changes, screen-space
   motion and rhythm. Use rough assets if necessary; make motion legible.
5. Report the concept, paths and your sharpest self-criticism to the primary
   agent. Stop at this review seam before expanding to the full film. This is
   internal creative review, not a request for user permission.

The gate asks whether the motion is worth watching and whether it communicates
Silo. Successful encoding and lack of clipping cannot answer that. Be willing
to discard the first concept. Do not preserve weak choreography because it is
already implemented. A renderer or motion library is not an artistic concept.

After the primary agent accepts the direction, complete the film, synchronize
sound to the edit, inspect transitions and typography, export at 1080p60 (or
explain another deliberate delivery choice) and verify the actual encoded file.
Keep an editable source. Use no copyrighted reference footage or soundtrack.
