# Silo release film

**Rejected cut.** The user rejected this delivery. Retain it as development
evidence, not as the proposed release film. Passing media checks did not
establish the requested creative quality; see `DIRECTOR_REVIEW.md`.

The fresh direction follows one running VM through independent agent work,
remote-computer ownership, SSH access and opening its app through a local port.
The composition lasts 1,792 frames at 60 fps: 29.866667 seconds.

## Files

- `src/film.tsx`: production picture, including imports of Silo's real UI parts.
- `src/index.tsx`: 1920 × 1080 composition and duration.
- `audio-cues.json`: shared picture and sound timing.
- `score.py`: original deterministic synthesized score.
- `audio/silo-film-master.wav`: stereo PCM master.
- `finish.py`: AAC packaging, encoded-media verification and contact sheet.
- `final/silo-release.mp4`: final delivery file after packaging.
- `final/verification.json`: measurements and checksums for that delivery.
- `BRIEF.md`: product sources, creative constraints and explicit exclusions.
- `SOURCES.md`: product and external-reference research provenance.

The rendered media (`audio/silo-film-master.wav`, `final/silo-release.mp4` and its contact sheets) was removed from `main` to keep clones small.
It is preserved on the `archive/media-and-experiments` branch and in
[this directory at `df8efdd`](https://github.com/0xpolarzero/silo/tree/df8efdd6ac31b6e5805a58cb2735b9675003a6ba/artifacts/silo-fresh-film/final); the recorded verification files and
checksums remain here.

`animatic*.py`, `DIRECTION*.md`, `DIRECTOR_REVIEW.md` and `VERIFICATION.md`
retain the development evidence. The early animatics are not release files.

## Rebuild

Run from this directory. Node, Python with NumPy and Pillow, FFmpeg and FFprobe
are required. `render.mjs` currently uses the installed macOS Chrome path;
change `browserExecutable` for another host. The repository's production UI
sources must remain at their current relative location.

```sh
npm ci
npx @tailwindcss/cli -i film-input.css -o film.css --minify
npm run render
python3 score.py
python3 finish.py
```

For a selected still or passage:

```sh
node render.mjs --stills --frames=176,352,704,864,1152,1408,1720
node render.mjs --range=700,1100 --frames=768,992
```

The UI and data are deterministic motion illustrations. This work does not
operate live VMs or verify native app, SSH or port-forwarding behavior.
The official Codex cursor provenance is in `assets/README.md`.
