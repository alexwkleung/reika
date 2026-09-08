import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

type UserMessage = Extract<Message, { role: 'user' }>;
const isNudge = (m: Message): m is UserMessage =>
  m.role === 'user' && m.content.includes('cut off');

// Drive the real runTurn loop with a scripted model to exercise truncation continuation end to end
// (#284): a healthy block cut off mid-thought comes back as a carried tail plus a resume nudge, and
// a verbatim-degenerate one still falls through to the old discard-and-retry. The distinction is the
// repetition ratio, not which cut fired.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

// CONTINUE is read at module load, so the env must be set before loop.js is imported.
const PRIOR = process.env.REIKA_CONTINUE;
process.env.REIKA_CONTINUE = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_CONTINUE;
  else process.env.REIKA_CONTINUE = PRIOR;
});
const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

// Long, distinct prose — healthy reasoning keeps selfRepeatRatio near zero.
function healthy(n = 120): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      `step ${i}: the line at index ${i} ends at offset ${i * 7}, so the previous line starts ` +
        `after the newline at ${i * 7 - 1} and the walk continues from there to candidate ${i + 1}`,
    );
  }
  return out.join('\n');
}

// The Layer-1 verbatim signature: one sentence, over and over, past the length where it can be judged.
function degenerate(n = 120): string {
  const line = 'the previous line starts at the index after the newline that terminates it';
  return Array.from({ length: n }, () => line).join('\n');
}

const truncated = (reasoning: string): ModelResponse => ({
  content: '',
  reasoning,
  finishReason: 'length',
  toolCalls: undefined,
});

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
    pasteFetch: false,
    skillAuto: false,
    anon: false,
  };
}

async function run(cwd: string): Promise<{ history: Message[]; messages: Message[] }> {
  const history: Message[] = [];
  const messages: Message[] = [];
  await runTurn({
    userInput: 'work through the problem',
    history,
    bundle: makeBundle(cwd),
    config: makeConfig(),
    tools: [],
    payloads: new PayloadStore(),
    promptMode: 'agent',
    onMessage: m => messages.push(m),
  });
  return { history, messages };
}

describe('truncation continuation (integration)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-continue-'));
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('carries a healthy cut-off block forward instead of restarting', async () => {
    h.scripted.push(truncated(healthy()), { content: 'done', toolCalls: undefined });
    const { history, messages } = await run(cwd);

    // The partial rides in `content`, not `reasoning` — a chat template renders prior-turn
    // reasoning_content as nothing, which is why the old retry lost the work.
    const carried = history.find(m => m.role === 'assistant' && m.continuationTail);
    expect(carried).toBeDefined();
    expect(carried?.role === 'assistant' && carried.content).toContain('candidate 120');
    expect(carried?.role === 'assistant' && carried.reasoning).toBeUndefined();

    // The nudge resumes rather than restarts, and forbids re-running tools — the observed failure
    // re-ran the same commands and put identical payloads in context twice.
    const nudge = history.find(isNudge);
    expect(nudge?.content).toContain('continue from that exact point');
    expect(nudge?.content).toContain('do not re-run tools you have already called');
    expect(nudge?.content).not.toContain('concisely');

    expect(
      messages.some(m => m.role === 'system' && m.content.includes('continuing from where')),
    ).toBe(true);
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
  });

  it('trims an oversized block but keeps its end, marking what was dropped', async () => {
    h.scripted.push(truncated(healthy(400)), { content: 'done', toolCalls: undefined });
    const { history } = await run(cwd);

    const carried = history.find(m => m.role === 'assistant' && m.continuationTail);
    const text = carried?.role === 'assistant' ? (carried.content ?? '') : '';
    expect(text).toContain('trimmed to fit');
    // The END survives — that is where a truncated block's conclusion sits, and it is the anchor the
    // nudge tells the model to resume from.
    expect(text.trimEnd().endsWith('candidate 400')).toBe(true);
    // The beginning does not.
    expect(text).not.toContain('step 0:');
  });

  it('still discards a verbatim-degenerate block rather than feeding it back', async () => {
    h.scripted.push(truncated(degenerate()), { content: 'done', toolCalls: undefined });
    const { history, messages } = await run(cwd);

    expect(history.some(m => m.role === 'assistant' && m.continuationTail)).toBe(false);
    // Falls through to the pre-existing retry, which is correct for a genuine death loop: re-feeding
    // a spiral its own text is what makes it worse.
    const nudge = history.find(isNudge);
    expect(nudge?.content).toContain('concisely');
    expect(messages.some(m => m.role === 'system' && m.content.includes('retrying'))).toBe(true);
  });
});
