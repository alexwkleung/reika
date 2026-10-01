import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import { writeTool } from '../tools/write.js';
import { bashTool } from '../tools/bash.js';
import type { PlanStep } from './plantrack.js';

// Drive the real runTurn loop with a scripted model to exercise the plan-progress flow end to end
// (#68/#71): seed from a planFinal message, check a step off on a successful write, bounce a turn
// that finishes with file-bearing steps unchecked, finish once they're done. No tsc shim on
// purpose — the typecheck gate fails open, isolating the plan gate.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

// PLAN_ALIGN is read at module load, so the flag must be set before loop.js is imported.
const PRIOR = process.env.REIKA_PLAN_ALIGN;
process.env.REIKA_PLAN_ALIGN = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_PLAN_ALIGN;
  else process.env.REIKA_PLAN_ALIGN = PRIOR;
});
const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

const finalResponse = (content = 'done'): ModelResponse => ({ content, toolCalls: undefined });
const writeResponse = (path: string, content: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'w1', name: 'write', args: { path, content } }],
});
const bashResponse = (command: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'b1', name: 'bash', args: { command } }],
});

const PLAN = [
  'The plan:',
  '1. Create `src/app.ts` with the entry point',
  '2. Create `src/lib.ts` with the helper',
  '3. Run the tests and verify',
].join('\n');

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
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

async function run(
  cwd: string,
  history: Message[],
): Promise<{ history: Message[]; messages: Message[]; snapshots: PlanStep[][] }> {
  const messages: Message[] = [];
  const snapshots: PlanStep[][] = [];
  await runTurn({
    userInput: 'execute the plan above',
    history,
    bundle: makeBundle(cwd),
    config: makeConfig(),
    tools: [writeTool, bashTool],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => messages.push(m),
    onPlanProgress: steps => snapshots.push(steps.map(s => ({ ...s }))),
  });
  return { history, messages, snapshots };
}

