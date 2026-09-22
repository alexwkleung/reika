import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import { bashTool } from '../tools/bash.js';

// Drive the real runTurn loop, in bypass, through the real bash tool (#163). The unit tests in
// tools/bash.test.ts pin the decision; this pins that the DECISION reaches the process — a sandbox
// the tool computes and the loop drops on the floor would pass every test in that file.
//
// Bypass is the configuration the issue is about: autonomous runs, no prompts. It is also the one
// where `detectDangerousPatterns` used to never run, because it sat inside `if (ctx.requestApproval)`.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

const bashResponse = (command: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'b1', name: 'bash', args: { command } }],
});

function makeConfig(sandbox: boolean): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 3,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    bashIdleMs: 5000,
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox,
  };
}

async function run(cwd: string, sandbox: boolean, command: string): Promise<Message[]> {
  const messages: Message[] = [];
  h.scripted.push(bashResponse(command), { content: 'done', toolCalls: undefined });
  await runTurn({
    userInput: 'do it',
    history: [],
    bundle: { cwd, ignore: undefined } as unknown as ContextBundle,
    config: makeConfig(sandbox),
    tools: [bashTool],
    payloads: new PayloadStore(),
    onMessage: m => messages.push(m),
  });
  return messages;
}

describe('sandbox reaches the process, through the real loop (#163)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-sandbox-loop-'));
    h.scripted.length = 0;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const toolMsg = (messages: Message[]) =>
    messages.find(m => m.role === 'tool') as Extract<Message, { role: 'tool' }> | undefined;

  it.skipIf(process.platform !== 'darwin')(
    'confines an auto-approved command to cwd in bypass, and says it did',
    async () => {
      // Temp dirs are writable by design (a model's scratchpad), so the outside target is home.
      const outside = join(homedir(), 'reika-should-not-exist.txt');
      const messages = await run(cwd, true, `echo x > ${outside}; echo wrote`);
      const tool = toolMsg(messages);
      expect(tool?.payload).toContain('Operation not permitted');
      await expect(readFile(outside, 'utf8')).rejects.toThrow();
      // The user-facing receipt, once per cwd — a fresh tmpdir here, so this run carries it.
      expect(
        messages.some(
          m => m.role === 'system' && m.content.includes('Shell commands run sandboxed'),
        ),
      ).toBe(true);
    },
  );

  it('is a no-op under REIKA_SANDBOX=0 — the same command writes', async () => {
    const target = join(cwd, 'plain.txt');
    const messages = await run(cwd, false, `echo x > ${target}; echo wrote`);
    expect(await readFile(target, 'utf8')).toBe('x\n');
    expect(messages.some(m => m.role === 'system' && m.content.includes('sandboxed'))).toBe(false);
  });

  // The two halves are independent, and this is the half a broad cwd keeps. Network denial has
  // nothing to do with WORKDIR, so it holds even where the filesystem guarantee is weakest.
  it.skipIf(process.platform !== 'darwin')('denies network egress in bypass', async () => {
    const messages = await run(cwd, true, 'curl -s -m 3 https://example.com');
    const tool = toolMsg(messages);
    // `curl -s` suppresses the diagnosis as well: the payload is literally `(no output)`, which is
    // the shape that strands a model — the footer is what carries the explanation, and only the
    // exit status (rc 6 = could not resolve host) says anything at all.
    expect(tool?.payload).toContain('local sandbox');
    expect(tool?.payload).toContain('Network access is denied');
    // This turn offers bash alone (minimal mode's shape), so the footer must not route to a tool
    // the model does not have — the loop's `toolNames` is what tells it so (#377).
    expect(tool?.payload).not.toContain('fetch_url');
    expect(tool?.payload).toContain('ask the user');
  });

  // The footer is gated on the output carrying a denial's signature and on the exit being non-zero
  // — a red test run under the sandbox must not collect network advice. Same reason
  // `curl …; echo "rc=$?"` gets none: that pipeline exits 0, because the last command succeeded.
  it.skipIf(process.platform !== 'darwin')('leaves a non-network failure alone', async () => {
    const messages = await run(cwd, true, 'node -e "process.exit(1)"');
    const tool = toolMsg(messages);
    expect(tool?.payload ?? '').not.toContain('Network access is denied');
  });
});
