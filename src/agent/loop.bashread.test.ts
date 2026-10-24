import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, Message, Tool } from '../types.js';

// #801: a model that reads one unchanged file over and over through `bash` must reach the same
// ledger → withdrawal ladder a `read` loop does. The parser is unit-tested in bashread.test.ts; this
// pins the wiring, since a parser that is never called leaves every one of those tests green.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

const cwd = mkdtempSync(join(tmpdir(), 'reika-bashread-'));
for (const f of ['app.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']) {
  writeFileSync(join(cwd, f), `export const ${f[0]} = 1;\n`);
}

const stubBash: Tool = {
  name: 'bash',
  description: 'run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  run: async args => ({ summary: `Ran: ${String(args.command)}`, exitCode: 0 }),
};

const bashRound = (n: number, command: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: `b${n}`, name: 'bash', args: { command } }],
});

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 12,
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
  sandbox: false,
};

async function run(commands: string[]): Promise<string[]> {
  h.scripted.length = 0;
  commands.forEach((c, n) => h.scripted.push(bashRound(n, c)));
  h.scripted.push({ content: 'done', toolCalls: undefined });
  const messages: Message[] = [];
  await runTurn({
    userInput: 'fix the bug',
    history: [],
    bundle: {
      projectSummary: '',
      repoMap: '',
      instructions: '',
      cwd,
      hash: 'test',
      fileIndex: [],
      ignore: ignore(),
      skills: [],
    },
    config,
    tools: [stubBash],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => messages.push(m),
  });
  return messages.flatMap(m =>
    m.role === 'tool' && m.summary.startsWith('Ran:') ? [m.summary] : [],
  );
}

describe('shell reads feed the read-loop ladder (#801)', () => {
  it('withdraws inspection from a model cat-ing one unchanged file in varied spellings', async () => {
    const spellings = [
      'cat app.ts',
      'cat -n app.ts',
      `cat ${join(cwd, 'app.ts')}`,
      "sed -n '1,120p' app.ts",
      'head -n 50 app.ts',
      'cat app.ts',
    ];
    const ran = await run(spellings);
    expect(ran.length).toBeLessThan(spellings.length);
  });

  it('leaves reads of different files alone', async () => {
    const reads = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map(f => `cat ${f}`);
    expect(await run(reads)).toHaveLength(reads.length);
  });
});
