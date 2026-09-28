#!/usr/bin/env python3
"""Deterministic original procedural score for the Silo fresh film."""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent
CUES = ROOT / "audio-cues.json"
OUT = ROOT / "audio" / "silo-film-master.wav"
RATE = 48_000
BPM = 112.5
SEED = 902741


def midi(n: int) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n: int, attack: float, decay: float, release: float = 0.0) -> np.ndarray:
    t = np.arange(n, dtype=np.float64) / RATE
    e = np.minimum(1.0, t / max(attack, 1e-4))
    e *= np.exp(-t / max(decay, 1e-4))
    if release:
        e *= np.minimum(1.0, np.maximum(0.0, (n / RATE - t) / release))
    return e


def add_tone(mix: np.ndarray, when: float, length: float, note: int, amp: float,
             pan: float = 0.0, kind: str = "pluck") -> None:
    start = int(round(when * RATE))
    count = min(int(length * RATE), len(mix) - start)
    if count <= 0:
        return
    t = np.arange(count, dtype=np.float64) / RATE
    f = midi(note)
    phase = 2 * np.pi * f * t
    if kind == "bass":
        sig = np.sin(phase) + 0.18 * np.sin(2 * phase)
        e = env(count, .012, .30, .035)
    else:
        sig = (np.sin(phase) + .30 * np.sin(2 * phase + .2)
               + .11 * np.sin(3 * phase + .7))
        e = env(count, .006, .24, .10)
    sig = amp * sig * e
    left = math.sqrt((1 - pan) * .5)
    right = math.sqrt((1 + pan) * .5)
    mix[start:start + count, 0] += sig * left
    mix[start:start + count, 1] += sig * right


def add_noise_tap(mix: np.ndarray, when: float, amp: float, rng: np.random.Generator,
                  duration: float = .075, pan: float = 0.0) -> None:
    start = int(round(when * RATE))
    count = min(int(duration * RATE), len(mix) - start)
    if count <= 0:
        return
    noise = rng.standard_normal(count)
    # A simple one-pole high-pass removes low-frequency rumble.
    hp = np.empty_like(noise)
    hp[0] = noise[0]
    hp[1:] = noise[1:] - .84 * noise[:-1]
    e = np.exp(-np.arange(count) / (RATE * .018))
    sig = hp * e * amp * .12
    mix[start:start + count, 0] += sig * math.sqrt((1 - pan) * .5)
    mix[start:start + count, 1] += sig * math.sqrt((1 + pan) * .5)


def cue_time(frame: int, fps: float) -> float:
    return frame / fps


