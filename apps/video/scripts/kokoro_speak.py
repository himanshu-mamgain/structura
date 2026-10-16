"""Speaks narration lines with Kokoro (open-weight TTS, Apache 2.0), offline after the
first run downloads the model. Used by voice.mjs and voices.mjs; runs on Windows,
macOS and Linux (so cloud sessions can voice videos too).

    python kokoro_speak.py --voice hf_alpha --out-dir DIR < lines.json

stdin: [{"id": "hook-1", "text": "..."}, ...]   (UTF-8 JSON)
Writes DIR/<id>.wav (24 kHz mono) and prints {"<id>": seconds, ...} as JSON.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24_000


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", required=True, help="e.g. hf_alpha, hm_omega, af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    # The voice name's first letter is its language: h = Hindi, a = American English, b = British.
    lang = args.voice[0]
    pipeline = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
    lines = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    durations = {}
    for line in lines:
        # Kokoro yields audio per sentence chunk; join them into one clip.
        chunks = [audio for _, _, audio in pipeline(line["text"], voice=args.voice, speed=args.speed)]
        audio = np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks]) if chunks else np.zeros(1, np.float32)
        sf.write(out / f"{line['id']}.wav", audio, SAMPLE_RATE, subtype="PCM_16")
        durations[line["id"]] = round(len(audio) / SAMPLE_RATE, 3)
        print(f"{line['id']:<16} {durations[line['id']]:.2f}s", file=sys.stderr)

    print(json.dumps(durations))


if __name__ == "__main__":
    main()
