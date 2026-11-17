#!/usr/bin/env python3
"""Synthesize placeholder ambience loops (PLAN §10.4 audio budget: < 8 MB total).

Pure stdlib synthesis — layered sines and shaped noise at 22.05 kHz mono — written as
16-bit WAV into client/assets/audio/, then converted to OGG when an ffmpeg is available
(OGG is ~10x smaller and the Audio autoload loops AudioStreamOggVorbis natively). These are
placeholders: real recordings replace them without touching any code, because the content
`music` fields already reference these names.

Usage: python3 tools/gen_placeholder_audio.py [--ogg]
"""
import argparse
import math
import os
import random
import shutil
import struct
import subprocess
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "client", "assets", "audio")
RATE = 22050
SECONDS = 18


def write_wav(name, samples):
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        frames = bytearray()
        for sample in samples:
            frames += struct.pack("<h", max(-32767, min(32767, int(sample * 32767))))
        handle.writeframes(bytes(frames))
    return path


def hum(freq, level, lfo_rate=0.1, lfo_depth=0.3):
    def layer(samples, n, rng):
        phase = rng.random() * 6.28
        for i in range(n):
            t = i / RATE
            wobble = 1.0 + lfo_depth * math.sin(2 * math.pi * lfo_rate * t + phase)
            samples[i] += level * wobble * math.sin(2 * math.pi * freq * t)
        return samples
    return layer


def noise(level, cutoff=0.08, lfo_rate=0.05, lfo_depth=0.5):
    """Brown-ish noise: one-pole smoothed white noise, slowly swelled."""
    def layer(samples, n, rng):
        state = 0.0
        for i in range(n):
            t = i / RATE
            target = level * (1.0 + lfo_depth * math.sin(2 * math.pi * lfo_rate * t))
            state += (rng.random() * 2 - 1 - state) * cutoff
            samples[i] += target * state
        return samples
    return layer


def chirps(level, every):
    """Short frequency-swept chirps — sparsons around a market, or a fan belt in distress."""
    def layer(samples, n, rng):
        i = rng.randint(RATE, n - RATE)
        while i < n - RATE:
            length = int(RATE * rng.uniform(0.08, 0.25))
            base = rng.uniform(1800, 3400)
            for j in range(length):
                t = j / RATE
                sweep = base + 500 * math.sin(2 * math.pi * 6 * t)
                envelope = math.sin(math.pi * j / length)
                samples[i + j] += level * envelope * math.sin(2 * math.pi * sweep * t)
            i += int(RATE * rng.uniform(every * 0.6, every * 1.6))
        return samples
    return layer


# name -> layered recipe. 2027: traffic hum under market murmur and pigeons.
# 1955: busier murmur and more birds. 1963: machine halls and a dripping tap.
RECIPES = {
    "ssp_2027": [noise(0.10, 0.05, 0.03, 0.5), hum(110, 0.05), hum(220, 0.02), chirps(0.05, 6)],
    "ssp_cct_2027": [noise(0.07, 0.10, 0.04, 0.4), hum(150, 0.03)],
    "ssp_flat_2027": [hum(100, 0.03), noise(0.02, 0.03, 0.02, 0.3)],
    "kln_1955": [noise(0.11, 0.06, 0.04, 0.5), hum(90, 0.04), chirps(0.09, 4)],
    "kln_1963": [hum(100, 0.09, 0.15, 0.2), hum(200, 0.05), hum(300, 0.03),
                 noise(0.05, 0.20, 0.10, 0.3)],
}


def synth(name, recipe):
    rng = random.Random(name)
    n = RATE * SECONDS
    samples = [0.0] * n
    for layer in recipe:
        samples = layer(samples, n, rng)
    peak = max(abs(s) for s in samples) or 1.0
    return [s * (0.6 / peak) for s in samples]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ogg", action="store_true", help="convert the WAVs to OGG via ffmpeg")
    args = parser.parse_args()
    os.makedirs(OUT, exist_ok=True)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        candidate = os.path.expanduser(
            "~/.cache/ms-playwright/ffmpeg-1013/ffmpeg-linux")
        if os.access(candidate, os.X_OK):
            ffmpeg = candidate

    for name, recipe in RECIPES.items():
        wav_path = write_wav(name, synth(name, recipe))
        size = os.path.getsize(wav_path)
        if args.ogg and ffmpeg:
            ogg_path = os.path.join(OUT, name + ".ogg")
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-i", wav_path,
                 "-c:a", "libvorbis", "-qscale:a", "2", ogg_path],
                check=True,
            )
            os.remove(wav_path)
            size = os.path.getsize(ogg_path)
            print("wrote %s (%d bytes, ogg)" % (ogg_path, size))
        else:
            print("wrote %s (%d bytes, wav)" % (wav_path, size))
    print("audio budget check: %.1f MB total" % (
        sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT)) / 1_000_000))


if __name__ == "__main__":
    main()