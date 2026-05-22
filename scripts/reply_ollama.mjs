#!/usr/bin/env node
import { spawn } from 'node:child_process';

let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', async () => {
  try {
    const payload = JSON.parse(input || '{}');
    const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
    const prompt = buildPrompt(transcript);
    const reply = await runOllama(prompt);
    process.stdout.write(cleanReply(reply) + '\n');
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
});

function buildPrompt(transcript) {
  const lines = transcript
    .map((item) => (item.role === 'assistant' ? 'Assistant' : 'Caller') + ': ' + String(item.text || '').trim())
    .filter((line) => !line.endsWith(':'));

  return [
    "/no_think",
    "You are a concise voice assistant on a live phone call.",
    "Reply naturally to the caller\'s latest message in under 22 words.",
    "Do not use markdown. Do not explain the system. Do not say you are an AI model.",
    "If the caller asks for current weather and no live weather data is provided, say weather lookup is not wired in yet.",
    "",
    "Conversation so far:",
    lines.join("\n") || "Caller: Hello.",
    "",
    "Assistant:"
  ].join("\n");
}

function runOllama(prompt) {
  const model = process.env.GV_OLLAMA_MODEL || 'qwen3:4b';
  return new Promise((resolve, reject) => {
    const child = spawn('ollama', ['run', model, prompt], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error('ollama exited ' + code + ': ' + stderr));
    });
  });
}

function cleanReply(text) {
  return String(text || '')
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*\.\.\.done thinking\.\s*/i, '')
    .replace(/^Thinking\.\.\.[\s\S]*?(?=\n[A-Z][^\n]{0,260}$)/i, '')
    .replace(/^Assistant:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280) || 'I heard you, but I need a moment to answer that.';
}
