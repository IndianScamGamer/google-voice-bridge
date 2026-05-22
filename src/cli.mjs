#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AudioBridge } from './audioBridge.mjs';
import { getConfig } from './config.mjs';
import { FirefoxVoiceController } from './firefoxVoiceController.mjs';
import { GoogleVoiceController } from './googleVoiceController.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const config = getConfig(projectRoot);
const command = process.argv[2] || 'status';
const args = process.argv.slice(3);

async function main() {
  if (command === 'speak-call') {
    await speakCall();
    return;
  }
  if (command === 'conversation-test') {
    await conversationTest();
    return;
  }
  if (command === 'conversation') {
    await conversation();
    return;
  }

  const usesSmsBrowser = ['sms-read', 'sms-send', 'sms-poll'].includes(command);
  let lockHeld = false;
  if (usesSmsBrowser) lockHeld = acquireSmsLock(config);

  const controller = config.backend === 'firefox'
    ? new FirefoxVoiceController(config)
    : new GoogleVoiceController(config);

  try {
    await controller.open();

    if (command === 'login') {
      await controller.keepOpenForLogin();
      return;
    }

    if (command === 'status') {
      console.log(JSON.stringify(await controller.status(), null, 2));
      return;
    }

    if (command === 'call') {
      const number = args[0] || config.defaultCallTo;
      const result = await controller.call(number);
      if (config.keepOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, config.keepOpenMs));
      console.log(JSON.stringify({ ok: true, action: 'call', to: number, result }, null, 2));
      return;
    }

    if (command === 'answer') {
      await controller.answer();
      if (config.keepOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, config.keepOpenMs));
      console.log(JSON.stringify({ ok: true, action: 'answer' }, null, 2));
      return;
    }

    if (command === 'hangup') {
      await controller.hangup();
      console.log(JSON.stringify({ ok: true, action: 'hangup' }, null, 2));
      return;
    }

    if (command === 'sms-read') {
      ensureSmsCapable(controller);
      const number = args[0] || config.defaultSmsTo;
      console.log(JSON.stringify(await controller.readSmsThread(number), null, 2));
      return;
    }

    if (command === 'sms-send') {
      ensureSmsCapable(controller);
      const number = args[0] || config.defaultSmsTo;
      const message = getTextArg(args);
      const result = await controller.sendSms(number, message);
      console.log(JSON.stringify({ ok: true, action: 'sms-send', ...result }, null, 2));
      return;
    }

    if (command === 'sms-poll') {
      ensureSmsCapable(controller);
      const number = args[0] || config.defaultSmsTo;
      const snapshot = await controller.readSmsThread(number);
      const state = readSmsState(config);
      const latestIncoming = [...snapshot.messages].reverse().find((message) => message.from === 'them') || null;
      const handled = latestIncoming && state.lastHandledIncomingSignature === latestIncoming.signature;
      console.log(JSON.stringify({
        ok: true,
        action: 'sms-poll',
        to: number,
        latestIncoming,
        hasNewIncoming: Boolean(latestIncoming && !handled),
        lastHandledIncomingSignature: state.lastHandledIncomingSignature || null,
        recentMessages: snapshot.messages.slice(-8)
      }, null, 2));
      return;
    }

    if (command === 'sms-mark') {
      const signature = getSignatureArg(args);
      const state = readSmsState(config);
      state.lastHandledIncomingSignature = signature;
      state.updatedAt = new Date().toISOString();
      writeSmsState(config, state);
      console.log(JSON.stringify({ ok: true, action: 'sms-mark', signature }, null, 2));
      return;
    }

    if (command === 'screenshot') {
      const file = await controller.screenshot();
      console.log(JSON.stringify({ ok: true, screenshot: file }, null, 2));
      return;
    }

    throw new Error('Unknown command: ' + command);
  } finally {
    if (command !== 'login') await controller.close();
    if (lockHeld) releaseSmsLock(config);
  }
}

function ensureSmsCapable(controller) {
  if (typeof controller.readSmsThread !== 'function' || typeof controller.sendSms !== 'function') {
    throw new Error('SMS commands currently require GV_BACKEND=firefox.');
  }
}

function getTextArg(args) {
  const textArgIndex = args.findIndex((arg) => arg === '--text');
  if (textArgIndex === -1) throw new Error('Missing --text "...".');
  return args.slice(textArgIndex + 1).join(' ');
}

function getPositionalArg(args, fallback = '') {
  const flagIndex = args.findIndex((arg) => arg.startsWith('--'));
  const positionals = flagIndex === -1 ? args : args.slice(0, flagIndex);
  return positionals[0] || fallback;
}