describe('plan progress tracking (integration)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-plantrack-'));
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('checks steps off on writes, bounces an early finish, and passes once steps are done', async () => {
    h.scripted.push(
      // round 1: step 1's file
      writeResponse('src/app.ts', 'export const app = 1;\n'),
      // round 2: declare done with step 2 unchecked — the gate should bounce
      finalResponse('all done'),
      // round 3: step 2's file
      writeResponse('src/lib.ts', 'export const lib = 1;\n'),
      // round 4: done — file-bearing steps checked, the pathless step 3 never gates
      finalResponse('done for real'),
    );
    const priorHistory: Message[] = [
      { role: 'user', content: 'plan the thing' },
      { role: 'assistant', content: PLAN, planFinal: true },
    ];

    const { history, messages, snapshots } = await run(cwd, priorHistory);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(4);
    // Seed snapshot (nothing done), then one snapshot per check-off.
    expect(snapshots[0].map(s => s.done)).toEqual([false, false, false]);
    expect(snapshots.at(-1)?.map(s => s.done)).toEqual([true, true, false]);
    // Persistent check-off receipts landed in the scrollback, AFTER the tool result they follow.
    const toolIdx = messages.findIndex(
      m => m.role === 'tool' && m.summary.startsWith('Wrote src/app.ts'),
    );
    const receiptIdx = messages.findIndex(
      m =>
        m.role === 'system' &&
        m.content.includes('Plan step 1: a file it names was edited (1/3 with evidence)'),
    );
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(receiptIdx).toBeGreaterThan(toolIdx);
    // The bounce carried the unfinished step back to the model as a user message…
    const sentBack = history.filter(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.includes('[ ] 2.'),
    );
    expect(sentBack).toHaveLength(1);
    // Harness-authored, not a turn boundary — the task-spec pin must not move on a bounce (#287).
    expect(sentBack[0].harness).toBe(true);
    // …with a warn notice for the human.
    expect(
      messages.some(m => m.role === 'system' && m.content.includes('Plan gate: step 2 unchecked')),
    ).toBe(true);
  });

  it('checks off via content when the plan names the wrong file, and via a successful command', async () => {
    // The observed transcript: the plan pinned a CSS change to the component file; the model
    // correctly edited the stylesheet. The step's quoted snippet in the write's diff checks it
    // off; the quoted command checks off on the exit-0 bash run. No gate bounce, no waiver.
    h.scripted.push(
      writeResponse('src/styles.css', '.item {\n  margin-bottom: 2px;\n}\n'),
      {
        content: '',
        toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'cd . && git --version' } }],
      },
      finalResponse('done'),
    );
    const priorHistory: Message[] = [
      { role: 'user', content: 'tighten the gap' },
      {
        role: 'assistant',
        content:
          '1. In `src/components/WorkspaceSelect.tsx`, set `margin-bottom: 2px`\n' +
          '2. Run `git --version` to verify',
        planFinal: true,
      },
    ];

    const { messages, snapshots } = await run(cwd, priorHistory);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(3);
    expect(snapshots.at(-1)?.map(s => s.done)).toEqual([true, true]);
    expect(
      messages.some(
        m =>
          m.role === 'system' &&
          m.content.includes(
            'an edit matched its quoted code (1/2 with evidence) — the plan names another file',
          ),
      ),
    ).toBe(true);
    expect(
      messages.some(
        m => m.role === 'system' && m.content.includes('Plan: all 2 steps have observed evidence'),
      ),
    ).toBe(true);
    // No bounce happened: everything was observed done.
    expect(messages.some(m => m.role === 'system' && m.content.includes('Plan gate'))).toBe(false);
  });

  it('checks a file step off when the shell is what wrote the file, and gates the turn', async () => {
    // The bash-only shape (#391's minimal mode, and any model that prefers a heredoc). A shell
    // write now counts as editing, so the done-gate applies to this turn — which means the file
    // steps have to be checkable off the tree diff, or the gate would bounce it every round with
    // no way out. Round 2 finishes early with step 2 pending and gets bounced; round 4 finishes.
    h.scripted.push(
      bashResponse("mkdir -p src && cat > src/app.ts <<'EOF'\nexport const app = 1;\nEOF"),
      finalResponse('all done'),
      bashResponse("cat > src/lib.ts <<'EOF'\nexport const lib = 1;\nEOF"),
      finalResponse('done for real'),
    );
    const priorHistory: Message[] = [
      { role: 'user', content: 'plan the thing' },
      { role: 'assistant', content: PLAN, planFinal: true },
    ];

    const { history, messages, snapshots } = await run(cwd, priorHistory);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(4);
    // Both file steps checked off by the shell writes; the pathless step 3 never gates.
    expect(snapshots.at(-1)?.map(s => s.done)).toEqual([true, true, false]);
    expect(
      messages.some(
        m =>
          m.role === 'system' &&
          m.content.includes('Plan step 1: a file it names was edited (1/3 with evidence)'),
      ),
    ).toBe(true);
    // The early finish was bounced — which only happens because the shell write set editingStarted.
    const sentBack = history.filter(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.includes('[ ] 2.'),
    );
    expect(sentBack).toHaveLength(1);
  });

  it('does not gate a turn whose shell commands changed nothing', async () => {
    // The other half: a read-only turn — a question about the plan, not an implementation pass —
    // must never be bounced, and `grep` is not an edit however many files it names.
    h.scripted.push(bashResponse('grep -rn app src || true'), finalResponse('had a look'));
    const priorHistory: Message[] = [
      { role: 'user', content: 'plan the thing' },
      { role: 'assistant', content: PLAN, planFinal: true },
    ];

    const { messages } = await run(cwd, priorHistory);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    expect(messages.some(m => m.role === 'system' && m.content.includes('Plan gate'))).toBe(false);
  });

  it('is a no-op on plan-less histories', async () => {
    h.scripted.push(finalResponse('nothing to track'));

    const { messages, snapshots } = await run(cwd, [{ role: 'user', content: 'hello' }]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(1);
    expect(snapshots).toHaveLength(0);
    expect(messages.some(m => m.role === 'system' && m.content.includes('Plan'))).toBe(false);
  });
});
