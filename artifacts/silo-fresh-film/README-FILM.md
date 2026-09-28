# Silo: Computers for your agents

New 29.8667-second film, 1920×1080 at60fps,1792frames. This directory contains
all picture source, isolated dependencies, assets, animatic evidence and review
notes. No production files or other films are inputs except the explicitly
whitelisted product components described below.

## Reproduce picture

```sh
npm install --prefix artifacts/silo-fresh-film
artifacts/silo-fresh-film/node_modules/.bin/tailwindcss -i artifacts/silo-fresh-film/film-input.css -o artifacts/silo-fresh-film/film.css
node artifacts/silo-fresh-film/render.mjs
```

`render.mjs` uses Remotion4.0.526 with installed Google Chrome. It imports only
production UI sources through the `@prod` alias; normal app aliases resolve to
`app/SiloUI/src`. It compiles the isolated film and writes representative PNGs
before encoding `final/silo-picture.mp4`. Rendering needs localhost port access
and headless Chrome. No Silo app or VM runs. `--stills --frames=176,640` renders
specific frames; `--range=768,1120` renders a passage into `final/passage.mp4`.

## Editable source

- `src/film.tsx`: frame-seekable picture, projection geometry, timing, original
  illustrative Notes and report app, and integration of real Silo controls.
- `src/index.tsx`: composition registration.
- `film-input.css`: product tokens and an explicit Tailwind source whitelist.
- `render.mjs`: deterministic build/still/video export.
- `audio-cues.json`:1792-frame timeline used for the original score handoff.
- `package-lock.json`: isolated dependency versions. No production dependency
  configuration was inspected or changed.

## Product fidelity

The film directly imports the production `SiloMark`, `SandboxListRow`,
`SandboxAction`, `ComputerBadge`, `Button`, `WorkspaceBadge` and `WorkspaceStatus`.
The compact controller panel recomposes these pieces for readability; Network
is a film-scale composition of the production port fields, badge and button.
The Silo SVG uses the exact paths and stroke geometry, with explicit unfilled
paths to preserve those strokes under the film's generated CSS.

The official Codex cursor raster is unchanged. A tip at raster(6,4), native
CSS(3,2), anchors the authored trajectories. Its native23×24 geometry is enlarged
for film readability with the supplied blue glow. The human cursor has a
separate white/black silhouette. No click rings are used. Start, maximize,
export, connect and open targets are tied to their rendered layouts.

## Story and truth

Silo starts the existing `studio` VM on Office Mac. Its boundary opens the
configured guest desktop while the human's workspace remains usable. The
agent's report download stays inside the guest. The laptop opens an SSH
terminal and a loopback connection to the same VM server. The local browser
shows that app, not an automatically transferred file or public deployment.
Remote management, guest desktop, configured agent and existing development
server are assumed. Illustrations are deterministic fixtures, not a live demo.

The exact headline is Computers for your agents. URL: silo.polarzero.xyz.
Mac hardware is illustration, with no decorative logo or platform exclusivity
claim. The product supports macOS and Linux hosts.

## Evidence and scope

`SOURCES.md` records permitted product/reference access and limitations.
`DIRECTION.md`, `DIRECTION-B.md`, and `DIRECTION-B2.md` preserve the rejected and
accepted animatic gates. Those rough Pillow sources are diagnostic evidence,
not dependencies of the final picture. Final audio synthesis and packaging are
owned by the root task's audio agent. This picture source does not mux audio.
