import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(projectRoot) {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function getConfig(projectRoot) {
  loadEnv(projectRoot);

  const profileDir = process.env.GV_PROFILE_DIR || '.voice-profile';
  const browserPath = process.env.GV_BROWSER_PATH || findDownloadedChrome(projectRoot);
  return {
    projectRoot,
    backend: process.env.GV_BACKEND || 'playwright',
    profileDir: path.resolve(projectRoot, profileDir),
    browserPath,
    firefoxProfile: process.env.GV_FIREFOX_PROFILE || findDefaultFirefoxProfile(),
    firefoxBinary: process.env.GV_FIREFOX_BINARY || findFirefoxBinary(),
    headless: process.env.GV_HEADLESS === '1',
    keepOpenMs: Number(process.env.GV_KEEP_OPEN_MS || 0),
    speakDelayMs: Number(process.env.GV_SPEAK_DELAY_MS || 10000),
    defaultCallTo: process.env.GV_DEFAULT_CALL_TO || '',
    defaultSmsTo: process.env.GV_DEFAULT_SMS_TO || process.env.GV_DEFAULT_CALL_TO || '',
    smsStateFile: process.env.GV_SMS_STATE_FILE || path.join(projectRoot, 'tmp', 'sms-state.json'),
    smsLockDir: process.env.GV_SMS_LOCK_DIR || path.join(projectRoot, 'tmp', 'sms.lock'),
    sayText: process.env.GV_SAY_TEXT || 'Hi Vivek, this is Shinrou. The call audio bridge is working.',
    audioSink: process.env.GV_AUDIO_SINK || 'gv_tts',
    speakerSink: process.env.GV_SPEAKER_SINK || 'gv_speaker',
    audioDebug: process.env.GV_AUDIO_DEBUG !== '0',
    audioRealtime: process.env.GV_AUDIO_REALTIME !== '0',
    audioVolume: process.env.GV_AUDIO_VOLUME || '0.85',
    moveRecordingsAfterCall: process.env.GV_MOVE_RECORDINGS_AFTER_CALL === '1',
    voskModel: process.env.GV_VOSK_MODEL || 'models/vosk-model-small-en-us-0.15',
    sttProvider: process.env.GV_STT_PROVIDER || 'whisper',
    whisperModel: process.env.GV_WHISPER_MODEL || 'base.en',
    listenSeconds: Number(process.env.GV_LISTEN_SECONDS || 14),
    listenDelayMs: Number(process.env.GV_LISTEN_DELAY_MS || 4500),
    conversationTurns: Number(process.env.GV_CONVERSATION_TURNS ?? 0),
    conversationMaxMinutes: Number(process.env.GV_CONVERSATION_MAX_MINUTES || 30),
    conversationSilenceLimit: Number(process.env.GV_CONVERSATION_SILENCE_LIMIT || 3),
    conversationReplyCommand: process.env.GV_CONVERSATION_REPLY_COMMAND || '',
    conversationReplyTimeoutMs: Number(process.env.GV_CONVERSATION_REPLY_TIMEOUT_MS || 75000),
    audioLoops: Number(process.env.GV_AUDIO_LOOPS || 0),
    ttsProvider: process.env.GV_TTS_PROVIDER || 'kokoro',
    ttsVoice: process.env.GV_TTS_VOICE || 'en-US-AndrewNeural',
    ttsRate: process.env.GV_TTS_RATE || '+0%',
    ttsPitch: process.env.GV_TTS_PITCH || '+0Hz',
    ttsVolume: process.env.GV_TTS_VOLUME || '+0%',
    kokoroModel: process.env.GV_KOKORO_MODEL || path.join(projectRoot, 'models', 'kokoro', 'kokoro-v1.0.onnx'),
    kokoroVoices: process.env.GV_KOKORO_VOICES || path.join(projectRoot, 'models', 'kokoro', 'voices-v1.0.bin'),
    kokoroVoice: process.env.GV_KOKORO_VOICE || 'am_echo',
    kokoroSpeed: Number(process.env.GV_KOKORO_SPEED || 1.0),
    kokoroVolume: Number(process.env.GV_KOKORO_VOLUME || 0.75)
  };
}

function findDownloadedChrome(projectRoot) {
  const browsersRoot = path.join(projectRoot, '.browsers', 'chrome');
  if (!fs.existsSync(browsersRoot)) return '';

  const versions = fs.readdirSync(browsersRoot).sort().reverse();
  for (const version of versions) {
    const candidate = path.join(browsersRoot, version, 'chrome-linux64', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function findFirefoxBinary() {
  const candidates = [
    '/snap/firefox/current/usr/lib/firefox/firefox',
    '/usr/bin/firefox'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function findDefaultFirefoxProfile() {
  const home = process.env.HOME;
  if (!home) return '';

  const profileRoots = [
    path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(home, '.mozilla', 'firefox')
  ];

  for (const root of profileRoots) {
    const profilesIni = path.join(root, 'profiles.ini');
    if (!fs.existsSync(profilesIni)) continue;

    const text = fs.readFileSync(profilesIni, 'utf8');
    const sections = text.split(/\n(?=\[Profile\d+\])/);
    for (const section of sections) {
      if (!/Default=1/m.test(section)) continue;
      const match = section.match(/^Path=(.+)$/m);
      if (!match) continue;
      const profilePath = match[1].trim();
      const isRelative = /^IsRelative=1$/m.test(section);
      return isRelative ? path.join(root, profilePath) : profilePath;
    }
  }

  return '';
}