function getSignatureArg(args) {
  const signatureArgIndex = args.findIndex((arg) => arg === '--signature');
  if (signatureArgIndex === -1) throw new Error('Missing --signature "...".');
  return args.slice(signatureArgIndex + 1).join(' ');
}

function readSmsState(config) {
  try {
    return JSON.parse(fs.readFileSync(config.smsStateFile, 'utf8'));
  } catch {
    return {};
  }
}

function writeSmsState(config, state) {
  fs.mkdirSync(path.dirname(config.smsStateFile), { recursive: true });
  fs.writeFileSync(config.smsStateFile, JSON.stringify(state, null, 2));
}

function acquireSmsLock(config) {
  fs.mkdirSync(path.dirname(config.smsLockDir), { recursive: true });
  try {
    fs.mkdirSync(config.smsLockDir);
    fs.writeFileSync(path.join(config.smsLockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      command,
      createdAt: new Date().toISOString()
    }, null, 2));
    return true;
  } catch (error) {
    const ownerPath = path.join(config.smsLockDir, 'owner.json');
    let owner = {};
    try {
      owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    } catch {}
    const ageMs = owner.createdAt ? Date.now() - Date.parse(owner.createdAt) : Infinity;
    if (ageMs > 120000) {
      fs.rmSync(config.smsLockDir, { recursive: true, force: true });
      return acquireSmsLock(config);
    }
    console.log(JSON.stringify({
      ok: true,
      action: command,
      skipped: true,
      reason: 'sms-lock-held',
      owner
    }, null, 2));
    process.exit(0);
  }
}

function releaseSmsLock(config) {
  fs.rmSync(config.smsLockDir, { recursive: true, force: true });
}

async function speakCall() {
  const number = getPositionalArg(args, config.defaultCallTo);
  if (!number) throw new Error('Missing phone number. Pass one as an argument or set GV_DEFAULT_CALL_TO.');

  const textArgIndex = args.findIndex((arg) => arg === '--text');
  const sayText = textArgIndex === -1 ? config.sayText : args.slice(textArgIndex + 1).join(' ');
  const audio = new AudioBridge(config);
  const controller = config.backend === 'firefox'
    ? new FirefoxVoiceController(config)
    : new GoogleVoiceController(config);

  await audio.setupVirtualMic();
  const audioFile = await audio.synthesize(sayText);

  try {
    console.error('[speak-call] opening browser');
    await controller.open();
    console.error('[speak-call] dialing');
    const result = await controller.call(number);
    console.error('[speak-call] dial result ' + JSON.stringify(result));
    console.error('[speak-call] waiting before speech ' + config.speakDelayMs + 'ms');
    await new Promise((resolve) => setTimeout(resolve, config.speakDelayMs));
    const movedSourceOutputs = config.moveRecordingsAfterCall
      ? await audio.waitAndMoveFirefoxRecordingsToVirtualMic()
      : [];
    console.error('[speak-call] moved source outputs ' + JSON.stringify(movedSourceOutputs) + ' enabled=' + config.moveRecordingsAfterCall);
    await new Promise((resolve) => setTimeout(resolve, 750));
    console.error('[speak-call] playing ' + audioFile);
    await audio.playToVirtualMic(audioFile);
    if (config.keepOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, config.keepOpenMs));
    console.log(JSON.stringify({ ok: true, action: 'speak-call', to: number, said: sayText, movedSourceOutputs, result }, null, 2));
  } finally {
    await controller.close().catch(() => {});
    await audio.restore();
  }
}

