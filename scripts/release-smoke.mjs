#!/usr/bin/env node
// One headless turn through an installed reika against a mock model server: a tool call, then a
// reply, with a pasted URL fetched on the way. release-check's import pass proves the bundle loads;
// this proves it runs, which is where a bundling fault in a lazily loaded dependency shows.
// Usage: release-smoke.mjs <path to reika bin> <cwd> <home>
import { spawn } from 'node:child_process';
import http from 'node:http';

const [bin, cwd, home] = process.argv.slice(2);
// No underscores: the extractor emits markdown and would escape them.
const MARKER = 'smokepagemarker7731';
const REPLY = 'smoke reply ok';
const seen = { page: false, tool: false };

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.end('data: [DONE]\n\n');
};

const server = http.createServer((req, res) => {
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' });
    const body = `The page text carries ${MARKER} for the extractor. `.repeat(12);
    res.end(
      `<html><head><title>Smoke</title></head><body><article><h1>Smoke</h1><p>${body}</p></article></body></html>`,
    );
    return;
  }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let messages = [];
    try {
      messages = JSON.parse(raw).messages ?? [];
    } catch {}
    if (req.url !== '/v1/chat/completions' || messages.length === 0) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const text = JSON.stringify(messages);
    // Dispatched on the body: probe requests carry neither the prompt's page nor a tool result.
    if (!text.includes(MARKER)) {
      sse(res, [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
      return;
    }
    seen.page = true;
    if (messages.some(m => m.role === 'tool')) {
      seen.tool = text.includes('smoke-tool-output');
      sse(res, [
        { choices: [{ index: 0, delta: { role: 'assistant', content: REPLY } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]);
      return;
    }
    const call = {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'echo smoke-tool-output' }) },
    };
    sse(res, [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const child = spawn(bin, ['-p', `read ${origin}/page`], {
  cwd,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    TERM: 'dumb',
    REIKA_MODEL: 'smoke',
    REIKA_BASE_URL: `${origin}/v1`,
    REIKA_AUTO_APPROVE: 'bypass',
    REIKA_PASTE_FETCH: 'apply',
    REIKA_AUTOSAVE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', c => (stdout += c));
child.stderr.on('data', c => (stderr += c));
const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
const code = await new Promise(resolve => child.on('close', resolve));
clearTimeout(timer);
server.close();

const problems = [];
if (code !== 0) problems.push(`exit status ${code}`);
if (!seen.page) problems.push('the fetched page never reached the model (page extractor)');
if (!seen.tool) problems.push('the bash result never reached the model');
if (!stdout.includes(REPLY)) problems.push('the reply was not printed');
if (problems.length) {
  console.error(`${problems.join('\n')}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
  process.exit(1);
}
console.log('headless turn ok: page fetched, tool ran, reply printed');
