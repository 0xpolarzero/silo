# Animatic verification

2026-09-27. Output: `render/silo-animatic.mp4`.

- Encoded H.264, 1920×1080, 60/1 fps, exactly 660 frames / 11.000 seconds.
- File size: 2,075,446 bytes. No audio, deliberately at diagnostic animatic gate.
- FFmpeg decoded the MP4 to `render/encoded-contact-sheet.jpg` without errors.
- Visually inspected source representative frames and the encoded contact sheet.
  This was sampled frame review, not continuous real-time playback.
- Corrected a moon-mask overlap that initially clipped preview text. Corrected
  nonuniform scaling of the preview by generating a responsive surface.
- Source remains editable and frame-seekable in `animatic.py`; no production
  code, dependency, configuration, VM or installed application was modified.
- All content is deterministic illustrative fixture data. No live behavior is
  verified. The agent cursor is official supplied artwork but its hotspot and
  intended display size have not been finally validated.
- Phone-sized contact-sheet views show before/after and hardware separation;
  source code, port labels and VM badge text are too small to carry the story.
- Creative result: **does not pass the direction gate.** It is still dominated
  by a scale-in / cursor / scale-out walkthrough. See DIRECTION.md for two
  alternatives. Do not treat this as a release film or an accepted direction.

Reproduce:

```sh
/Users/polarzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 artifacts/silo-fresh-film/animatic.py
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames -show_entries format=duration,size -of json artifacts/silo-fresh-film/render/silo-animatic.mp4
```
