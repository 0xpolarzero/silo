#!/usr/bin/env python3
"""Package and verify the Silo film; run only after explicit release go-ahead."""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent
VIDEO = ROOT / "final" / "silo-picture.mp4"
AUDIO = ROOT / "audio" / "silo-film-master.wav"
OUTPUT = ROOT / "final" / "silo-release.mp4"
REPORT = ROOT / "final" / "verification.json"
CONTACT = ROOT / "final" / "contact-sheet.jpg"
FPS = 60
FRAMES = 1792
DURATION = FRAMES / FPS
TP_LIMIT_DBTP = -1.0


def run(args: list[str], *, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def probe(path: Path) -> dict:
    raw = run(["ffprobe", "-v", "error", "-count_frames", "-show_streams",
               "-show_format", "-of", "json", str(path)], capture=True)
    return json.loads(raw.stdout)


def has_faststart(path: Path) -> bool:
    """Verify that the top-level moov box precedes mdat in the MP4 file."""
    moov_offset = None
    mdat_offset = None
    file_size = path.stat().st_size
    with path.open("rb") as f:
        offset = 0
        while offset + 8 <= file_size:
            f.seek(offset)
            header = f.read(8)
            if len(header) != 8:
                break
            size, box_type = struct.unpack(">I4s", header)
            header_size = 8
            if size == 1:
                ext = f.read(8)
                if len(ext) != 8:
                    break
                size = struct.unpack(">Q", ext)[0]
                header_size = 16
            elif size == 0:
                size = file_size - offset
            if size < header_size or offset + size > file_size:
                break
            if box_type == b"moov":
                moov_offset = offset
            elif box_type == b"mdat":
                mdat_offset = offset
            offset += size
    return moov_offset is not None and mdat_offset is not None and moov_offset < mdat_offset


def loudness(path: Path) -> dict:
    result = run(["ffmpeg", "-hide_banner", "-i", str(path), "-af",
                  "loudnorm=I=-15:TP=-1:LRA=7:print_format=json", "-f", "null", "-"],
                 capture=True)
    text = result.stderr
    start = text.rfind("{")
    end = text.find("}", start) + 1
    if start < 0 or end <= start:
        raise RuntimeError("FFmpeg did not return loudness measurement JSON")
    return json.loads(text[start:end])


def encode(gain_db: float = 0.0) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="silo-release-", suffix=".mp4",
                                     dir=OUTPUT.parent, delete=False) as tmp:
        temp_path = Path(tmp.name)
    try:
        cmd = ["ffmpeg", "-hide_banner", "-y", "-i", str(VIDEO), "-i", str(AUDIO),
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
               "-b:a", "256k", "-ar", "48000", "-ac", "2", "-t", f"{DURATION:.9f}"]
        if gain_db < 0:
            cmd += ["-af", f"volume={gain_db:.4f}dB"]
        cmd += ["-movflags", "+faststart", str(temp_path)]
        run(cmd)
        temp_path.replace(OUTPUT)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def verify_streams(info: dict) -> tuple[dict, dict]:
    streams = info["streams"]
    video = next(s for s in streams if s.get("codec_type") == "video")
    audio = next(s for s in streams if s.get("codec_type") == "audio")
    checks = {
        "video_codec": video.get("codec_name"),
        "width": int(video["width"]),
        "height": int(video["height"]),
        "frame_rate": video.get("avg_frame_rate"),
        "video_frames": int(video.get("nb_read_frames", -1)),
        "audio_codec": audio.get("codec_name"),
        "audio_sample_rate": int(audio["sample_rate"]),
        "audio_channels": int(audio["channels"]),
        "duration_seconds": float(info["format"]["duration"]),
        "faststart": has_faststart(OUTPUT),
    }
    if checks["width"] != 1920 or checks["height"] != 1080:
        raise RuntimeError(f"Expected 1920x1080, found {checks['width']}x{checks['height']}")
    if checks["frame_rate"] != "60/1" or checks["video_frames"] != FRAMES:
        raise RuntimeError(f"Expected 60 fps and {FRAMES} frames; got {checks['frame_rate']} and {checks['video_frames']}")
    if checks["audio_codec"] != "aac" or checks["audio_sample_rate"] != 48000 or checks["audio_channels"] != 2:
        raise RuntimeError(f"Unexpected audio stream format: {checks}")
    if abs(checks["duration_seconds"] - DURATION) > 0.002:
        raise RuntimeError(f"Expected {DURATION:.9f}s duration, got {checks['duration_seconds']:.9f}s")
    if not checks["faststart"]:
        raise RuntimeError("MP4 faststart verification failed: moov does not precede mdat")
    return video, audio


