#!/usr/bin/env python3
"""Verify a rendered Silo component film with ffprobe and ffmpeg."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from fractions import Fraction
from pathlib import Path
from typing import Any


EXPECTED_DURATION = 36.0
DURATION_TOLERANCE = 0.05
EXPECTED_WIDTH = 1920
EXPECTED_HEIGHT = 1080
EXPECTED_FPS = Fraction(60, 1)
EXPECTED_FRAMES = 2160


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=900,
    )


def probe(path: Path, *, count_frames: bool = False) -> dict[str, Any]:
    command = ["ffprobe", "-v", "error"]
    if count_frames:
        command.append("-count_frames")
    command.extend(
        [
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ]
    )
    return json.loads(run(command).stdout)


def loudness(path: Path) -> dict[str, float | None]:
    result = run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            "loudnorm=I=-15:TP=-1:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ]
    )
    matches = re.findall(r"\{\s*\"input_i\".*?\n\s*\}", result.stderr, re.S)
    if not matches:
        return {"integrated_lufs": None, "true_peak_dbtp": None}
    stats = json.loads(matches[-1])

    def number(key: str) -> float | None:
        value = stats.get(key)
        try:
            parsed = float(value)
            return parsed if parsed > -99 else None
        except (TypeError, ValueError):
            return None

    return {
        "integrated_lufs": number("input_i"),
        "true_peak_dbtp": number("input_tp"),
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} VIDEO", file=sys.stderr)
        return 2

    video = Path(sys.argv[1]).expanduser().resolve()
    report_path = video.with_name(f"{video.stem}.verify.json")
    report: dict[str, Any] = {
        "video": str(video),
        "checks": {},
        "loudness": {"integrated_lufs": None, "true_peak_dbtp": None},
        "errors": [],
    }

    try:
        if not video.is_file():
            raise FileNotFoundError(f"Video file not found: {video}")
        metadata = probe(video)
        streams = metadata.get("streams", [])
        video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
        audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
        if video_stream is None:
            raise ValueError("No video stream found")
        if audio_stream is None:
            report["checks"]["audio_present"] = False
            report["errors"].append("Audio stream missing")

        duration = float(metadata.get("format", {}).get("duration", "nan"))
        frame_rate = Fraction(video_stream.get("avg_frame_rate", "0/1"))
        frame_info = probe(video, count_frames=True)
        counted_video = next(
            (s for s in frame_info.get("streams", []) if s.get("codec_type") == "video"),
            {},
        )
        frame_count_value = counted_video.get("nb_read_frames") or video_stream.get("nb_frames")
        frame_count = int(frame_count_value) if frame_count_value not in (None, "N/A") else None

        report["media"] = {
            "duration_seconds": duration,
            "width": video_stream.get("width"),
            "height": video_stream.get("height"),
            "fps": float(frame_rate),
            "frame_count": frame_count,
            "audio_channels": audio_stream.get("channels") if audio_stream else None,
            "audio_layout": audio_stream.get("channel_layout") if audio_stream else None,
        }
        report["checks"].update(
            {
                "duration": abs(duration - EXPECTED_DURATION) <= DURATION_TOLERANCE,
                "dimensions": video_stream.get("width") == EXPECTED_WIDTH
                and video_stream.get("height") == EXPECTED_HEIGHT,
                "frame_rate": frame_rate == EXPECTED_FPS,
                "frame_count": frame_count == EXPECTED_FRAMES,
                "audio_present": audio_stream is not None,
                "stereo_audio": audio_stream is not None and audio_stream.get("channels") == 2,
            }
        )
        if not report["checks"]["duration"]:
            report["errors"].append("Duration is outside 36.00 ± 0.05 seconds")
        if not report["checks"]["dimensions"]:
            report["errors"].append("Video dimensions are not 1920x1080")
        if not report["checks"]["frame_rate"]:
            report["errors"].append("Video frame rate is not 60 fps")
        if not report["checks"]["frame_count"]:
            report["errors"].append("Video frame count is not 2160")
        if audio_stream is not None and not report["checks"]["stereo_audio"]:
            report["errors"].append("Audio is not stereo")

        decode = run(
            [
                "ffmpeg",
                "-hide_banner",
                "-v",
                "error",
                "-xerror",
                "-i",
                str(video),
                "-f",
                "null",
                "-",
            ]
        )
        report["checks"]["full_decode"] = decode.returncode == 0
        if audio_stream is not None:
            report["loudness"] = loudness(video)
    except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        report["errors"].append(str(error))

    passed = not report["errors"] and all(report["checks"].values())
    report["passed"] = passed
    report["loudness_note"] = "Measured values are reported for review; this script does not fail on loudness targets."
    try:
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except OSError as error:
        print(f"Could not write report: {error}", file=sys.stderr)
        return 1

    print(
        f"{'PASS' if passed else 'FAIL'} {video.name}: "
        f"{report.get('media', {}).get('duration_seconds', 'n/a')}s, "
        f"{report.get('media', {}).get('width', 'n/a')}x{report.get('media', {}).get('height', 'n/a')}, "
        f"{report.get('media', {}).get('fps', 'n/a')}fps; report {report_path.name}"
    )
    if report["errors"]:
        print("; ".join(report["errors"]), file=sys.stderr)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
