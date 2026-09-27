# Silo / Computers for your agents

33.75-second release film. 1920 × 1080, 60 fps, H.264, stereo AAC, and optional
English captions. Play `output/silo-computers-flow.mp4` or `preview.html`.

This revision follows one VM, `your-app`, hosted on an office computer. A laptop
running Silo starts it, connects an editor and terminal over SSH, forwards its
development server, and opens the app locally. The same VM then appears with
an agent using its Linux desktop, followed by its repository and credential
permissions. The agent-name strips and separate tools/local/remote montage
have been removed.

## Edit

| Time | Story |
| --- | --- |
| 0–3.75 | Computers for your agents. Linux VMs locally or remotely. |
| 3.75–7.5 | Start `your-app` on Office computer from your laptop. |
| 7.5–11.25 | Open an editor and terminal over SSH; run the development server. |
| 11.25–16.875 | Connect VM port 3000, then open the app at a laptop address. |
| 16.875–22.5 | An agent uses the same VM's Linux desktop to test the checkout. |
| 22.5–28.125 | Select repositories and scope credentials for that VM. |
| 28.125–30 | Less setup. More building. Brand resolution. |
| 30–33.75 | Computers for your agents. Download Silo. |

The computer, desktop, terminal, browser, and permission views are illustrated
motion graphics, not live recordings or exact replicas of the production UI.
The checkout, VM name, and port addresses are fictional examples. No live
credentials or VM data appear. The music and effects are synthesized from
scratch and synchronized to the edit at 128 BPM. No `demo/` files or existing
website tour implementation were read.

## Evidence

- [Product README](../../README.md): Linux VMs, local and remote management,
  familiar editors and terminals, development-server access, desktops for
  agents, repository access, and credential scope.
- [Remote computers](../../docs/SiloUI-REMOTE-COMPUTERS.md): terminals and
  editors launch on the controlling computer and connect to the guest through
  its owner; network access uses controller-side loopback SSH tunnels. The
  diagram distinguishes the laptop, hosting computer, VM port, and local
  forwarded address. It assumes the computers have already been connected.
- [Bundled help](../../app/SiloUI/docs/silo-help.html): start/stop/restart,
  editor and terminal actions, Network ports, and the optional Linux desktop.
- [Desktop agent tools](../../docs/SiloUI-LUDA.md): computer use in the guest;
  agents must be installed and authenticated inside the VM.
- [Secrets](../../docs/SiloUI-SECRETS.md): credentials remain on the hosting
  computer and are scoped by sandbox and HTTPS domain. GitHub read-only access
  is explicitly presented as the OAuth default, not personal-token behavior.
- [Website product copy](../../website/index.html): the main headline,
  “Start it here. Run it there,” “From server to browser,” and
  “Less setup. More building.” Only product copy was consulted.

The approved two-computer workflow is archived in commit `2866cbc`, including
its exact MP4. This follow-up carries the port connection into the local address,
expands the remote VM into the desktop, and returns the desktop to the VM for
permissions. See [reference observations](REFERENCE-NOTES.md).

The approved 15-second study is archived in commit `72eb0b1` under
`../silo-motion-study/`. The preceding 30-second render is preserved locally
at `output/archive/silo-computers-v1.mp4`.

## Rebuild

Requires Node.js, `@napi-rs/canvas`, FFmpeg/ffprobe, Python with NumPy, and the
macOS Avenir Next Condensed, SF Pro, and SF Mono fonts. No app dependency changes.

```sh
node build.mjs
```

Set `SILO_VIDEO_PYTHON` to a Python interpreter with NumPy and
`SILO_VIDEO_NODE_MODULES` to the Node dependency directory if needed. The latter
defaults to this host's bundled Codex dependency runtime.

Use `node render.mjs --stills` for a storyboard, `node render.mjs --frame 14.6`
for a frame, or `node build.mjs --mux-only` after rendering picture and audio.
The renderer uses three shutter samples per frame. Audio uses measured two-pass
normalization. The build verifies duration, dimensions, all 2025 frames, full
audio/video decode, and the final audio peak. The approved workflow MP4,
storyboard, and verification reports are archived in Git; intermediates stay
ignored.
