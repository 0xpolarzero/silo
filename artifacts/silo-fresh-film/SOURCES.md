# Sources and access record

Only the explicit whitelist in BRIEF.md was used. No previous film, excluded
artifact, website implementation, unrelated docs, Git history or private settings
were inspected.

## Product evidence read

- `app/SiloUI/src/components/silo-mark.tsx`: interrupted arcs, fixed #FF9F0A core.
  The current rough Python glyph approximates the arcs; a final would use the
  original exact SVG path, not this approximation.
- `app/SiloUI/src/index.css`: monochrome surfaces, system sans, muted borders.
- `app/SiloUI/src/features/sandboxes/components/sandbox-list.tsx`,
  `computer-badge.tsx`, `components/list-row.tsx`, `components/connection-icon.tsx`:
  compact rows, computer pill, server symbol for remote VMs, running tint.
- `docs/SiloUI-REMOTE-COMPUTERS.md`: owner retains VM; controller opens terminal
  and editor; SSH forwarding exposes local loopback, not public hosting.
- `docs/SiloUI-LUDA.md`: optional desktop installs guest agent tooling; agent
  executables and credentials are not guaranteed; guest desktop must be running.
- `app/SiloUI/src/features/application/pages/network-page.tsx`: reachable local
  `127.0.0.1` endpoint, Connect action, browser opening on the controller.
- Official cursor supplied in `assets/codex-agent-cursor.png`. The animatic uses
  it with a roughly enlarged scale for readability; hotspot is not yet validated.

## Reference access

- https://github.com/ferndesk/no-slop-motion : read the repository overview.
  Applied principle: choose the hero/action from the product rather than default
  card grids. Did not install or invoke its skill. No assets copied.
- https://github.com/Leonxlnx/claude-launchvideo : read its public README describing
  the continuous object relay and the rendering/audio process. This is source
  research, not evidence of watching the whole film.
- https://x.com/LexnLin/status/2104148233106723099 : web text returned 403. The
  in-app browser did load and autoplay the video after hydration. Inspected
  actual sampled frames showing the calendar scene and end lockup. Did not
  continuously watch or listen to the full clip. The primary agent performed
  an independent fuller media review. No footage/music/assets copied.
- https://x.com/kitlangton/status/2103898809399157179 and
  https://x.com/twoclipping/status/2103835273813496100 : text fetch failed.
  This subagent did not view their footage. Do not describe them as watched.
- GitHub's 25.9 MB MP4 blob view could not play inline. Did not download it to
  circumvent that display limitation.

## Tooling choice

Frame-seekable Python/Pillow composition with NumPy perspective solves and
FFmpeg H.264 encoding, using installed supported packages. This keeps a rough
animatic small and disposable. It is not a commitment to the final renderer.
No production dependency or code was changed. No native app or VM was launched.

## Final production renderer

The final picture uses Remotion4.0.526/React19.1.1 and explicit production
imports. The isolated npm release was selected within the existing release-age
policy; no npm policy was weakened. Official API references read:

- https://www.remotion.dev/docs/renderer/render-media
- https://www.remotion.dev/docs/bundler
- https://www.remotion.dev/docs/renderer/render-still

Additional targeted production reads established the real Terminal/Code action
pairing in `features/application/pages/overview-page.tsx` and
`features/status-bar/status-bar.tsx`. No old film, website film, or excluded
artifact supplied code, design, dependencies or soundtrack.
