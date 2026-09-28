# Delivery packaging and verification

`finish.py` packages the picture and master audio after the picture is final and release execution is authorized. It reads `final/silo-picture.mp4` and `audio/silo-film-master.wav`, then writes `final/silo-release.mp4` with the video stream copied and stereo AAC encoded at 256 kbps. It limits the mux to 1792 frames at 60 fps (29.866667 seconds) and enables MP4 faststart.

The script checks the expected 1920 × 1080, 60 fps, 1792-frame video stream and stereo 48 kHz AAC audio, verifies that the MP4 `moov` box precedes `mdat`, and fully decodes with FFmpeg's strict error flags. It measures integrated loudness and true peak on the AAC bitstream. If AAC reconstruction exceeds −1 dBTP, it re-encodes with only the necessary small gain reduction and checks again. It also extracts an eight-frame contact sheet and records stream details, measurements, sample times, and SHA-256 digests in `final/verification.json`.

Run from the project root with the bundled Python runtime after `final/silo-picture.mp4` exists and the release has been explicitly cleared:

```sh
/Users/polarzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 artifacts/silo-fresh-film/finish.py
```

The script requires FFmpeg, ffprobe, and Pillow. Its outputs are the release MP4, `final/contact-sheet.jpg`, and `final/verification.json`. Packaging has not been run while the picture is pending.
