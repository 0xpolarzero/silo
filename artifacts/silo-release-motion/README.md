# Silo / Computers for your agents

33.75-second release film. 1920 × 1080, 60 fps, H.264, stereo AAC, and optional
English captions. Play `output/silo-computers-directed.mp4` or `preview.html`.

The rendered media (the three `output/silo-computers-*.mp4` cuts and storyboards) was removed from `main` to keep clones small.
It is preserved on the `archive/media-and-experiments` branch and in
[this directory at `df8efdd`](https://github.com/0xpolarzero/silo/tree/df8efdd6ac31b6e5805a58cb2735b9675003a6ba/artifacts/silo-release-motion/output); the recorded verification files and
checksums remain here.

This version follows one project through a continuous workspace. Configure its
repository and credential access on the office device, start its computer from a
laptop, connect an editor and terminal, forward its development server, then let
an agent test the same application inside the computer's Linux desktop. The office
device remains the visible place where the computer runs throughout the workflow.

## Edit

| Time | Story |
| --- | --- |
| 0–3.75 | Computers for your agents. Linux computers locally or remotely. |
| 3.75–7.5 | Repository and credential scopes attach to `your-app` on its device. |
| 7.5–11.25 | Start the remote computer from your laptop; show stop and restart controls. |
| 11.25–15 | Move into the workspace; open the editor and terminal over SSH. |
| 15–17.875 | Connect the development server on computer port 3000. |
| 17.875–20.625 | Open the app at the laptop address, localhost:51432. |
| 20.625–28.125 | Keep the app visible inside the computer's desktop while an agent tests checkout. |
| 28.125–30 | Less setup. More building. |
| 30–33.75 | Computers for your agents. Download Silo. |

The permission cards become attributes of the office computer before the laptop enters.
The laptop screen then grows into the working view. Editor, network, and agent
panes share one coordinate system; the browser remains visible through the
handoff to the agent. Cursor gestures lead the main operations, with short click responses. The terminal's
server address, the laptop's forwarded address, and the desktop's guest address
are distinct and explicitly labeled.

The computer, workspace, terminal, browser, and permission views are illustrated
motion graphics, not live recordings or exact replicas of the production UI.
The checkout, computer name, and port addresses are fictional examples. The devices
are assumed to be connected already, and a Linux desktop and agent are installed
inside the computer. No live credentials or computer data appear. The music and effects are
synthesized from scratch and synchronized to the edit at 128 BPM. No `demo/`
files or existing website tour implementation were read.

## Evidence

- [Product README](../../README.md): Linux computers, local and remote management,
  familiar editors and terminals, development-server access, desktops for
  agents, repository access, and credential scope.
- [Connections](../../docs/SiloUI-CONNECTIONS.md): terminals and
  editors launch on the controlling device and connect to the guest through
  its owner; network access uses controller-side loopback SSH tunnels. The
  diagram distinguishes the laptop, hosting device, computer port, and local
  forwarded address. It assumes the devices have already been connected.
- [Bundled help](../../app/SiloUI/docs/silo-help.html): start/stop/restart,
  editor and terminal actions, Network ports, and the optional Linux desktop.
- [Desktop agent tools](../../docs/SiloUI-LUDA.md): computer use in the guest;
  agents must be installed and authenticated inside the computer.
- [Secrets](../../docs/SiloUI-SECRETS.md): credentials remain on the hosting
  device and are scoped by computer and HTTPS domain. GitHub read-only access
  is explicitly presented as the OAuth default, not personal-token behavior.
- [Website product copy](../../website/index.html): the main headline,
  “Start it here. Run it there,” “From server to browser,” and
  “Less setup. More building.” Only product copy was consulted.

## Archives

- `da53bf5`: the preceding flow revision, including its exact MP4 and source.
- `2866cbc`: the approved two-computer workflow film and its exact MP4.
- `72eb0b1`: the approved 15-second study under `../silo-motion-study/`.

See [reference observations](REFERENCE-NOTES.md) for the visual research and
[the motion review script](verify-motion.py) for the transition sampling method.

## Rebuild

Requires Node.js, `@napi-rs/canvas`, FFmpeg/ffprobe, Python with NumPy, and the
macOS Avenir Next Condensed, SF Pro, and SF Mono fonts. No app dependency changes.

```sh
node build.mjs
```

Set `SILO_VIDEO_PYTHON` to a Python interpreter with NumPy and
`SILO_VIDEO_NODE_MODULES` to the Node dependency directory if needed. The latter
defaults to this host's bundled Codex dependency runtime.

`node render.mjs --draft` creates a silent 540p24 edit for early review. Use
`--stills` for a storyboard, `--transitions` for sampled joins, or `--frame 23.9`
for a full-size frame. `node build.mjs --mux-only` assembles already-rendered
picture and audio. Final output uses three shutter samples per frame and measured
two-pass audio normalization. The build checks duration, dimensions, all 2025
frames, full audio/video decode, and the final audio peak. Run
`python3 verify-motion.py` after the build to flag isolated changes for visual
inspection; that heuristic does not assess artistic quality.

Archived films and their reports stay unchanged. New intermediates remain in
ignored `output/` paths until a subsequent archive commit.
