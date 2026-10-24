import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// Hashes the whole file, as read.ts does, so it shares the bash read's file entry.
const stubRead: Tool = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async args => {
    const text = readFileSync(join(cwd, String(args.path)), 'utf8');
    return {
      summary: `Read ${String(args.path)}`,
      payload: text,
      contentHash: createHash('sha1').update(text).digest('hex'),
    };
  },
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

// A string is a bash command; an object is any other call.
type Round = string | { name: string; args: Record<string, unknown> };

async function run(rounds: Round[]): Promise<string[]> {
  h.scripted.length = 0;
  rounds.forEach((r, n) =>
    h.scripted.push(
      typeof r === 'string'
        ? bashRound(n, r)
        : { content: '', toolCalls: [{ id: `c${n}`, name: r.name, args: r.args }] },
    ),
  );
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
    tools: [stubBash, stubRead],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => messages.push(m),
  });
  return messages.flatMap(m =>
    m.role === 'tool' && /^(Ran:|Read )/.test(m.summary) ? [m.summary] : [],
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

  // #810: the observed run anchored every command with `cd <project> &&`, and paged with head | tail.
  it('withdraws inspection when every read is behind a leading cd', async () => {
    const spellings = [
      `cd ${cwd} && cat app.ts`,
      `cd ${cwd} && cat -n app.ts`,
      `cd ${cwd} && head -n 100 app.ts | tail -n 100`,
      `cd ${cwd} && cat app.ts`,
      `cd ${cwd} && cat -n app.ts`,
      `cd ${cwd} && cat app.ts`,
    ];
    const ran = await run(spellings);
    expect(ran.length).toBeLessThan(spellings.length);
  });

  // #812: bash output never grounds an edit (#72), so `read` after a shell read is what the gate
  // asks for. Counted as a repeat, it confirmed a live loop and the next round's read was refused.
  it('does not count the read that re-grounds a shell read as a repeat', async () => {
    const ran = await run([
      `cd ${cwd} && sed -n '1,1p' app.ts`,
      { name: 'read', args: { path: 'app.ts', offset: 1, limit: 1 } },
      'true',
      { name: 'read', args: { path: 'b.ts' } },
    ]);
    expect(ran).toContain('Read b.ts');
  });

  it('still catches a loop that keeps reading after the re-grounding read', async () => {
    const read = { name: 'read', args: { path: 'app.ts', offset: 1, limit: 1 } };
    const ran = await run([`sed -n '1,1p' app.ts`, read, read, read, read, read]);
    expect(ran.filter(s => s === 'Read app.ts').length).toBeLessThan(5);
  });

  it('leaves reads of different files alone', async () => {
    const reads = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map(f => `cat ${f}`);
    expect(await run(reads)).toHaveLength(reads.length);
  });
});
