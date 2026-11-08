import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, EditFailure, Message, Tool, ToolResult } from '../types.js';

// The edit-recovery dead-end's grounded round is per failure: a landed edit clears it, so a later,
// unrelated diverged failure gets its own round instead of stopping the turn on its first attempt
// (observed: a second file's one-line import mismatch stopped a turn whose earlier failure had been
// grounded and fixed). Flags are read at loop.js import time. Read-first is pinned off so the fake
// edits are not bounced as blind; logit recovery off so the terminal makes no /tokenize request.
const PRIOR = {
  REIKA_REASONING_LOOP: process.env.REIKA_REASONING_LOOP,
  REIKA_LOGIT_RECOVERY: process.env.REIKA_LOGIT_RECOVERY,
  REIKA_READ_FIRST: process.env.REIKA_READ_FIRST,
  REIKA_PREFIX_STABLE: process.env.REIKA_PREFIX_STABLE,
};
process.env.REIKA_REASONING_LOOP = '1';
process.env.REIKA_LOGIT_RECOVERY = '0';
process.env.REIKA_READ_FIRST = '0';
process.env.REIKA_PREFIX_STABLE = '0';
afterAll(() => {
  for (const [k, v] of Object.entries(PRIOR)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn, buildEditRecoveryStopMessage } = await import('./loop.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd: tmpdir(),
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
    maxTurns: 30,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    contextWindow: 16384,
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
    typecheck: false,
  };
}

function diverged(path: string, line: number): EditFailure {
  return {
    kind: 'diverged',
    path,
    divergentLine: line,
    expected: 'import { a, b } from "./x.js";',
    actual: 'import { b } from "./x.js";',
    excerpt: `${line}\timport { b } from "./x.js";`,
  };
}

// The edit's outcome is chosen by the call's `path` arg: `ok` lands, anything else fails diverged.
const edit: Tool = {
  name: 'edit',
  description: 'edit a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: async (args): Promise<ToolResult> => {
    const path = String(args.path);
    if (path === 'ok.ts') return { summary: 'Edited ok.ts at line 1 (+1 -1)' };
    return {
      summary: `Edit failed: old_string not found in ${path}.`,
      editFailure: diverged(path, 9),
    };
  },
};

const RUMINATION =
  'I need to update the import in this file and then adjust the call site below it so that the ' +
  'new helper is used everywhere, and after that I will run the typecheck to confirm it compiles.';

let n = 0;
function round(path: string, reasoning = RUMINATION): ModelResponse {
  return {
    content: '',
    reasoning,
    toolCalls: [{ id: `c${n++}`, name: 'edit', args: { path } }],
  };
}

// `onGrounded` lets a script answer the grounded round the way the observed run did — by landing
// the edit — without hard-coding which round the ladder grounds on.
async function drive(
  onGrounded?: (receipt: string) => void,
): Promise<{ history: Message[]; receipts: string[] }> {
  const history: Message[] = [];
  const receipts: string[] = [];
  await runTurn({
    userInput: 'tokenize diffs per hunk',
    history,
    bundle: makeBundle(),
    config: makeConfig(),
    tools: [edit],
    payloads: new PayloadStore(),
    onMessage: m => {
      if (m.role !== 'system') return;
      receipts.push(m.content);
      if (m.content.startsWith('Recovering:')) onGrounded?.(m.content);
    },
    promptMode: 'agent',
  });
  return { history, receipts };
}

const grounded = (receipts: string[]) => receipts.filter(r => r.startsWith('Recovering:'));

describe('edit-recovery grounding is per failure', () => {
  beforeEach(() => {
    h.scripted.length = 0;
    n = 0;
  });

  it('a failure after a landed edit gets its own grounded round instead of an immediate stop', async () => {
    for (let i = 0; i < 8; i++) h.scripted.push(round('a.ts'));
    const fixed = (): ModelResponse => round('ok.ts', 'Copying the current line verbatim now.');
    const { history, receipts } = await drive(receipt => {
      if (receipt.includes('a.ts')) {
        // Grounded round fixes a.ts; then a new, unrelated failure starts looping on b.ts.
        h.scripted.length = 0;
        h.scripted.push(fixed());
        for (let i = 0; i < 8; i++) h.scripted.push(round('b.ts'));
      } else {
        h.scripted.length = 0;
        h.scripted.push(fixed(), { content: 'fixed b.ts too', toolCalls: undefined });
      }
    });

    const g = grounded(receipts);
    expect(g).toHaveLength(2);
    expect(g[0]).toContain('a.ts');
    expect(g[1]).toContain('b.ts');
    const last = history.at(-1) as { content: string };
    expect(last.content).not.toMatch(/didn't apply|kept trying/);
  });

  it('the same failure with no landed edit between still stops after one grounded round', async () => {
    for (let i = 0; i < 8; i++) h.scripted.push(round('a.ts'));

    const { history, receipts } = await drive();

    expect(grounded(receipts)).toHaveLength(1);
    const last = history.at(-1) as { content: string };
    expect(last.content).toContain("My edit to `a.ts` didn't apply: line 9 differs");
  });
});

describe('buildEditRecoveryStopMessage', () => {
  it('names the differing line for a diverged failure, without blaming the plan', () => {
    const msg = buildEditRecoveryStopMessage(diverged('src/ui/Approval.tsx', 9));
    expect(msg).toContain('`src/ui/Approval.tsx`');
    expect(msg).toContain('line 9 differs');
    expect(msg).toContain('the file has `import { b } from "./x.js";`');
    expect(msg).not.toContain("doesn't exist");
  });

  it('keeps the missing-target wording for an absent failure or none', () => {
    expect(buildEditRecoveryStopMessage({ kind: 'absent', path: 'a.ts' })).toContain(
      "isn't in the file",
    );
    expect(buildEditRecoveryStopMessage(undefined)).toContain('edit the file');
  });
});
