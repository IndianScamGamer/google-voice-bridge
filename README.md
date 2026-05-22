# Google Voice Bridge

Local browser automation for Google Voice. It keeps Google credentials out of code: Vivek logs into `voice.google.com` in a persistent Chromium profile, then Shinrou can reuse that authenticated browser session to answer, place, and hang up calls.

This is intentionally local-first. The browser profile is private and ignored by git.

## Setup

    cd google-voice-bridge
    npm install
    npm run setup
    npm run setup-tts

`npm run setup` downloads Chrome for Testing under `.browsers/`, which avoids needing sudo or a system Chrome install.

`npm run setup-tts` installs the Python TTS/STT dependencies into `.venv/`, including Kokoro ONNX for local neural TTS and Whisper/Vosk for transcription.

## First Login

    npm run login

That opens Google Voice in a visible Chromium window with a persistent profile under `.voice-profile/`. Log in manually and allow microphone permissions if prompted. Leave the browser open for live testing, or close it after confirming the session persists.

## Commands

    npm run status
    npm run answer
    npm run hangup
    npm run call -- +17045551212
    npm run speak-call -- +17045551212 --text "Hi Vivek, this is Shinrou."
    npm run diagnose-audio -- --text "Audio bridge diagnostic."
    npm run conversation -- +17045551212
    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-read -- +17045551212
    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-send -- +17045551212 --text "Hi Vivek, this is Shinrou."
    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-poll -- +17045551212
    npm run conversation-test -- +17045551212
    npm run screenshot

You can also set `GV_DEFAULT_CALL_TO` in `.env` and run `npm run call`.
Set `GV_DEFAULT_SMS_TO` to omit the number from SMS commands.

## Firefox Backend

If Google rejects Chrome for Testing as an insecure browser, use the real Firefox profile that is already logged into Google:

    GV_BACKEND=firefox npm run status
    GV_BACKEND=firefox npm run answer
    GV_BACKEND=firefox npm run call -- +17045551212

Important: close normal Firefox before using `GV_BACKEND=firefox`. Firefox locks its profile, so Selenium cannot reuse the logged-in profile while your regular Firefox window is already running.

The default Snap Firefox profile is auto-detected from `~/snap/firefox/common/.mozilla/firefox/profiles.ini`. Override it with `GV_FIREFOX_PROFILE=/path/to/profile` if needed.

For live call tests, keep the browser open after dialing:

    GV_BACKEND=firefox GV_KEEP_OPEN_MS=60000 npm run call -- +17045551212

To call and speak a short TTS line through a temporary virtual microphone:

    GV_BACKEND=firefox GV_SPEAK_DELAY_MS=10000 GV_KEEP_OPEN_MS=10000 npm run speak-call -- +17045551212 --text "Hi Vivek, this is Shinrou. The audio bridge is working."

This uses pactl to create a temporary 48 kHz mono null sink, sets its monitor as the default microphone source before launching Firefox, generates a clean mono WAV file, then plays that WAV into the sink with ffmpeg. The local `.env` also enables `GV_MOVE_RECORDINGS_AFTER_CALL=1` for the Firefox backend because this was the more reliable route for Vivek's logged-in Snap Firefox profile.

For an audio-hop diagnostic that does not involve Firefox or Google Voice:

    npm run diagnose-audio -- --text "Audio bridge diagnostic. This should sound smooth."

That writes an original TTS WAV and a recording from `gv_tts.monitor` under `tmp/`. If the monitor recording is already bad, focus on ffmpeg, PulseAudio/PipeWire, sink format, and system load. If it is clean, the next suspect is Firefox/WebRTC or the Google Voice/phone network hop.

Useful live audio inspection commands:

    pactl info
    pactl list short sinks
    pactl list short sources
    pactl list source-outputs
    pactl list sink-inputs
    wpctl status

Default TTS is local Kokoro voice `am_echo`. Edge neural TTS is still available as a fallback; avoid heavy pitch/rate changes for calls because phone compression makes them sound more robotic:

    GV_TTS_VOICE=en-US-BrianNeural GV_TTS_RATE=+0% GV_TTS_PITCH=+0Hz GV_BACKEND=firefox npm run speak-call -- +17045551212 --text "Testing Shinrou voice."

Kokoro ONNX model files live under `models/kokoro`. One-time setup if they are missing:

    mkdir -p models/kokoro
    curl -L -o models/kokoro/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    curl -L -o models/kokoro/voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

Then run with:

    GV_TTS_PROVIDER=kokoro GV_KOKORO_VOICE=am_echo GV_KOKORO_SPEED=1.0 GV_KOKORO_VOLUME=0.75 GV_BACKEND=firefox npm run speak-call -- +17045551212 --text "Testing Shinrou voice."

Good Kokoro male voices to try: `am_echo`, `am_adam`, `am_michael`, `am_onyx`, `am_fenrir`, `am_puck`.

## Conversation Test

`conversation-test` verifies both directions. It calls, speaks a prompt, records Firefox's Google Voice output through a virtual speaker sink, transcribes with local Whisper by default, then speaks back what it heard:

    GV_BACKEND=firefox GV_SPEAK_DELAY_MS=15000 GV_LISTEN_DELAY_MS=4500 GV_LISTEN_SECONDS=14 GV_KEEP_OPEN_MS=8000 npm run conversation-test -- +17045551212

## Live Conversation

`conversation` runs a back-and-forth call loop. It speaks an opener, records the phone audio, transcribes locally, speaks a reply, and keeps going until a stop phrase, `GV_CONVERSATION_MAX_MINUTES`, repeated silence, or an explicit positive `GV_CONVERSATION_TURNS` limit:

    npm run conversation -- +17045551212

By default the reply is a simple confirmation-style response, which keeps the first full-duplex test deterministic. To use a real reply generator, set `GV_CONVERSATION_REPLY_COMMAND` to a command that reads JSON from stdin and prints one reply line to stdout.

Gemini CLI reply generation is available with:

    GV_CONVERSATION_REPLY_COMMAND="node scripts/reply_gemini.mjs" npm run conversation -- +17045551212

Local Ollama reply generation is available with:

    GV_CONVERSATION_REPLY_COMMAND="node scripts/reply_ollama.mjs" GV_OLLAMA_MODEL=qwen3:4b npm run conversation -- +17045551212

## SMS Bridge

The Firefox backend can read and send Google Voice SMS messages from the logged-in profile:

    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-read -- +17045551212
    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-send -- +17045551212 --text "Short reply text."
    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-poll -- +17045551212

`sms-poll` compares the latest inbound text against `tmp/sms-state.json`; after a successful automated reply, mark it handled:

    GV_BACKEND=firefox GV_HEADLESS=1 npm run sms-mark -- --signature "them|timestamp|message"

SMS browser commands use `tmp/sms.lock` so background polling does not collide with a manual Firefox/Selenium run.

## Safety Rules

- Incoming calls from Vivek can be answered when he asks for testing.
- Outbound calls should only be made after explicit confirmation.
- Do not store Google credentials, phone numbers, or call content in repo files.
- `.voice-profile/` is sensitive because it contains browser session data.

## Current Limits

Google Voice does not expose a supported automation API for consumer accounts. This bridge controls the website like a user would, so selectors can break if Google changes the UI. The controller uses accessible labels and fallback selectors where possible, and `npm run screenshot` helps debug what the browser sees.

Live conversation audio is a separate layer. This bridge handles call UI control first: login, answer, dial, and hang up. STT/TTS audio routing can be added after the browser-call loop is proven.
