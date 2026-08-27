import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import { planTools } from '../tools/index.js';

// Drive the real runTurn loop in PLAN mode with the real plan tool set, so #109's guarantee is
// checked where it actually has to hold — at dispatch, against the filesystem — rather than only at
// the classifier. A refused command must leave no trace on disk.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

const bashResponse = (command: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'b1', name: 'bash', args: { command } }],
});

function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 4,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

describe('read-only bash in plan mode (integration, #109)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-planbash-'));
    await writeFile(join(cwd, 'target.txt'), 'untouched', 'utf8');
    h.scripted.length = 0;
    process.env.REIKA_PLAN_BASH = '1';
  });
  afterEach(async () => {
    delete process.env.REIKA_PLAN_BASH;
    await rm(cwd, { recursive: true, force: true });
  });

  async function run(command: string): Promise<Message[]> {
    const messages: Message[] = [];
    const bundle: ContextBundle = {
      projectSummary: '',
      repoMap: '',
      instructions: '',
      cwd,
      hash: 'test',
      fileIndex: [],
      ignore: ignore(),
      skills: [],
    };
    h.scripted.push(bashResponse(command), { content: 'plan', toolCalls: undefined });
    await runTurn({
      userInput: 'explore',
      history: [],
      bundle,
      config: makeConfig(),
      tools: planTools(),
      payloads: new PayloadStore(),
      promptMode: 'plan',
      onMessage: m => messages.push(m),
    });
    return messages;
  }

  const toolSummary = (messages: Message[]): string =>
    messages.find(m => m.role === 'tool')?.summary ?? '';

  it('runs a read-only command the plan needs', async () => {
    const messages = await run('cat target.txt | wc -c');
    expect(toolSummary(messages)).toMatch(/^Ran:/);
  });

  it('refuses a write and leaves the file untouched', async () => {
    const messages = await run('echo clobbered > target.txt');
    expect(toolSummary(messages)).toContain('Bash refused (read-only mode)');
    expect(await readFile(join(cwd, 'target.txt'), 'utf8')).toBe('untouched');
  });

  it('refuses a mutator smuggled past a read-only lead', async () => {
    const messages = await run('cat target.txt && rm target.txt');
    expect(toolSummary(messages)).toContain('Bash refused (read-only mode)');
    expect(await readFile(join(cwd, 'target.txt'), 'utf8')).toBe('untouched');
  });

  it('does not offer bash at all with the flag off', async () => {
    delete process.env.REIKA_PLAN_BASH;
    expect(planTools().map(t => t.name)).not.toContain('bash');
  });
});
