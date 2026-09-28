# Silo: Space to build

A 54-second release film, rendered at 1920 × 1080 and 60 fps. The master is
`output/silo-release.mp4`, with H.264 video, stereo AAC audio, and fast-start
metadata for web playback. The music is an original, deterministic electronic
composition. No licensed samples or stock footage are used.

## Edit

| Time | Sequence |
| --- | --- |
| 00:00–00:04.5 | More room to build; the Silo mark assembles |
| 00:04.5–00:08.5 | Product reveal |
| 00:08.5–00:15 | Local and remote computers in one app |
| 00:15–00:22 | Editor, terminal, and local development ports |
| 00:22–00:31 | Illustrated Linux desktop agent workflow |
| 00:31–00:39 | Repository permissions and scoped credentials |
| 00:39–00:45 | Local disk export and backup restoration |
| 00:45–00:48 | Your computers. Your tools. Your rules. |
| 00:48–00:54 | Product and download end card |

## Evidence and boundaries

The interface captures use the current production React components with
deterministic fixture data. Names, addresses, secrets, statuses, and file contents
are synthetic. No native application, personal credential store, or live VM was
accessed. The desktop agent sequence is drawn for this film and labeled
“Illustrative agent workflow.” It is not footage of an agent verification run.

Feature claims come from the repository's README, app source, and the two product
documents listed in [the research notes](../../docs/SiloUI-LAUNCH-CUT-NOTES.md).
The `demo/` directory and previous film implementations were not read.

## Rebuild

Use Node.js, FFmpeg, and Python with NumPy. The renderer uses `@napi-rs/canvas`;
capturing the UI additionally uses Playwright and the app's installed Vite tools.
The macOS system fonts are SF Pro and SF Mono. Set `SILO_VIDEO_NODE_MODULES` to a
directory containing the Node dependencies on another installation.

From this directory:

```sh
node capture.mjs
node film.mjs --stills
node film.mjs --render
python3 score.py
ffmpeg -y -i output/score.wav -af 'loudnorm=I=-16:TP=-1.5:LRA=9:measured_I=-19.27:measured_TP=-6.83:measured_LRA=3.00:measured_thresh=-29.41:offset=-0.85:linear=true' -ar 48000 -c:a pcm_s24le output/score-master.wav
ffmpeg -y -i output/picture.mp4 -i output/score-master.wav -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 256k -ar 48000 -t 54 -movflags +faststart output/silo-release.mp4
```

`node film.mjs --frame 27.5` renders one frame for inspection. `output/storyboard.jpg`
contains nine representative shots. `captions.vtt` transcribes the principal
on-screen copy; there is no voiceover.
