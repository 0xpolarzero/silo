# Silo: Computers for your agents

36-second release film. 1920×1080, 60 fps, stereo AAC, optional English captions.
Final output: `output/silo-computers.mp4`. Open `preview.html` for comparison
with the three silent eight-second motion studies.

The rendered media (`output/silo-computers.mp4`) was removed from `main` to keep clones small.
It is preserved on the `archive/media-and-experiments` branch and in
[this directory at `df8efdd`](https://github.com/0xpolarzero/silo/tree/df8efdd6ac31b6e5805a58cb2735b9675003a6ba/artifacts/silo-component-film/output); the recorded verification files and
checksums remain here.

The film follows one project from a remote VM to an SSH workspace, through a
forwarded development server, into an agent's Linux desktop. The same office
computer, sandbox, and example application remain identifiable throughout.

## Product components

The film imports Silo's production `SiloMark`, `SandboxListRow`, `SandboxAction`,
`ComputerBadge`, `WorkspaceStatus`, `NetworkPage`, `machineSummary`, and CSS.
Fixtures supply the machine and computer data. The surrounding composition
adjusts framing and scale for video. Cursor actions and ensuing states are
driven by frame numbers; they do not invoke the app's native operations.

The terminal, editor, sample shop, physical computer, and Linux desktop contents
are illustrations. They are not recordings of a live VM. The office computer
is already connected, and the optional guest desktop and agent are already
configured. The example VM port is 3000; its laptop loopback address uses 51432.
No public port exposure, automatic agent installation, or authentication is
implied. Production application files and dependencies were not changed.

## Rebuild

```sh
npm ci
npm run build
```

The app dependencies under `../../app/SiloUI/node_modules` must already exist.
Requires Node, FFmpeg/ffprobe, and Python with NumPy. `SILO_VIDEO_PYTHON` can
select the Python interpreter. The renderer downloads Remotion's official
Chrome Headless Shell on its first run. Fonts use this Mac's Avenir Next
Condensed and SF Mono, with system fallbacks; use those fonts to match this cut.

`npm run stills` renders the review frames. `npm run draft` renders the silent
540p draft. `node render.mjs --studies` renders three distinct silent studies.
`node build.mjs --mux-only` reassembles existing picture/audio and verifies the
result. Final fast movements use the supported Remotion CameraMotionBlur
component; settled UI stays sharp.

The original score is synthesized at 120 BPM, then mastered with measured
two-pass loudness normalization. `verify.py` checks the encoded file's
duration, frame count, dimensions, audio channels and full decode, and reports
integrated loudness and true peak. These checks verify the artifact, not live
Silo behavior or artistic quality.

Encoded verification: 36.00 seconds, 2,160 decoded frames, 1920×1080 at 60 fps,
stereo audio, −15.17 LUFS integrated and −1.32 dBTP encoded true peak. The
no-emit TypeScript check passed. The final file played through in the local
reviewer; sampled encoded frames are in `output/current-review/final-contact-sheet.jpg`.

This revision removes the opening subtitle, invented repository and secret
cards, floating project badge, action tooltip, and network diagram. It cuts
half a second from the opening, uses actual sandbox rows, centers cursor
presses on the controls, and makes the arriving connection pulse light the
remote computer. The existing continuous camera, port numeral and browser
address transitions remain.

The agent now increases the cart quantity, enters an email, places the order
and receives confirmation. Product, form and receipt text transition in
sequence without overlap. It uses the original Codex browser computer-use
cursor artwork and glow; see [cursor provenance](assets/README.md). Its motion
is authored for this film.

## Direction and source evidence

See [direction and references](DIRECTION.md), the product's
[remote computer documentation](../../docs/SiloUI-REMOTE-COMPUTERS.md),
[desktop agent documentation](../../docs/SiloUI-LUDA.md), and
[bundled help](../../app/SiloUI/docs/silo-help.html).

The preceding continuity-polished film is archived in `d94ee70`.
The first approved component film is archived in `fdfbc48`.
The preceding directed version, including its exact MP4, is archived in
`28f52eb`. No `demo/`, existing website film, or parallel launch-cut
implementation was read. No reference footage, artwork, music, or code was
copied from the linked external films.