async function conversationTest() {
  const number = getPositionalArg(args, config.defaultCallTo);
  if (!number) throw new Error('Missing phone number. Pass one as an argument or set GV_DEFAULT_CALL_TO.');

  const audio = new AudioBridge(config);
  const controller = config.backend === 'firefox'
    ? new FirefoxVoiceController(config)
    : new GoogleVoiceController(config);

  const promptText = 'Hey Vivek. This is Shinrou. Conversation test. After the beep, say one short sentence, and I will repeat what I heard. Beep.';
  const promptFile = await audio.synthesize(promptText);
  const tmpDir = path.join(config.projectRoot, 'tmp');
  const heardFile = path.join(tmpDir, 'heard-' + Date.now() + '.wav');

  await audio.setupVirtualMic();
  await audio.setupVirtualSpeaker();

  try {
    console.error('[conversation-test] opening browser');
    await controller.open();
    console.error('[conversation-test] dialing');
    const result = await controller.call(number);
    console.error('[conversation-test] dial result ' + JSON.stringify(result));

    console.error('[conversation-test] waiting for answer ' + config.speakDelayMs + 'ms');
    await new Promise((resolve) => setTimeout(resolve, config.speakDelayMs));

    const movedMic = config.moveRecordingsAfterCall
      ? await audio.waitAndMoveFirefoxRecordingsToVirtualMic()
      : [];
    let movedSpeaker = [];
    console.error('[conversation-test] moved mic ' + JSON.stringify(movedMic) + ' enabled=' + config.moveRecordingsAfterCall);

    await new Promise((resolve) => setTimeout(resolve, 750));
    console.error('[conversation-test] speaking prompt');
    await audio.playToVirtualMic(promptFile);
    console.error('[conversation-test] prompt finished');
    console.error('[conversation-test] waiting for prompt echo to clear ' + config.listenDelayMs + 'ms');
    await new Promise((resolve) => setTimeout(resolve, config.listenDelayMs));
    movedSpeaker = await audio.waitAndMovePlaybackToVirtualSpeaker();
    console.error('[conversation-test] moved speaker ' + JSON.stringify(movedSpeaker));

    console.error('[conversation-test] recording reply for ' + config.listenSeconds + 's');
    await audio.recordSpeaker(config.listenSeconds, heardFile);
    console.error('[conversation-test] recording finished ' + heardFile);
    const transcript = await transcribe(config, heardFile);
    console.error('[conversation-test] transcript ' + JSON.stringify(transcript));
    const resultPayload = { ok: true, action: 'conversation-test', to: number, transcript, heardFile, movedMic, movedSpeaker };
    const resultFile = path.join(tmpDir, 'conversation-result-' + Date.now() + '.json');
    fs.writeFileSync(resultFile, JSON.stringify(resultPayload, null, 2));

    const replyText = transcript
      ? 'I heard you say: ' + transcript
      : 'I could not clearly transcribe that yet, but I did record the call audio.';
    const replyFile = await audio.synthesize(replyText);
    console.error('[conversation-test] speaking reply');
    try {
      await audio.playToVirtualMic(replyFile);
      console.error('[conversation-test] reply finished');
    } catch (error) {
      console.error('[conversation-test] reply failed ' + (error.stack || error.message));
    }

    if (config.keepOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, config.keepOpenMs));
    console.log(JSON.stringify({ ...resultPayload, resultFile }, null, 2));
  } finally {
    await controller.close().catch(() => {});
    await audio.restore();
  }
}

