# Silo release film

`SiloRelease` is a 54-second, 1920×1080, 30 fps release composition in
[`demo/`](../demo/). It leads with agent computer use, then shows local and
remote sandboxes, familiar tools, scoped access, and a browser preview.
The film is silent, matching the existing [demo direction](SiloUI-DEMO-SCRIPT.md).
The original `SiloDemo` and `SiloSshDemo` compositions remain available.

## Editorial timing

| Time | Scene and copy | Visual evidence |
| --- | --- | --- |
| 0–5s | “A computer. For your agents.” | Silo mark and kinetic typography; “Linux sandboxes on the computers you own.” |
| 5–15s | “A desktop they can use.” | Illustrated agent observes a Linux desktop, clicks a project-creation button, and checks its result inside the production Silo viewer. |
| 15–23s | “Your computers. One place.” | Production overview with local and remote fixture sandboxes; an SSH connection diagram. |
| 23–31s | “Your tools. Your flow.” | Production Files view, illustrated Zed edit and save, and a development-server command. |
| 31–36s | “The right repositories. You decide.” | Production GitHub view; OAuth repository selection and read-only defaults. |
| 36–41s | “The right credentials. In scope.” | Production Secrets view with a fixture token assigned to a sandbox and HTTPS domain. |
| 41–48s | “Build there. Open here.” | Production Network view followed by an illustrated browser using a forwarded local address. |
| 48–54s | “Give your agents a space of their own.” | Silo identity, website address, macOS/Linux availability, and MIT license. |

[`release-timeline.ts`](../demo/src/release-timeline.ts) owns the 1,620-frame
timeline. [`release-film.tsx`](../demo/src/release-film.tsx) owns composition and
motion; [`release-style.css`](../demo/src/release-style.css) owns its typography,
color, and layout. Entrances settle before the corresponding detail is shown.

## Product claims and fidelity

The Silo viewer, overview, Files, GitHub, Secrets, and Network surfaces import
production components. Their data and state changes are deterministic fixtures.
Guest desktop content, agent session, editor, terminal, browser, and computer
diagram are illustrations. The desktop scene explicitly says “Illustrated agent
session”; its successful task is an example, not a recorded agent benchmark.
Rendering does not call a VM, SSH, credential store, agent, or external service.

| Claim | Repository source and boundary |
| --- | --- |
| Linux VMs on owned computers | [README](../README.md). Local macOS/Linux and remote SSH management are supported; the film makes no boot-speed claim. |
| Agent desktop tools | [Luda integration](SiloUI-LUDA.md). Adding the optional desktop installs tools and skills for supported guest agents. Users install and sign in to the agents themselves; ordinary host SSH does not inherit guest MCP configuration. |
| Local and remote management | [Remote computers](SiloUI-REMOTE-COMPUTERS.md). The owner runs Silo and accepts SSH. Connections do not synchronize credentials or migrate VMs. |
| Editor and terminal workflow | [Editor handoff](SiloUI-EDITOR-HANDOFF.md), [terminal handoff](SiloUI-TERMINAL-HANDOFF.md), and [Files](SiloUI-FILES.md). The edit and terminal output are illustrative, not native application recordings. |
| Repository selection and read-only defaults | [GitHub implementation](SiloUI-GITHUB-IMPLEMENTATION.md). The copy explicitly names OAuth; [personal tokens](SiloUI-GITHUB-PERSONAL-TOKENS.md) use their full permissions. |
| Sandbox and HTTPS-domain credential scope | [Secrets](SiloUI-SECRETS.md). Allowed servers receive the real value; the film does not claim credentials can never be revealed. |
| Development-server preview | [README setup](../README.md#start-working) and [production Network page](../app/SiloUI/src/features/application/pages/network-page.tsx). Discovering a port and connecting it are separate steps; a local address requires forwarding. |
| Availability and license | [README installation](../README.md#install) and [LICENSE](../LICENSE). Platform requirements remain in the installation guide. |

## Render and verify

Use Node.js 24 with the dependencies installed as described in the
[demo README](../demo/README.md). Run from the repository root:

```sh
npm --prefix demo run typecheck
npm --prefix demo test
npm --prefix demo run stills:release
npm --prefix demo run render:release
```

The output is `demo/out/release/silo-release.mp4`. The same ignored directory
holds PNG stills and `composition.json`, which records dimensions, duration,
fixture provenance, and silent audio. The renderer exports H.264 with `yuv420p`,
CRF 17, and `muted: true`; it rejects compositions longer than 60 seconds.
The stills command samples 14 frames, including intermediate desktop states
and the final frame. A full render also exports ten representative stills,
including the disconnected and connected port states.

Before delivery, run the timeline tests and typecheck, inspect the stills for
legibility and clipping, then inspect the encoded video for dimensions, frame
rate, duration, absent audio, and transition continuity. Timeline tests cover
contiguous scenes and observation/action/result order. Rendering proves fixture
presentation, not live VM health, agent reliability, two-computer operation, or
release readiness. Record completed verification separately from this plan.

The existing Remotion renderer is reused. Primary references checked on
2026-09-27: [`renderMedia()`](https://www.remotion.dev/docs/renderer/render-media)
documents programmatic video output and encoding options;
[`renderStill()`](https://www.remotion.dev/docs/renderer/render-still) documents
frame selection and image output. The implementation is
[`release-render.mjs`](../demo/scripts/release-render.mjs).

## Verification recorded 2026-09-27

- Node.js 24.11.1: `npm --prefix demo run typecheck` passed; `npm --prefix demo test` passed all 11 tests.
- `npm --prefix demo run stills:release` and `npm --prefix demo run render:release` completed. Inspected the scene stills, intermediate desktop states, secret editor, and port connection before browser reveal. Chromium required execution outside the macOS filesystem sandbox.
- `ffprobe` confirmed H.264, 1920×1080, 30 fps, 1,620 frames, exactly 54 seconds, 4,254,180 bytes, and no audio stream. The encoded video reports full-range 4:2:0 (`yuvj420p`). Its report is saved as `demo/out/release/ffprobe.json`.
- `ffmpeg -hide_banner -v warning -i demo/out/release/silo-release.mp4 -f null -` decoded the complete file without warnings or errors. Inspected an encoded contact sheet in the output directory.
- No packaged Silo bundle or live VM was used. These checks establish the film's rendering and fixture presentation only.
