"""Voices Commute-mode lessons with Kokoro: one WAV per chapter, plus when each
sentence starts (cues), so the app can highlight the text while it plays offline.

    python lesson_speak.py --voice af_heart --out-dir DIR < lesson.json

stdin: {"chapters": [{"id": "intro", "items": [{"say": "..."} | {"pause": 0.6}, ...]}, ...]}
Writes DIR/<chapter id>.wav and prints {"<chapter id>": {"duration": s, "cues": [{"t": s, "text": "..."}]}}.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24_000
GAP = 0.28  # silence between sentences, seconds


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    pipeline = KPipeline(lang_code=args.voice[0], repo_id="hexgrad/Kokoro-82M")
    lesson = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    result = {}
    for chapter in lesson["chapters"]:
        parts: list[np.ndarray] = []
        cues = []
        t = 0.0
        for item in chapter["items"]:
            if "pause" in item:
                n = int(item["pause"] * SAMPLE_RATE)
            else:
                chunks = [np.asarray(a, dtype=np.float32) for _, _, a in pipeline(item["say"], voice=args.voice, speed=args.speed)]
                if not chunks:
                    continue
                audio = np.concatenate(chunks)
                cues.append({"t": round(t, 3), "text": item["say"]})
                parts.append(audio)
                t += len(audio) / SAMPLE_RATE
                n = int(GAP * SAMPLE_RATE)
            parts.append(np.zeros(n, dtype=np.float32))
            t += n / SAMPLE_RATE
        audio = np.concatenate(parts) if parts else np.zeros(1, np.float32)
        sf.write(out / f"{chapter['id']}.wav", audio, SAMPLE_RATE, subtype="PCM_16")
        result[chapter["id"]] = {"duration": round(len(audio) / SAMPLE_RATE, 2), "cues": cues}
        print(f"  {chapter['id']:<14} {result[chapter['id']]['duration']:6.1f}s", file=sys.stderr, flush=True)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