async function conversation() {
  const number = getPositionalArg(args, config.defaultCallTo);
  if (!number) throw new Error('Missing phone number. Pass one as an argument or set GV_DEFAULT_CALL_TO.');

  const audio = new AudioBridge(config);
  const controller = config.backend === 'firefox'
    ? new FirefoxVoiceController(config)
    : new GoogleVoiceController(config);

  const tmpDir = path.join(config.projectRoot, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const transcript = [];
  const resultFile = path.join(tmpDir, 'conversation-live-' + Date.now() + '.json');

  await audio.setupVirtualMic();
  await audio.setupVirtualSpeaker();

  try {
    console.error('[conversation] opening browser');
    await controller.open();
    console.error('[conversation] dialing');
    const callResult = await controller.call(number);
    console.error('[conversation] dial result ' + JSON.stringify(callResult));

    console.error('[conversation] waiting for answer ' + config.speakDelayMs + 'ms');
    await new Promise((resolve) => setTimeout(resolve, config.speakDelayMs));

    const movedMic = config.moveRecordingsAfterCall
      ? await audio.waitAndMoveFirefoxRecordingsToVirtualMic()
      : [];
    console.error('[conversation] moved mic ' + JSON.stringify(movedMic) + ' enabled=' + config.moveRecordingsAfterCall);
    const movedSpeaker = await audio.waitAndMovePlaybackToVirtualSpeaker();
    console.error('[conversation] moved speaker ' + JSON.stringify(movedSpeaker));

    await speak(audio, 'Hey Vivek, this is Shinrou. The full conversation loop is online. Say one short sentence after this message, and I will respond.');

    const fixedTurnLimit = Number.isFinite(config.conversationTurns) && config.conversationTurns > 0
      ? config.conversationTurns
      : Infinity;
    const maxMinutes = Number.isFinite(config.conversationMaxMinutes) && config.conversationMaxMinutes > 0
      ? config.conversationMaxMinutes
      : Infinity;
    const deadline = Number.isFinite(maxMinutes) ? Date.now() + maxMinutes * 60 * 1000 : Infinity;
    const silenceLimit = Number.isFinite(config.conversationSilenceLimit) && config.conversationSilenceLimit > 0
      ? config.conversationSilenceLimit
      : Infinity;
    let silentTurns = 0;

    for (let turn = 1; turn <= fixedTurnLimit && Date.now() < deadline; turn++) {
      console.error('[conversation] turn ' + turn + ' waiting before listen ' + config.listenDelayMs + 'ms');
      await new Promise((resolve) => setTimeout(resolve, config.listenDelayMs));

      const heardFile = path.join(tmpDir, 'conversation-turn-' + turn + '-' + Date.now() + '.wav');
      console.error('[conversation] turn ' + turn + ' recording for ' + config.listenSeconds + 's');
      await audio.recordSpeaker(config.listenSeconds, heardFile);
      console.error('[conversation] turn ' + turn + ' recording finished ' + heardFile);

      const heardText = normalizeTranscript(await transcribe(config, heardFile));
      console.error('[conversation] turn ' + turn + ' transcript ' + JSON.stringify(heardText));
      transcript.push({ turn, role: 'vivek', text: heardText, audioFile: heardFile });

      if (heardText) silentTurns = 0;
      else silentTurns += 1;

      const shouldStopForSilence = silentTurns >= silenceLimit;
      const replyText = shouldStopForSilence
        ? 'I still cannot hear you clearly, so I am ending this call for now.'
        : await buildConversationReplySafe(config, transcript, turn);
      transcript.push({ turn, role: 'shinrou', text: replyText });
      fs.writeFileSync(resultFile, JSON.stringify({ ok: true, action: 'conversation', to: number, transcript }, null, 2));

      console.error('[conversation] turn ' + turn + ' reply ' + JSON.stringify(replyText));
      await speak(audio, replyText);

      if (/\b(bye|goodbye|hang up|stop|end call)\b/i.test(heardText)) {
        console.error('[conversation] stop phrase heard, ending loop');
        break;
      }
      if (shouldStopForSilence) {
        console.error('[conversation] silence limit reached, ending loop');
        break;
      }
    }

    if (config.keepOpenMs > 0) await new Promise((resolve) => setTimeout(resolve, config.keepOpenMs));
    console.log(JSON.stringify({ ok: true, action: 'conversation', to: number, resultFile, transcript }, null, 2));
  } finally {
    await controller.close().catch(() => {});
    await audio.restore();
  }
}

async function speak(audio, text) {
  const file = await audio.synthesize(text);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await audio.playToVirtualMic(file);
}

function normalizeTranscript(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

async function buildConversationReply(config, transcript, turn) {
  const latest = transcript.filter((item) => item.role === 'vivek').at(-1)?.text || '';
  if (!latest) return 'I could not hear that clearly. Please say one short sentence again.';

  if (config.conversationReplyCommand) {
    return await runReplyCommand(config.conversationReplyCommand, transcript, config.conversationReplyTimeoutMs);
  }

  if (/\b(bye|goodbye|hang up|stop|end call)\b/i.test(latest)) return 'Got it. Ending the test call now.';
  if (config.conversationTurns > 0 && turn >= config.conversationTurns) return 'I heard you say: ' + latest + '. That completes this conversation test.';
  return 'I heard you say: ' + latest + '. The back and forth loop is working. Say another short sentence.';
}

async function buildConversationReplySafe(config, transcript, turn) {
  try {
    return await buildConversationReply(config, transcript, turn);
  } catch (error) {
    console.error('[conversation] reply command failed ' + (error.stack || error.message));
    const latest = transcript.filter((item) => item.role === 'vivek').at(-1)?.text || '';
    return latest
      ? 'I heard you, but my reply model failed locally. Say that again or ask something simpler.'
      : 'I could not hear that clearly. Please say one short sentence again.';
  }
}

async function runReplyCommand(command, transcript, timeoutMs = 75000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let timedOut = false;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(command + ' timed out after ' + timeoutMs + 'ms'));
        return;
      }
      if (code !== 0) {
        reject(new Error(command + ' exited ' + code + ': ' + stderr));
        return;
      }
      resolve(stdout.trim() || 'I heard you, but I do not have a reply ready.');
    });
    child.stdin.end(JSON.stringify({ transcript }, null, 2));
  });
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(command + ' exited ' + code + ': ' + stderr));
    });
  });
}

async function transcribeVosk(config, wavFile) {
  const script = path.join(config.projectRoot, 'scripts', 'transcribe_vosk.py');
  const model = path.resolve(config.projectRoot, config.voskModel);
  const python = path.join(config.projectRoot, '.venv', 'bin', 'python');
  return await runProcess(python, [script, model, wavFile]);
}

async function transcribe(config, wavFile) {
  if (config.sttProvider === 'whisper') {
    const script = path.join(config.projectRoot, 'scripts', 'transcribe_whisper.py');
    const python = path.join(config.projectRoot, '.venv', 'bin', 'python');
    return await runProcess(python, [script, wavFile, config.whisperModel]);
  }
  return await transcribeVosk(config, wavFile);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
