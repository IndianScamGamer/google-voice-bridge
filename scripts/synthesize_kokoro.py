#!/usr/bin/env python3
import argparse
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


def main():
    parser = argparse.ArgumentParser(description="Synthesize speech with local Kokoro ONNX.")
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--voice", default="am_echo")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--volume", type=float, default=0.75)
    args = parser.parse_args()

    model_path = Path(args.model)
    voices_path = Path(args.voices)
    if not model_path.exists():
        raise SystemExit(f"Missing Kokoro model: {model_path}")
    if not voices_path.exists():
        raise SystemExit(f"Missing Kokoro voices: {voices_path}")

    kokoro = Kokoro(str(model_path), str(voices_path))
    audio, sample_rate = kokoro.create(args.text, voice=args.voice, speed=args.speed, lang="en-us")
    audio = audio * args.volume
    sf.write(args.output, audio, sample_rate)


if __name__ == "__main__":
    main()
