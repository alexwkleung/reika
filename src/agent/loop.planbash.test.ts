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

const { runTurn, buildSteadySystem } = await import('./loop.js');
const { distillPlanHandoff } = await import('./compaction.js');
const { seedPlanProgress } = await import('./plantrack.js');

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

// The convergence machinery has to SEE bash exploration, or plan mode gets worse the moment the flag
// is on: the ledger drives the stop-exploring pressure and the handoff digest is what the agent turn
// inherits. Both indexed exploration by `path`/`pattern`, which a bash call carries neither of.
describe('bash exploration is visible to plan-mode convergence (#109)', () => {
  const bashCall = (command: string): Message => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'b1', name: 'bash', args: { command } }],
  });

  const planLedgerFor = (history: Message[]): string =>
    buildSteadySystem({
      baseSystem: 'BASE',
      promptMode: 'plan',
      history,
      round: 1,
      planSteps: null,
    });

  it('counts a bash command as exploration in the plan ledger', () => {
    const ledger = planLedgerFor([bashCall('grep -rn planTools src | head -20')]);
    expect(ledger).toContain('Commands run: grep -rn planTools src | head -20');
  });

  // The specific misbehaviour: a model that had just read half the repo through bash was told it had
  // examined nothing, which is both false and an instruction to go re-explore.
  it('does not claim nothing was examined after a bash-only exploration', () => {
    const ledger = planLedgerFor([bashCall('cat src/tools/index.ts')]);
    expect(ledger).not.toContain('Nothing examined yet');
  });

  // The round-1/2 convergence nudge keys on having examined something. Bash-only exploration used to
  // skip it entirely, so the mode lost its early stop signal exactly when the new tool was used.
  it('fires the early stop-exploring nudge on bash-only exploration', () => {
    expect(planLedgerFor([bashCall('wc -l src/agent/loop.ts')])).toContain('STOP exploring');
  });

  it('still says nothing was examined when truly nothing was', () => {
    expect(planLedgerFor([])).toContain('Nothing examined yet');
  });

  // distillPlanHandoff folds the span in place and returns an outcome, so the assertion is on the
  // digest it leaves behind — what the agent turn actually inherits.
  it('carries bash exploration into the plan→agent handoff digest', () => {
    const history: Message[] = [
      { role: 'user', content: 'add a flag' },
      bashCall('grep -rn REIKA_PLAN src | head'),
      { role: 'tool', callId: 'b1', summary: 'Ran: grep -rn REIKA_PLAN src | head' },
      {
        role: 'assistant',
        content: '1. Edit `src/tools/index.ts` to register the tool.',
        planFinal: true,
      },
    ];
    const outcome = distillPlanHandoff(history, 16384);
    expect(outcome.reason).toBe('folded');
    const digest = history.find(m => m.role === 'compaction')?.content ?? '';
    expect(digest).toContain('Commands run: grep -rn REIKA_PLAN src | head');
  });
});

// A refusal must not read as a completed step. The refusal message quotes the command back, so a
// plan step naming that same command is exactly where a sloppy match would wrongly check off — and a
// falsely checked step is worse than an unchecked one, since PLAN_ALIGN's done-gate trusts it.
describe('a refused command never checks off a plan step (#109 × #200)', () => {
  it('leaves the step pending when the refusal quotes its command', () => {
    const history: Message[] = [
      { role: 'assistant', content: '1. Run `npm run build` to verify.', planFinal: true },
      {
        role: 'tool',
        callId: 'c1',
        summary:
          'Bash refused (read-only mode): npm run build. It could write or run something off the ' +
          'read-only list. Use read/grep/glob/list, or rewrite it as a read-only pipeline.',
      },
    ];
    const steps = seedPlanProgress(history);
    expect(steps).not.toBeNull();
    expect(steps?.[0].done).toBe(false);
  });

  it('checks the step off when the command actually ran', () => {
    const history: Message[] = [
      { role: 'assistant', content: '1. Run `npm run build` to verify.', planFinal: true },
      {
        role: 'tool',
        callId: 'c1',
        summary: 'Ran: npm run build',
        command: { text: 'npm run build', outputTail: '', outputTruncated: false },
        exitCode: 0,
      },
    ];
    expect(seedPlanProgress(history)?.[0].done).toBe(true);
  });
});
