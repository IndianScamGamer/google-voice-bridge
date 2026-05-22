#!/usr/bin/env python3
import json
import sys
import wave
from vosk import KaldiRecognizer, Model, SetLogLevel

if len(sys.argv) != 3:
    print("usage: transcribe_vosk.py MODEL_DIR WAV_FILE", file=sys.stderr)
    sys.exit(2)

model_dir, wav_file = sys.argv[1], sys.argv[2]
SetLogLevel(-1)
wf = wave.open(wav_file, "rb")
if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
    raise SystemExit("expected mono 16-bit WAV")

model = Model(model_dir)
rec = KaldiRecognizer(model, wf.getframerate())
chunks = []

while True:
    data = wf.readframes(4000)
    if not data:
        break
    if rec.AcceptWaveform(data):
        chunks.append(json.loads(rec.Result()).get("text", ""))

chunks.append(json.loads(rec.FinalResult()).get("text", ""))
print(" ".join(part for part in chunks if part).strip())
