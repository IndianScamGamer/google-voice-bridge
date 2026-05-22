import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function formatCommand(command, args) {
  return [command, ...args].map((part) => {
    const value = String(part);
    return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : JSON.stringify(value);
  }).join(' ');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => stdout += chunk);
    child.stderr?.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(command + ' exited ' + code + ': ' + stderr));
    });
  });
}

export class AudioBridge {
  constructor(config) {
    this.config = config;
    this.moduleId = '';
    this.speakerModuleId = '';
    this.previousDefaultSource = '';
    this.previousDefaultSink = '';
  }

  log(message) {
    if (this.config.audioDebug) console.error('[audio] ' + message);
  }

  async runLogged(command, args, label) {
    this.log(label + ': ' + formatCommand(command, args));
    const result = await run(command, args);
    if (result.stderr.trim()) this.log(label + ' stderr: ' + result.stderr.trim());
    return result;
  }

  async setupVirtualMic() {
    this.previousDefaultSource = (await run('pactl', ['get-default-source']).catch(() => ({ stdout: '' }))).stdout.trim();
    this.log('previous default source: ' + (this.previousDefaultSource || '(none)'));

    const sinks = (await run('pactl', ['list', 'short', 'sinks'])).stdout;
    if (!sinks.includes(this.config.audioSink)) {
      const result = await this.runLogged('pactl', [
        'load-module',
        'module-null-sink',
        'sink_name=' + this.config.audioSink,
        'rate=48000',
        'channels=1',
        'sink_properties=device.description=GoogleVoiceTTS'
      ], 'create virtual mic sink');
      this.moduleId = result.stdout.trim();
    } else {
      this.log('virtual mic sink already exists: ' + this.config.audioSink);
    }

    await this.runLogged('pactl', ['set-default-source', this.config.audioSink + '.monitor'], 'set default source');
  }

  async setupVirtualSpeaker() {
    this.previousDefaultSink = (await run('pactl', ['get-default-sink']).catch(() => ({ stdout: '' }))).stdout.trim();
    this.log('previous default sink: ' + (this.previousDefaultSink || '(none)'));

    const sinks = (await run('pactl', ['list', 'short', 'sinks'])).stdout;
    if (!sinks.includes(this.config.speakerSink)) {
      const result = await this.runLogged('pactl', [
        'load-module',
        'module-null-sink',
        'sink_name=' + this.config.speakerSink,
        'rate=48000',
        'channels=1',
        'sink_properties=device.description=GoogleVoiceCapture'
      ], 'create virtual speaker sink');
      this.speakerModuleId = result.stdout.trim();
    } else {
      this.log('virtual speaker sink already exists: ' + this.config.speakerSink);
    }

    await this.runLogged('pactl', ['set-default-sink', this.config.speakerSink], 'set default sink');
  }

  async restore() {
    if (this.previousDefaultSource) {
      await run('pactl', ['set-default-source', this.previousDefaultSource]).catch(() => {});
    }
    if (this.moduleId) {
      await run('pactl', ['unload-module', this.moduleId]).catch(() => {});
    }
    if (this.previousDefaultSink) {
      await run('pactl', ['set-default-sink', this.previousDefaultSink]).catch(() => {});
    }
    if (this.speakerModuleId) {
      await run('pactl', ['unload-module', this.speakerModuleId]).catch(() => {});
    }
  }

  async synthesize(text) {
    const dir = path.join(this.config.projectRoot, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const mp3File = path.join(dir, 'tts-' + stamp + '-' + this.config.ttsProvider + '.mp3');
    const wavFile = path.join(dir, 'tts-' + stamp + '.wav');
    this.log('synthesizing TTS with provider=' + this.config.ttsProvider);
    if (this.config.ttsProvider === 'kokoro') {
      await this.synthesizeKokoro(text, wavFile);
      this.log('wrote Kokoro TTS wav: ' + wavFile);
      return wavFile;
    }

    if (this.config.ttsProvider === 'edge') {
      await this.synthesizeEdge(text, mp3File);
    } else {
      fs.writeFileSync(mp3File, await this.synthesizeGoogleTranslate(text));
    }

    await this.runLogged('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-t', '0.4',
      '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
      '-i', mp3File,
      '-filter_complex', '[1:a]aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono,volume=' + this.config.audioVolume + '[a];[0:a][a]concat=n=2:v=0:a=1[out]',
      '-map', '[out]',
      '-ar', '48000',
      '-ac', '1',
      '-sample_fmt', 's16',
      '-y',
      wavFile
    ], 'convert TTS to clean wav');

    this.log('wrote clean TTS wav: ' + wavFile);
    return wavFile;
  }

