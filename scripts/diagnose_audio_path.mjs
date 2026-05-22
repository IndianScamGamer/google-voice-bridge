#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AudioBridge } from '../src/audioBridge.mjs';
import { getConfig } from '../src/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const config = getConfig(projectRoot);
config.audioLoops = 0;
const textArgIndex = process.argv.findIndex((arg) => arg === '--text');
const testText = textArgIndex === -1
  ? 'Audio bridge diagnostic. This sentence should be smooth, steady, and free of crackle.'
  : process.argv.slice(textArgIndex + 1).join(' ');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(command + ' exited ' + code + ': ' + stderr));
    });
  });
}

async function main() {
  const audio = new AudioBridge(config);
  const tmpDir = path.join(config.projectRoot, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const monitorFile = path.join(tmpDir, 'gv-monitor-' + stamp + '.wav');
  const reportFile = path.join(tmpDir, 'gv-audio-diagnostic-' + stamp + '.json');

  await audio.setupVirtualMic();
  try {
    const originalFile = await audio.synthesize(testText);
    const duration = await getDurationSeconds(originalFile);
    const recordSeconds = Math.max(2, Math.ceil(duration + 1));

    const recordPromise = audio.recordVirtualMic(recordSeconds, monitorFile);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await audio.playToVirtualMic(originalFile);
    await recordPromise;

    const report = {
      ok: true,
      originalFile,
      monitorFile,
      reportFile,
      text: testText,
      checks: {
        compareOriginalToMonitor: 'Listen to both files. If monitorFile is already chopped or crackly, the breakage is before Firefox.',
        nextHop: 'If monitorFile is clean but calls sound bad, inspect Firefox/WebRTC source selection and Google Voice/network compression.'
      },
      commands: {
        inspectOriginal: 'ffmpeg -hide_banner -i ' + JSON.stringify(originalFile),
        inspectMonitor: 'ffmpeg -hide_banner -i ' + JSON.stringify(monitorFile),
        listSinks: 'pactl list short sinks',
        listSources: 'pactl list short sources',
        listSourceOutputs: 'pactl list source-outputs'
      }
    };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await audio.restore();
  }
}

async function getDurationSeconds(file) {
  const result = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file
  ]).catch(() => ({ stdout: '3' }));
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : 3;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
