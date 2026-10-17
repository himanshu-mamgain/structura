"""Measures Kokoro voices against a target speaking profile: median pitch, pitch
range, pitch movement (semitones) and words per minute, on the same paragraph.

    python measure_voices.py am_michael bm_george ...
"""

import json
import sys

import numpy as np
from kokoro import KPipeline

SR = 24_000
TEXT = (
    "A URL shortener turns a long link into a short code and redirects anyone who opens it. "
    "It is a read-heavy system: one link is created once and opened many times. "
    "So the design is mostly about fast lookups. We generate a unique number for each link, "
    "write it in base sixty-two, and keep the hot codes in a cache, so most clicks never touch the database."
)
WORDS = len(TEXT.split())


def pitch_track(audio: np.ndarray) -> np.ndarray:
    """Fundamental frequency per 40 ms frame (voiced frames only), by normalised autocorrelation."""
    frame, hop = 1024, 240
    lo, hi = SR // 300, SR // 60  # 60 to 300 Hz
    rms_floor = 0.15 * np.sqrt(np.mean(audio**2)) * 3
    f0 = []
    for start in range(0, len(audio) - frame, hop):
        x = audio[start : start + frame]
        x = x - x.mean()
        if np.sqrt(np.mean(x**2)) < rms_floor:
            continue
        ac = np.correlate(x, x, mode="full")[frame - 1 :]
        ac /= ac[0] + 1e-9
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] > 0.55:
            f0.append(SR / lag)
    return np.array(f0)


def main() -> None:
    voices = sys.argv[1:]
    rows = []
    pipelines: dict[str, KPipeline] = {}
    for voice in voices:
        lang = voice[0]
        pipelines.setdefault(lang, KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M"))
        audio = np.concatenate([np.asarray(a, dtype=np.float32) for _, _, a in pipelines[lang](TEXT, voice=voice, speed=1.0)])
        f0 = pitch_track(audio)
        semis = 12 * np.log2(f0 / np.median(f0))
        rows.append(
            {
                "voice": voice,
                "median_hz": round(float(np.median(f0)), 1),
                "range_hz": [round(float(np.percentile(f0, 5))), round(float(np.percentile(f0, 95)))],
                "movement_st": round(float(np.std(semis)), 2),
                "wpm": round(WORDS / (len(audio) / SR) * 60),
            }
        )
        print(json.dumps(rows[-1]), file=sys.stderr, flush=True)
    print(json.dumps(rows))


if __name__ == "__main__":
    main()