  async synthesizeGoogleTranslate(text) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=' + encodeURIComponent(text);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (!response.ok) throw new Error('TTS fetch failed: HTTP ' + response.status);
    return Buffer.from(await response.arrayBuffer());
  }

  async synthesizeEdge(text, mp3File) {
    const edgeTtsBin = path.join(this.config.projectRoot, '.venv', 'bin', 'edge-tts');
    if (!fs.existsSync(edgeTtsBin)) {
      throw new Error('Missing .venv/bin/edge-tts. Run: python3 -m venv .venv && .venv/bin/pip install edge-tts');
    }

    await run(edgeTtsBin, [
      '--text', text,
      '--voice', this.config.ttsVoice,
      '--rate', this.config.ttsRate,
      '--pitch', this.config.ttsPitch,
      '--volume', this.config.ttsVolume,
      '--write-media', mp3File
    ]);
  }

  async synthesizeKokoro(text, wavFile) {
    const python = path.join(this.config.projectRoot, '.venv', 'bin', 'python');
    const script = path.join(this.config.projectRoot, 'scripts', 'synthesize_kokoro.py');
    if (!fs.existsSync(python)) {
      throw new Error('Missing .venv/bin/python. Run: npm run setup-tts');
    }
    if (!fs.existsSync(this.config.kokoroModel) || !fs.existsSync(this.config.kokoroVoices)) {
      throw new Error('Missing Kokoro model files under models/kokoro. Run the documented Kokoro download step.');
    }

    await this.runLogged(python, [
      script,
      '--text', text,
      '--output', wavFile,
      '--model', this.config.kokoroModel,
      '--voices', this.config.kokoroVoices,
      '--voice', this.config.kokoroVoice,
      '--speed', String(this.config.kokoroSpeed),
      '--volume', String(this.config.kokoroVolume)
    ], 'synthesize Kokoro wav');
  }

  async playToVirtualMic(audioFile) {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
    ];
    if (this.config.audioRealtime) args.push('-re');
    args.push(
      '-stream_loop', String(this.config.audioLoops),
      '-i', audioFile,
      '-vn',
      '-ar', '48000',
      '-ac', '1',
      '-sample_fmt', 's16',
      '-f', 'pulse',
      '-device', this.config.audioSink,
      '-stream_name', 'GoogleVoiceTTSPlayback',
      'google-voice-tts'
    );
    await this.runLogged('ffmpeg', args, 'play wav to virtual mic');
  }

  async listSourceOutputIds() {
    return (await run('pactl', ['list', 'short', 'source-outputs'])).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);
  }

  async listSinkInputIds() {
    return (await run('pactl', ['list', 'short', 'sink-inputs'])).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean);
  }

  async moveFirefoxRecordingsToVirtualMic() {
    const sourceOutputs = await this.listSourceOutputIds();

    const moved = [];
    for (const id of sourceOutputs) {
      await run('pactl', ['move-source-output', id, this.config.audioSink + '.monitor']).catch(() => {});
      moved.push(id);
    }
    return moved;
  }

  async waitAndMoveFirefoxRecordingsToVirtualMic(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let moved = [];
    while (Date.now() < deadline) {
      moved = await this.moveFirefoxRecordingsToVirtualMic();
      if (moved.length > 0) return moved;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return moved;
  }

  async movePlaybackToVirtualSpeaker() {
    const sinkInputs = await this.listSinkInputIds();
    const moved = [];
    for (const id of sinkInputs) {
      await run('pactl', ['move-sink-input', id, this.config.speakerSink]).catch(() => {});
      moved.push(id);
    }
    return moved;
  }

  async waitAndMovePlaybackToVirtualSpeaker(timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let moved = [];
    while (Date.now() < deadline) {
      moved = await this.movePlaybackToVirtualSpeaker();
      if (moved.length > 0) return moved;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return moved;
  }

  async recordSpeaker(seconds, outputFile) {
    await this.runLogged('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'pulse',
      '-i', this.config.speakerSink + '.monitor',
      '-t', String(seconds),
      '-ar', '16000',
      '-ac', '1',
      '-y',
      outputFile
    ], 'record virtual speaker monitor');
  }

  async recordVirtualMic(seconds, outputFile) {
    await this.runLogged('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'pulse',
      '-i', this.config.audioSink + '.monitor',
      '-t', String(seconds),
      '-ar', '48000',
      '-ac', '1',
      '-sample_fmt', 's16',
      '-y',
      outputFile
    ], 'record virtual mic monitor');
  }
}
