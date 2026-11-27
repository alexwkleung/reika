import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, Message, Tool } from '../types.js';

// A region re-read after each of its earlier copies was shed is recovery, not a loop. Driven
// through runTurn because "shed" is the loop's own batch aging: the payloads are sized so every
// read after the first pushes the request over the threshold and ages the one before it.

const h = vi.hoisted(() => {
  process.env.REIKA_PREFIX_STABLE = '1';
  return { scripted: [] as ModelResponse[] };
});
// The real call path freezes each payload's bytes when it is first sent; without that the
// fit-to-window cap sizes every payload to the room left and nothing ever needs shedding.
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { history: Message[] }) => {
    for (const m of opts.history)
      if (m.role === 'tool' && m.payload && !m.aged && m.rendered === undefined)
        m.rendered = `${m.summary}\n\n${m.payload}`;
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

const cwd = mkdtempSync(join(tmpdir(), 'reika-readdepth-'));
writeFileSync(join(cwd, 'big.ts'), 'export const a = 1;\n');

const stubRead: Tool = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async args => ({
    summary: `Read big.ts lines ${String(args.offset ?? 1)}-209 of 209`,
    payload: `${String(args.offset ?? 1)}:`.padEnd(14000, 'x'),
    contentHash: 'same',
  }),
};

// Lands an edit without touching the file, so only the progress signal moves, not the hash.
const stubEdit: Tool = {
  name: 'edit',
  description: 'edit a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async () => ({ summary: 'Edited big.ts' }),
};

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 30,
  repoMapBudget: 1000,
  autoApprove: 'bypass',
  subagentMaxTurns: 5,
  profiles: {},
  contextWindow: 9000,
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

// A step is a read [offset, limit] or 'edit'.
async function summaries(steps: Array<[number, number | undefined] | 'edit'>): Promise<Message[]> {
  h.scripted.length = 0;
  steps.forEach((step, n) =>
    h.scripted.push({
      content: '',
      toolCalls: [
        step === 'edit'
          ? { id: `e${n}`, name: 'edit', args: { path: 'big.ts' } }
          : {
              id: `r${n}`,
              name: 'read',
              args: { path: 'big.ts', offset: step[0], limit: step[1] },
            },
      ],
    }),
  );
  h.scripted.push({ content: 'done', toolCalls: undefined });
  const history: Message[] = [];
  await runTurn({
    userInput: 'fix the bug',
    history,
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
    tools: [stubRead, stubEdit],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: () => {},
  });
  return history;
}

// highlight.ts ~112-171 fetched four times on a 32k `/issue` turn, a shed before each re-fetch,
// then two more reads to give the ledger and the withdrawal their rounds.
const sequence: Array<[number, number | undefined]> = [
  [1, undefined],
  [121, 110],
  [111, 100],
  [112, 60],
  [120, 40],
  [130, 30],
];

describe('read depth skips copies the harness shed', () => {
  it('keeps inspection open when every earlier copy was aged', async () => {
    const history = await summaries(sequence);
    const tools = history.filter(m => m.role === 'tool');
    expect(tools.filter(m => m.aged).length).toBeGreaterThanOrEqual(3);
    expect(tools.map(m => m.summary).filter(s => /paused/.test(s))).toEqual([]);
  });
});

// The backstop: trimmed copies stop being free once the re-reads lead nowhere. Line ~130 is in
// every read below, so seven reads with no edit reach the no-progress depth and pause reading,
// and the same reads with an edit landing after the third do not.
describe('re-reads over trimmed copies with no edit in between', () => {
  const longer: Array<[number, number | undefined]> = [...sequence, [125, 20], [128, 10]];
  const paused = (history: Message[]) =>
    history.filter(m => m.role === 'tool' && /paused/.test(m.summary)).length;

  it('pauses reading when no edit lands', async () => {
    expect(paused(await summaries(longer))).toBeGreaterThan(0);
  });

  it('keeps reading open when an edit lands between passes', async () => {
    const withEdit = [...longer.slice(0, 3), 'edit' as const, ...longer.slice(3)];
    expect(paused(await summaries(withEdit))).toBe(0);
  });
});
