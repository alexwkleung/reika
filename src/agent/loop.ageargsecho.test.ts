import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, Message, Tool } from '../types.js';

// REIKA_AGE_ARGS: a model that copies a stub it can see into a new call would write the placeholder
// into a file. Driven through runTurn, since the refusal lives at the loop's dispatch.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');
const { agedArgEcho } = await import('../provider/toolcall.js');

const cwd = mkdtempSync(join(tmpdir(), 'reika-ageargsecho-'));
const STUB = '[412 chars, sent earlier]';

const config: Config = {
  baseURL: 'http://localhost',
  apiKey: 'x',
  model: 'test',
  models: ['test'],
  maxTurns: 10,
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

// An earlier round whose arguments batch aging already stubbed.
const servedStub: Message[] = [
  { role: 'user', content: 'start' },
  {
    role: 'assistant',
    content: '',
    argsAged: true,
    toolCalls: [{ id: 'old', name: 'write', args: { path: 'a.ts', content: 'x'.repeat(412) } }],
  },
  { role: 'tool', callId: 'old', summary: 'Wrote a.ts (+1)' },
];

async function run(history: Message[], writes: string[]) {
  const ran: string[] = [];
  const summaries: string[] = [];
  const write: Tool = {
    name: 'write',
    description: 'create a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async args => {
      ran.push(String(args.content));
      return { summary: `Wrote ${String(args.path)} (+1)` };
    },
  };
  h.scripted.length = 0;
  writes.forEach((content, n) =>
    h.scripted.push({
      content: '',
      toolCalls: [{ id: `w${n}`, name: 'write', args: { path: 'b.ts', content } }],
    }),
  );
  h.scripted.push({ content: 'done', toolCalls: undefined });
  await runTurn({
    userInput: 'go on',
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
    tools: [write],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => {
      if (m.role === 'tool') summaries.push(m.summary);
    },
  });
  return { ran, summaries };
}

describe('a copied argument stub (REIKA_AGE_ARGS)', () => {
  it('is not run, and the identical call sent again is', async () => {
    const content = `export const a = 1;\n${STUB}\n`;
    const { ran, summaries } = await run([...servedStub], [content, content]);
    expect(summaries[0]).toContain('not run');
    expect(ran).toEqual([content]);
  });

  it('runs a clean call after the refusal', async () => {
    const { ran } = await run([...servedStub], [STUB, 'export const a = 1;\n']);
    expect(ran).toEqual(['export const a = 1;\n']);
  });

  it('refuses nothing before a stub has been served', async () => {
    const { ran } = await run([], [STUB]);
    expect(ran).toEqual([STUB]);
  });
});

describe('agedArgEcho', () => {
  it('catches a copy that lost its count or its opening bracket', () => {
    expect(agedArgEcho({ new_string: STUB })).toBe(true);
    expect(agedArgEcho({ new_string: '[chars, sent earlier]' })).toBe(true);
    expect(agedArgEcho({ command: 'cat > f <<EOF\n412 chars, sent earlier]\nEOF' })).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(agedArgEcho({ new_string: 'we sent it earlier, 412 chars' })).toBe(false);
  });
});
