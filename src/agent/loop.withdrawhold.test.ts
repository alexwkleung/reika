import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, Tool } from '../types.js';

// #808: a withdrawal used to lift on the round after it began, because refused reads are not
// recorded and the loop left the recency window. The tool list then toggled every other round, each
// switch a full re-prefill. Driven through runTurn, since the hold lives in the loop's own state.
// Pinned to the baseline arm (REIKA_WITHDRAW_KEEP_TOOLS=0), the one where the list toggles at all.

const h = vi.hoisted(() => {
  process.env.REIKA_WITHDRAW_KEEP_TOOLS = '0';
  return { scripted: [] as ModelResponse[], offered: [] as string[][] };
});
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { tools: { name: string }[] }) => {
    h.offered.push(opts.tools.map(t => t.name));
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn, WITHDRAW_HOLD_ROUNDS } = await import('./loop.js');

const cwd = mkdtempSync(join(tmpdir(), 'reika-withdrawhold-'));
writeFileSync(join(cwd, 'app.ts'), 'export const a = 1;\n');

// `apply` stands for a command that changed the tree, the progress the hold waits for.
const stubBash: Tool = {
  name: 'bash',
  description: 'run a command',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
  run: async args =>
    String(args.command) === 'apply'
      ? {
          summary: 'Ran: apply',
          exitCode: 0,
          changes: {
            files: [{ path: 'app.ts', kind: 'modified', hunks: [], added: 1, removed: 1 }],
            more: 0,
          },
        }
      : { summary: `Ran: ${String(args.command)}`, exitCode: 0 },
};
const stubRead: Tool = {
  name: 'read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async () => ({ summary: 'Read app.ts', payload: 'export const a = 1;' }),
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

// One entry per model call: whether `read` was offered on it.
async function readOffered(commands: string[]): Promise<boolean[]> {
  h.scripted.length = 0;
  h.offered.length = 0;
  commands.forEach((command, n) =>
    h.scripted.push({ content: '', toolCalls: [{ id: `b${n}`, name: 'bash', args: { command } }] }),
  );
  h.scripted.push({ content: 'done', toolCalls: undefined });
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
    tools: [stubRead, stubBash],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: () => {},
  });
  return h.offered.map(names => names.includes('read'));
}

const loop = [
  'cat app.ts',
  'cat -n app.ts',
  `cat ${join(cwd, 'app.ts')}`,
  'cat app.ts',
  'cat -n app.ts',
];

describe('withdrawal holds until progress (#808)', () => {
  it('stays withdrawn while the model complies without changing anything, then lifts at the cap', async () => {
    const offered = await readOffered([
      ...loop,
      ...Array(WITHDRAW_HOLD_ROUNDS + 2).fill('npm test'),
    ]);
    const first = offered.indexOf(false);
    expect(first).toBeGreaterThan(0);
    // Withdrawn from its first round through the hold, with no lift in between.
    expect(offered.slice(first, first + WITHDRAW_HOLD_ROUNDS)).toEqual(
      Array(WITHDRAW_HOLD_ROUNDS).fill(false),
    );
    expect(offered[first + WITHDRAW_HOLD_ROUNDS]).toBe(true);
  });

  it('lifts on the round after a command changes the tree', async () => {
    const offered = await readOffered([...loop, 'npm test', 'apply', 'npm test']);
    const first = offered.indexOf(false);
    const applyCall = loop.length + 1;
    // The lift must come before the cap would end the hold, or it proves nothing about `apply`.
    expect(applyCall + 1).toBeLessThan(first + WITHDRAW_HOLD_ROUNDS);
    expect(offered.slice(first, applyCall + 1).every(o => !o)).toBe(true);
    expect(offered[applyCall + 1]).toBe(true);
  });
});
