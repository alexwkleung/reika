import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, Tool } from '../types.js';

// #867: under REIKA_WITHDRAW_KEEP_TOOLS the offered list never changes while inspection is
// withdrawn (each change is a full re-prefill), so the pause must hold at dispatch alone.

const h = vi.hoisted(() => {
  process.env.REIKA_WITHDRAW_KEEP_TOOLS = '1';
  return { scripted: [] as ModelResponse[], offered: [] as string[][] };
});
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { tools: { name: string }[] }) => {
    h.offered.push(opts.tools.map(t => t.name));
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const { runTurn } = await import('./loop.js');

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

const loop = [
  'cat app.ts',
  'cat -n app.ts',
  `cat ${join(cwd, 'app.ts')}`,
  'cat app.ts',
  'cat -n app.ts',
];

describe('withdrawal keeps the offered tools (#867)', () => {
  it('offers the same list every round and refuses a read at dispatch', async () => {
    h.scripted.length = 0;
    h.offered.length = 0;
    loop.forEach((command, n) =>
      h.scripted.push({
        content: '',
        toolCalls: [{ id: `b${n}`, name: 'bash', args: { command } }],
      }),
    );
    h.scripted.push({
      content: '',
      toolCalls: [{ id: 'r', name: 'read', args: { path: 'app.ts' } }],
    });
    h.scripted.push({ content: 'done', toolCalls: undefined });
    const summaries: string[] = [];
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
      onMessage: m => {
        if (m.role === 'tool') summaries.push(m.summary);
      },
    });
    expect(h.offered.length).toBe(loop.length + 2);
    expect(h.offered.every(names => names.join() === 'read,bash')).toBe(true);
    expect(summaries.at(-1)).toMatch(/^read paused/);
  });
});
