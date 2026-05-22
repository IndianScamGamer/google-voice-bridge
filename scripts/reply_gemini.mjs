#!/usr/bin/env node
import { spawn } from 'node:child_process';

let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(input || '{}');
    const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
    const prompt = buildPrompt(transcript);
    const reply = await runGemini(prompt);
    process.stdout.write(cleanReply(reply) + '\n');
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
});

function buildPrompt(transcript) {
  const lines = transcript
    .map((item) => (item.role === 'shinrou' ? 'Shinrou' : 'Vivek') + ': ' + String(item.text || '').trim())
    .filter((line) => !line.endsWith(':'));

  return [
    "You are Shinrou, Vivek's concise voice assistant on a live phone call.",
    "Reply naturally to Vivek's latest message.",
    'Keep the answer under 22 words unless he explicitly asks for detail.',
    'Do not mention transcripts, implementation, or being an AI model.',
    'If he asks for current weather and no live weather data is provided, say you need a weather lookup wired in.',
    '',
    'Conversation so far:',
    lines.join('\n') || 'Vivek: Hello.',
    '',
    'Reply as Shinrou only.'
  ].join('\n');
}

function runGemini(prompt) {
  const model = process.env.GV_GEMINI_MODEL || '';
  const args = model ? ['--model', model, prompt] : [prompt];
  return new Promise((resolve, reject) => {
    const child = spawn('gemini', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error('gemini exited ' + code + ': ' + stderr));
    });
  });
}

function cleanReply(text) {
  return String(text || '')
    .replace(/^Shinrou:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280) || 'I heard you, but I need a moment to answer that.';
}
