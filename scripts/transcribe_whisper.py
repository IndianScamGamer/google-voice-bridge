#!/usr/bin/env python3
import sys
from faster_whisper import WhisperModel

if len(sys.argv) < 2 or len(sys.argv) > 3:
    print("usage: transcribe_whisper.py WAV_FILE [MODEL]", file=sys.stderr)
    sys.exit(2)

wav_file = sys.argv[1]
model_name = sys.argv[2] if len(sys.argv) == 3 else "base.en"

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, _ = model.transcribe(
    wav_file,
    language="en",
    beam_size=5,
    vad_filter=True,
    condition_on_previous_text=False,
)

print(" ".join(segment.text.strip() for segment in segments).strip())
