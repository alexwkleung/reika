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
// (#72): a blind edit is withheld once with a read directive; a live read grounds the path; a
// re-issued edit always runs (fail-open); and grounding expires with the read's payload, so a stale
// read no longer passes an edit through. No tsc shim on purpose — the typecheck gate fails open,
// isolating the gate.

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
const rangedReadResponse = (path: string, offset: number, limit: number): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'r1', name: 'read', args: { path, offset, limit } }],
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
    bashIdleMs: 5000,
    pasteFetch: false,
    skillAuto: false,
    anon: false,
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
    // A second real file, so a test that needs an intervening round can use a genuine successful
    // read rather than leaning on a failed one.
    await writeFile(join(cwd, 'src', 'other.ts'), 'export const other = 2;\n', 'utf8');
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

  it('gates plan-less turns too', async () => {
    h.scripted.push(
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      readResponse('src/app.ts'),
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [{ role: 'user', content: 'rename the constant' }]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(4);
    expect(messages.some(m => m.role === 'tool' && m.summary.startsWith('edit paused'))).toBe(true);
    expect(await readFile(app, 'utf8')).toBe('export const renamed = 1;\n');
  });

  // The regression: a read grounds its path only while its payload is still being sent. One
  // intervening round is enough to age it out, and the edit built from it is then a guess — which is
  // precisely the confabulation the gate exists to intercept.
  it('bounces an edit whose grounding read has aged out of the request', async () => {
    h.scripted.push(
      readResponse('src/app.ts'), // grounds app.ts
      readResponse('src/other.ts'), // displaces it: app.ts is summary-only from here
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      // Fail-open is unchanged: the re-issued edit applies without another read.
      editResponse('src/app.ts', 'export const app = 1;', 'export const renamed = 1;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [{ role: 'user', content: 'rename the constant' }]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(5);
    expect(
      messages.filter(m => m.role === 'tool' && m.summary.startsWith('edit paused')),
    ).toHaveLength(1);
    expect(await readFile(app, 'utf8')).toBe('export const renamed = 1;\n');
  });

  // An old_string matching nothing while the file's bytes are absent from context is confabulation.
  // The failure result is the only guaranteed-live slot in the request, so the bytes ride there.
  it('grounds an absent edit failure when the model has no live bytes for the file', async () => {
    h.scripted.push(
      // Round 1 is bounced by the gate; round 2 re-issues, runs, and misses entirely.
      editResponse('src/app.ts', 'export const missing = 2;', 'export const other = 3;'),
      editResponse('src/app.ts', 'export const missing = 2;', 'export const other = 3;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [{ role: 'user', content: 'rename the constant' }]);

    const failed = messages.find(m => m.role === 'tool' && m.summary.startsWith('Edit failed'));
    expect(failed).toBeDefined();
    if (failed?.role !== 'tool') throw new Error('expected a tool message');
    expect(failed.payload).toContain('not in your context');
    expect(failed.payload).toContain('written from memory');
    // Verbatim, copyable, correctly numbered — the bytes the retry must be built from.
    expect(failed.payload).toContain('1│export const app = 1;');
    expect(failed.payload).toMatch(/formatter/i);
    // Nothing applied; the file is untouched.
    expect(await readFile(app, 'utf8')).toBe('export const app = 1;\n');
  });

  it('leaves an absent failure alone when the file IS live in context', async () => {
    h.scripted.push(
      readResponse('src/app.ts'), // grounds the path, so nothing is bounced and nothing is re-sent
      editResponse('src/app.ts', 'export const missing = 2;', 'export const other = 3;'),
      finalResponse(),
    );

    const { messages } = await run(cwd, [{ role: 'user', content: 'rename the constant' }]);

    expect(messages.some(m => m.role === 'tool' && m.summary.startsWith('edit paused'))).toBe(
      false,
    );
    const failed = messages.find(m => m.role === 'tool' && m.summary.startsWith('Edit failed'));
    if (failed?.role !== 'tool') throw new Error('expected a tool message');
    // The model has the bytes and its old_string still matches nothing: the target genuinely is not
    // there, which is the original meaning of `absent`. Re-sending the file would teach it nothing.
    expect(failed.payload ?? '').not.toContain('not in your context');
  });

  // A live read of ONE region does not mean the model can see another. Grounding the whole path on a
  // partial read is what let a confabulated edit through unhelped (kimi-k3, msg 121: read 560-594,
  // invented a block at 607, got a bare failure).
  it('grounds a region the live read did not cover, even though the file is grounded', async () => {
    await writeFile(
      join(cwd, 'src', 'wide.ts'),
      [
        'export const header = 1;',
        'export const alpha = 2;',
        'export const beta = 3;',
        'export function handler(name: string) {',
        '  const pendingShell = null;',
        '  const approvals = { approved: 0 };',
        '  return pendingShell ?? approvals;',
        '}',
      ].join('\n') + '\n',
      'utf8',
    );
    h.scripted.push(
      // Reads the top of the file only — enough to ground the path, nowhere near the handler.
      rangedReadResponse('src/wide.ts', 1, 3),
      // Edits the handler from memory: right vocabulary, wrong bytes.
      editResponse(
        'src/wide.ts',
        '  const pendingShell = undefined;\n  const approvals = { approved: 1 };',
        '  const pendingShell = undefined;\n  const approvals = { approved: 2 };',
      ),
      finalResponse(),
    );

    const { messages } = await run(cwd, [{ role: 'user', content: 'update the handler' }]);

    // Not bounced: the path IS grounded, which is correct for the gate and beside the point here.
    expect(messages.some(m => m.role === 'tool' && m.summary.startsWith('edit paused'))).toBe(
      false,
    );
    const failed = messages.find(m => m.role === 'tool' && m.summary.startsWith('Edit failed'));
    if (failed?.role !== 'tool') throw new Error('expected a tool message');
    expect(failed.payload).toContain('not in your context');
    // Handed the region it actually meant, not the region it happened to have read.
    expect(failed.payload).toContain('const approvals = { approved: 0 };');
    expect(failed.payload).not.toContain('export const alpha');
  });
});