def synth(cues: dict) -> np.ndarray:
    fps = float(cues["fps"])
    frames = int(cues["durationFrames"])
    bpm = float(cues.get("bpm", BPM))
    seconds = frames / fps
    n = int(round(seconds * RATE))
    mix = np.zeros((n, 2), dtype=np.float64)
    rng = np.random.default_rng(SEED)
    beat = 60 / bpm
    bar = beat * 4

    # E major / C# minor color cycle, with long notes and ample room for UI.
    chords = [([64, 68, 71, 66], 40), ([61, 64, 68, 71], 37),
              ([57, 61, 64, 68], 45), ([59, 63, 66, 69], 35)]
    bar_count = int(math.ceil(seconds / bar))
    for b in range(bar_count):
        t0 = b * bar
        if t0 >= seconds:
            break
        chord, root = chords[b % len(chords)]
        # Soft bass anchors on beats one and three.
        add_tone(mix, t0, .44, root, .095, 0, "bass")
        add_tone(mix, t0 + 2 * beat, .40, root + 7, .066, 0, "bass")
        # Two restrained, warm electric-key voicings per bar.
        for at in (0.48 * beat, 2.52 * beat):
            for j, note in enumerate(chord):
                add_tone(mix, t0 + at + j * .012, .48, note + (12 if j == 3 else 0),
                         .023 if j < 3 else .018, (-.28, -.08, .12, .30)[j])
        # Dry, quiet mechanical pulse on the second and fourth beats.
        for beat_index in (1, 3):
            add_noise_tap(mix, t0 + beat_index * beat, .34, rng, .042,
                          -.10 if beat_index == 1 else .10)

    # A few subdued syncopated upper notes keep forward motion without a click bed.
    motif = [76, 73, 71, 68, 71, 73, 76, 73]
    for k in range(int(seconds / beat / 2) + 1):
        t = k * beat * 2 + beat * .5
        if t < seconds and k % 2 == 0:
            add_tone(mix, t, .24, motif[(k // 2) % len(motif)], .022,
                     (-.22, .18)[k % 2])

    # Event accents are driven exclusively by the authored cue frames.
    event_index = {"open": 0, "reveal": 1, "connected": 2, "click": 3,
                   "type": 4, "complete": 5, "close": 6}
    for ev in cues.get("events", []):
        t = cue_time(int(ev["frame"]), fps)
        if not (0 <= t < seconds):
            continue
        typ = str(ev["type"])
        weight = max(0.0, min(1.0, float(ev.get("weight", .5))))
        label = str(ev.get("label", "" )).lower()
        frame = int(ev["frame"])
        pan = (-.18, .12)[event_index.get(typ, 0) % 2]
        if typ == "open":
            # Frame 256 is the primary workspace-open accent; later local
            # playback is a smaller payoff in the same musical language.
            strength = 1.0 if frame == 256 else (.48 if "same report" in label else .62)
            add_noise_tap(mix, t, strength * (.75 + .32 * weight), rng, .085, pan)
            for note in (68, 76):
                add_tone(mix, t, .42, note, strength * (.040 + .012 * weight), pan, "pluck")
        elif typ == "reveal":
            # Low-key two-note confirmation emphasizes the physical owner moment.
            add_tone(mix, t, .62, 64, .075 + .025 * weight, -.08, "pluck")
            add_tone(mix, t + .035, .62, 71, .070 + .022 * weight, .10, "pluck")
            add_noise_tap(mix, t, .58 + .22 * weight, rng, .07, 0)
        elif typ == "connected":
            add_noise_tap(mix, t, .68 + .18 * weight, rng, .055, pan)
            add_tone(mix, t + .055, .22, 73 if "ssh" in label else 76,
                     .040 + .012 * weight, -pan, "pluck")
        elif typ in ("click", "type"):
            add_noise_tap(mix, t, (.44 if typ == "click" else .28) * (.6 + .5 * weight),
                          rng, .032 if typ == "click" else .024, pan)
        elif typ == "complete":
            if "headline" in label:
                # One modest closing dyad; routine completions stay tactile.
                add_tone(mix, t, .72, 64, .040, -.08, "pluck")
                add_tone(mix, t + .025, .72, 68, .034, .08, "pluck")
            else:
                add_noise_tap(mix, t, .30 + .12 * weight, rng, .035, pan)
        elif typ == "close":
            add_tone(mix, t, .40, 68, .036, 0, "pluck")

    # Gentle end fade prevents clicks on fractional-bar tails.
    fade = min(int(.42 * RATE), n // 2)
    if fade:
        mix[-fade:] *= np.linspace(1.0, 0.0, fade)[:, None]
    return np.tanh(mix * 1.35) * .72


def render() -> None:
    if not CUES.exists():
        raise SystemExit(f"Cue file not found; waiting for {CUES}")
    cues = json.loads(CUES.read_text())
    for key in ("fps", "durationFrames", "bpm", "events"):
        if key not in cues:
            raise SystemExit(f"Cue file missing required key: {key}")
    audio = synth(cues)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to write the 24-bit master")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="silo-score-") as td:
        raw = Path(td) / "mix.f32le"
        audio.astype("<f4").tofile(raw)
        base = [ffmpeg, "-hide_banner", "-loglevel", "info", "-y", "-f", "f32le",
                "-ar", str(RATE), "-ac", "2", "-i", str(raw)]
        # Analyze the source, then use FFmpeg's true-peak-aware normalization.
        analysis = subprocess.run(base + ["-af", "loudnorm=I=-15:TP=-1.5:LRA=7:print_format=json",
                                          "-f", "null", "-"], check=True,
                                 capture_output=True, text=True)
        match = re.search(r"\{\s*\"input_i\".*?\}", analysis.stderr, re.S)
        measured = json.loads(match.group(0)) if match else {}
        params = "loudnorm=I=-15:TP=-1.5:LRA=7:print_format=summary"
        subprocess.run(base + ["-af", params, "-c:a", "pcm_s24le", "-ar", str(RATE),
                               "-ac", "2", str(OUT)], check=True)
    print(f"Rendered {OUT} ({len(audio) / RATE:.3f}s, stereo, 48 kHz, 24-bit PCM)")
    if measured:
        print("Pre-normalization loudnorm analysis: " + json.dumps(measured, sort_keys=True))


if __name__ == "__main__":
    render()