def make_contact_sheet() -> list[dict]:
    times = [1.0, 4.27, 9.07, 12.8, 16.53, 20.8, 25.6, 28.0]
    thumbs = []
    with tempfile.TemporaryDirectory(prefix="silo-contact-") as td:
        for t in times:
            jpg = Path(td) / f"frame-{t:.2f}.jpg"
            run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss",
                 f"{t:.4f}", "-i", str(OUTPUT), "-frames:v", "1", "-q:v", "3", str(jpg)])
            with Image.open(jpg) as im:
                thumbs.append((t, im.convert("RGB").resize((480, 270), Image.Resampling.LANCZOS)))
    sheet = Image.new("RGB", (980, 4 * 306), "#151719")
    draw = ImageDraw.Draw(sheet)
    for i, (t, im) in enumerate(thumbs):
        x = 6 + (i % 2) * 488
        y = 6 + (i // 2) * 306
        sheet.paste(im, (x, y))
        draw.text((x + 6, y + 274), f"{t:.2f}s", fill="#f2eee8")
    sheet.save(CONTACT, quality=88, optimize=True)
    return [{"time_seconds": t, "frame": round(t * FPS)} for t in times]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    for required in (VIDEO, AUDIO):
        if not required.is_file():
            raise SystemExit(f"Required input missing: {required}")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe must be available on PATH")

    gain_db = 0.0
    for attempt in range(3):
        encode(gain_db)
        measured = loudness(OUTPUT)
        tp = float(measured["input_tp"])
        if tp <= TP_LIMIT_DBTP:
            break
        # AAC reconstruction can exceed the PCM peak: reduce only by the excess,
        # with a tiny margin for encoder/measurement rounding, then re-encode.
        gain_db -= tp - TP_LIMIT_DBTP + 0.03
    else:
        raise RuntimeError(f"AAC true peak still exceeds {TP_LIMIT_DBTP} dBTP after three encodes: {measured}")

    # Fully decode every stream and fail on any reported decoder error.
    run(["ffmpeg", "-hide_banner", "-xerror", "-v", "error", "-err_detect", "explode",
         "-i", str(OUTPUT), "-f", "null", "-"])
    info = probe(OUTPUT)
    _, _ = verify_streams(info)
    # `measured` describes the final encode produced in the loop above.
    final_tp = float(measured["input_tp"])
    if final_tp > TP_LIMIT_DBTP:
        raise RuntimeError(f"Final AAC true peak {final_tp:.2f} dBTP exceeds {TP_LIMIT_DBTP} dBTP")
    frames = make_contact_sheet()
    report = {
        "video": str(OUTPUT.relative_to(ROOT)),
        "duration_seconds": float(info["format"]["duration"]),
        "expected_frames": FRAMES,
        "expected_fps": FPS,
        "streams": [{k: s.get(k) for k in ("codec_name", "codec_type", "width", "height",
                                                   "avg_frame_rate", "nb_read_frames", "sample_rate",
                                                   "channels", "bit_rate")} for s in info["streams"]],
        "aac_loudness": {
            "integrated_lufs": float(measured["input_i"]),
            "true_peak_dbtp": final_tp,
            "lra_lu": float(measured["input_lra"]),
            "gain_reduction_db": gain_db,
            "true_peak_limit_dbtp": TP_LIMIT_DBTP,
        },
        "full_decode": "passed",
        "contact_sheet": str(CONTACT.relative_to(ROOT)),
        "contact_samples": frames,
        "sha256": {"video": sha256(OUTPUT), "audio_master": sha256(AUDIO),
                   "contact_sheet": sha256(CONTACT)},
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
