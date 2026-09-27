# Silo / Yours

An independent 15-second motion study at 1920 × 1080, 60 fps. Open
`output/silo-yours.mp4` or `preview.html` to play it.

Ivory, ink black, and orange; oversized condensed typography; a perspective
machine that separates into independent blocks; animated network paths; a
layered Linux desktop; permission typography; a six-panel montage; and a
particle mark resolving into the Silo end card. The score and sound effects
were synthesized specifically for the edit at 128 BPM. There is no voiceover.

The visuals are conceptual motion graphics, not a recording of a live VM or
agent run. They illustrate established Silo features: Linux VMs on the user's
computers, SSH remote management, optional desktops with Luda agent tools, and
per-sandbox repository and credential access. Product evidence is in the
repository [README](../../README.md), [Luda documentation](../../docs/SiloUI-LUDA.md),
and [Secrets documentation](../../docs/SiloUI-SECRETS.md).

The brief's visual references were inspected directly:

- [Pitchrotator](https://x.com/albicodes/status/2103828023556632959)
- [Stephan Livera's motion study](https://x.com/stephanlivera/status/2103315922098470926)
- [Ajith's motion study](https://x.com/ajith_io/status/2103449416325890146)
- [Flowdrive](https://x.com/manuelogomigo/status/2103614667038052364)
- [Tim's product film](https://x.com/timkochjar/status/2092278549679886507)

No reference footage, audio, or artwork was incorporated. The `demo/` directory
was not read. This study does not use the preceding release cut's screenshots
or renderer.

## Rebuild

Requirements: Node.js, FFmpeg, Python with NumPy, and `@napi-rs/canvas`. The
renderer uses the macOS Avenir Next Condensed, SF Pro, and SF Mono fonts. Set
`SILO_VIDEO_NODE_MODULES` to the directory containing Node dependencies if it
differs from the bundled runtime path in the source.

From this directory:

```sh
node render.mjs --stills
node render.mjs --render
python3 score.py
ffmpeg -y -i output/picture.mp4 -i output/score-master.wav -i captions.vtt -map 0:v -map 1:a -map 2:0 -c:v copy -c:a aac -b:a 256k -c:s mov_text -disposition:s:0 0 -metadata:s:s:0 language=eng -t 15 -movflags +faststart output/silo-yours.mp4
```

`node render.mjs --frame 3.3` renders one full-resolution frame. The final render
uses three shutter samples per output frame for motion blur. `score.py` also
masters the score with measured two-pass loudness normalization.

The approved MP4, storyboard, and verification results are archived in Git.
Intermediate renders stay ignored. No production app code, dependency, native
process, or VM is changed by this study.
