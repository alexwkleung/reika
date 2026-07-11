import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import { editTool } from '../tools/edit.js';
import { readTool } from '../tools/read.js';

// Drive the real runTurn loop with a scripted model to exercise the read-first gate end to end
// (#72): a blind edit during plan execution is withheld once with a read directive; a read (or a
// prior successful edit) grounds the path; a re-issued edit always runs (fail-open); plan-less
// turns are untouched. No tsc shim on purpose — the typecheck gate fails open, isolating the gate.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

// READ_FIRST (and PLAN_ALIGN, which must stay off so the plan done-gate can't interfere) are read
// at module load, so the env must be set before loop.js is imported.
const PRIOR_READ_FIRST = process.env.REIKA_READ_FIRST;
const PRIOR_PLAN_ALIGN = process.env.REIKA_PLAN_ALIGN;
process.env.REIKA_READ_FIRST = '1';
delete process.env.REIKA_PLAN_ALIGN;
afterAll(() => {
  if (PRIOR_READ_FIRST === undefined) delete process.env.REIKA_READ_FIRST;
  else process.env.REIKA_READ_FIRST = PRIOR_READ_FIRST;
  if (PRIOR_PLAN_ALIGN !== undefined) process.env.REIKA_PLAN_ALIGN = PRIOR_PLAN_ALIGN;
});
const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

const finalResponse = (content = 'done'): ModelResponse => ({ content, toolCalls: undefined });
const editResponse = (path: string, oldStr: string, newStr: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'e1', name: 'edit', args: { path, old_string: oldStr, new_string: newStr } }],
});
const readResponse = (path: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'r1', name: 'read', args: { path } }],
});

const PLAN = 'The plan:\n1. Edit `src/app.ts` to rename the constant';
const PLAN_HISTORY: Message[] = [
  { role: 'user', content: 'plan the rename' },
  { role: 'assistant', content: PLAN, planFinal: true },
];

function makeBundle(cwd: string): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd,
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

function makeConfig(): Config {
  return {
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
  };
}

async function run(cwd: string, history: Message[]): Promise<{ messages: Message[] }> {
  const messages: Message[] = [];
  await runTurn({
    userInput: 'execute the plan above',
    history,
    bundle: makeBundle(cwd),
    config: makeConfig(),
    tools: [readTool, editTool],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => messages.push(m),
  });
  return { messages };
}

describe('read-first gate (integration)', () => {
  let cwd: string;
  let app: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-readfirst-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    app = join(cwd, 'src', 'app.ts');
    await writeFile(app, 'export const app = 1;\n', 'utf8');
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('withholds a blind edit once, then applies it after the directed read', async () => {
    h.scripted.push(
      // round 1: blind edit — never read the file this turn. Withheld.
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      // round 2: the directed read grounds the path.
      readResponse('src/app.ts'),
      // round 3: re-issued edit applies.
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [...PLAN_HISTORY]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(4);
    const paused = messages.find(m => m.role === 'tool' && m.summary.startsWith('edit paused'));
    expect(paused).toBeDefined();
    expect(paused).toMatchObject({
      summary: 'edit paused — read src/app.ts first, then re-issue the edit',
    });
    if (paused?.role === 'tool') expect(paused.payload).toContain('NOT applied');
    // The withheld round changed nothing; the re-issued edit landed.
    expect(messages.some(m => m.role === 'tool' && m.summary.startsWith('Edited src/app.ts'))).toBe(
      true,
    );
    expect(await readFile(app, 'utf8')).toBe('export const renamed = 1;\n');
  });

  it('never bounces an edit whose file was read first', async () => {
    h.scripted.push(
      readResponse('src/app.ts'),
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [...PLAN_HISTORY]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(3);
    expect(messages.some(m => m.role === 'tool' && m.summary.startsWith('edit paused'))).toBe(
      false,
    );
    expect(await readFile(app, 'utf8')).toBe('export const renamed = 1;\n');
  });

  it('is fail-open: a re-issued edit runs as-is without the read', async () => {
    h.scripted.push(
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      // The model ignores the directive and re-issues the edit — it must apply.
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [...PLAN_HISTORY]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(3);
    expect(
      messages.filter(m => m.role === 'tool' && m.summary.startsWith('edit paused')),
    ).toHaveLength(1);
    expect(await readFile(app, 'utf8')).toBe('export const renamed = 1;\n');
  });

  it('does not gate plan-less turns', async () => {
    h.scripted.push(
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [{ role: 'user', content: 'rename the constant' }]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    expect(messages.some(m => m.role === 'tool' && m.summary.startsWith('edit paused'))).toBe(
      false,
    );
    expect(await readFile(app, 'utf8')).toBe('export const renamed = 1;\n');
  });
});
