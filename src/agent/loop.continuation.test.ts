import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';
import { taskSpecIndex } from '../provider/toolcall.js';

type UserMessage = Extract<Message, { role: 'user' }>;
const isNudge = (m: Message): m is UserMessage =>
  m.role === 'user' && m.content.includes('cut off');

// Drive the real runTurn loop with a scripted model to exercise truncation continuation end to end
// (#284): a healthy block cut off mid-thought comes back as a carried tail plus a resume nudge, and
// a verbatim-degenerate one still falls through to the old discard-and-retry. The distinction is the
// repetition ratio, not which cut fired.

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  // Reasoning to stream through onReasoningDelta before answering, so a test can drive the
  // mid-stream length ceiling the same way a real generation would.
  stream: [] as string[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onReasoningDelta?: (t: string) => void }) => {
    const chunk = h.stream.shift();
    if (chunk) {
      // Chunks larger than REASONING_SPIN_DEBOUNCE (400) so the ceiling check actually runs.
      for (let i = 0; i < chunk.length; i += 1000)
        opts.onReasoningDelta?.(chunk.slice(i, i + 1000));
    }
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

// CONTINUE is read at module load, so the env must be set before loop.js is imported.
const PRIOR = process.env.REIKA_CONTINUE;
const PRIOR_ABORT = process.env.REIKA_VERBATIM_ABORT;
process.env.REIKA_CONTINUE = '1';
process.env.REIKA_VERBATIM_ABORT = '1';
afterAll(() => {
  if (PRIOR === undefined) delete process.env.REIKA_CONTINUE;
  else process.env.REIKA_CONTINUE = PRIOR;
  if (PRIOR_ABORT === undefined) delete process.env.REIKA_VERBATIM_ABORT;
  else process.env.REIKA_VERBATIM_ABORT = PRIOR_ABORT;
});
const { runTurn } = await import('./loop.js');
const { CONTINUATION_SHED_NOTE: SHED_NOTE } = await import('./compaction.js');
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

// A model with no reasoning channel — or one whose reasoning the dialect handling strips — puts the
// whole thought in `content`. The trace already supports this as a fallback channel.
const truncatedContent = (content: string, reasoning?: string): ModelResponse => ({
  content,
  reasoning,
  finishReason: 'length',
  toolCalls: undefined,
});

// Short, distinct prose: under CONTINUATION_TAIL_CHARS, so a continuation round built from it
// overlaps the tail it resumes (the condition the eager shed is gated on).
function shortHealthy(n = 25): string {
  return Array.from(
    { length: n },
    (_, i) => `recheck ${i}: offset ${i * 11} maps to column ${i % 7} on the line that follows it`,
  ).join('\n');
}

const liveTails = (history: Message[]): Message[] =>
  history.filter(m => m.role === 'assistant' && m.continuationTail && m.content !== SHED_NOTE);

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
    h.stream.length = 0;
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
    // The retry nudge is the fallback for this very feature — it runs on a refused carry and
    // whenever REIKA_CONTINUE is off — so it is not a turn boundary either (#287). Unflagged, the
    // spec pin it moves is the one the continuation exists to protect.
    expect(nudge?.harness).toBe(true);
  });

  it('carries a block cut by the LENGTH ceiling, not just one cut by the token wall', async () => {
    // REASONING_HARD_CEIL (32000 chars) fires on length ALONE — `ratio >= abortAt || tooLong` — so
    // before #284 a long but coherent thought crossing it was discarded exactly like a spiral and
    // told "your reasoning was repeating the same text". On the measured run the token wall landed
    // 1,730 chars (5.4%) short of this ceiling, so which cut won was near-arbitrary; two cuts that
    // close cannot carry opposite semantics. Healthy prose, well past the ceiling.
    h.stream.push(healthy(600));
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: 'done', toolCalls: undefined },
    );
    const { history, messages } = await run(cwd);

    const carried = history.find(m => m.role === 'assistant' && m.continuationTail);
    expect(carried).toBeDefined();
    expect(history.find(isNudge)?.content).toContain('continue from that exact point');
    expect(messages.some(m => m.role === 'system' && m.content.includes('length ceiling'))).toBe(
      true,
    );
    // The false diagnosis is gone: this block was never repeating.
    expect(messages.some(m => m.role === 'system' && m.content.includes('repeating itself'))).toBe(
      false,
    );

    // The thinking the user watched stream is committed to scrollback, ahead of the notice. The
    // live preview is hidden at the cut, so without this up to REASONING_HARD_CEIL of CARRIED
    // reasoning would vanish from the transcript with only the notice left behind.
    const thinkingAt = messages.findIndex(
      m => m.role === 'assistant' && m.reasoning?.includes('candidate 600'),
    );
    const noticeAt = messages.findIndex(
      m => m.role === 'system' && m.content.includes('length ceiling'),
    );
    expect(thinkingAt).toBeGreaterThanOrEqual(0);
    expect(thinkingAt).toBeLessThan(noticeAt);
  });

  it('still discards a ceiling cut when the block IS degenerate', async () => {
    // Same ceiling, opposite content: here the ratio agrees with the cut, so the old discard-and-
    // recover path is correct and must survive.
    h.stream.push(degenerate(600));
    h.scripted.push(
      { content: '', toolCalls: undefined },
      { content: 'done', toolCalls: undefined },
    );
    const { history, messages } = await run(cwd);

    expect(history.some(m => m.role === 'assistant' && m.continuationTail)).toBe(false);
    expect(messages.some(m => m.role === 'system' && m.content.includes('repeating itself'))).toBe(
      true,
    );
    // A DISCARDED block is not committed to scrollback: it was never carried, and the recovery
    // notice would be buried under it. That is what onReasoningReset exists for on this path.
    expect(messages.some(m => m.role === 'assistant' && m.reasoning)).toBe(false);
    // The recovery nudge fires on a cut reasoning stream — exactly when the task spec matters most
    // — so it must not read as a turn boundary (#287).
    const recovery = history.find(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.includes('repeating the same text'),
    );
    expect(recovery?.harness).toBe(true);
  });

  it('carries a block that arrived in the CONTENT channel', async () => {
    // A model with no reasoning channel puts the whole thought in `content`. Carrying only
    // `reasoning` gave it an empty assistant message under a nudge asserting "the text above is your
    // own work — it ends mid-thought", which is a pointer to nothing.
    h.scripted.push(truncatedContent(healthy()), { content: 'done', toolCalls: undefined });
    const { history } = await run(cwd);

    const carried = history.find(m => m.role === 'assistant' && m.continuationTail);
    const text = carried?.role === 'assistant' ? carried.content : '';
    expect(text.trim()).not.toBe('');
    expect(text).toContain('candidate 120');
    expect(history.find(isNudge)).toBeDefined();
  });

  it('carries content that followed reasoning, ending on the newest text', async () => {
    // Mixed round: the model reasoned, started answering, and was cut. Content came LAST, so it is
    // the resume anchor the nudge points at — and before this it was dropped from history entirely.
    const answer = 'so the fix is to clamp pos to lineStart rather than to the newline before it';
    h.scripted.push(truncatedContent(answer, shortHealthy()), {
      content: 'done',
      toolCalls: undefined,
    });
    const { history } = await run(cwd);

    const carried = history.find(m => m.role === 'assistant' && m.continuationTail);
    const text = carried?.role === 'assistant' ? carried.content : '';
    expect(text).toContain('recheck 0:');
    expect(text.trimEnd().endsWith(answer)).toBe(true);
  });

  it("leaves both tails resident — shedding is compaction's job, not the carry's", async () => {
    // Each carry cuts a fresh window over the same block, so a short continuation round leaves two
    // near-identical tails in history. Shedding the older one at carry time was tried and reverted:
    // rewriting a mid-history assistant message diverged the prefix cache (`cause=mid-history`,
    // 1785 and 2358 tokens reprocessed against an append-only round's 67) to reclaim window that
    // was not under pressure. Compaction's pre-pass sheds them when a shrink is already rewriting
    // those bytes — see compaction.continuation.test.ts.
    h.scripted.push(truncated(healthy()), truncated(shortHealthy()), {
      content: 'done',
      toolCalls: undefined,
    });
    const { history } = await run(cwd);

    expect(liveTails(history)).toHaveLength(2);
    // The newer tail still holds BOTH halves of the split thought, so nothing is lost by keeping
    // the older one around until the sweep runs.
    const newest = liveTails(history)[1];
    const text = newest.role === 'assistant' ? newest.content : '';
    expect(text).toContain('candidate 120');
    expect(
      text
        .trimEnd()
        .endsWith('recheck 24: offset 264 maps to column 3 on the line that follows it'),
    ).toBe(true);
  });

  it('joins a ceiling cut onto a block already held, rather than replacing it', async () => {
    // A ceiling cut can land on a round that is ITSELF a continuation. Carrying only the new half
    // dropped the first from the tail and from the trace, while leaving its message outside
    // `protect` and shed-eligible. Observable in the trim count: the trimmed head can only exceed
    // the first block's length if the two were joined.
    const first = shortHealthy(20);
    h.stream.push('', healthy(600));
    h.scripted.push(
      truncated(first),
      { content: '', toolCalls: undefined },
      { content: 'done', toolCalls: undefined },
    );
    const { messages } = await run(cwd);

    const notice = messages
      .filter((m): m is Extract<Message, { role: 'system' }> => m.role === 'system')
      .find(m => m.content.includes('length ceiling'));
    const trimmed = Number(/\((\d+) chars/.exec(notice?.content ?? '')?.[1] ?? 0);
    expect(trimmed).toBeGreaterThan(first.length);
  });

  it('does not move the task-spec pin — the nudge is not a turn boundary', async () => {
    // Regression from the first live arm: the nudge is role 'user' (it must reach the model, so it
    // cannot be `meta`), and taskSpecIndex elects the first tool payload after the newest real user
    // message. Every continuation therefore re-elected the spec to whatever landed next — measured
    // moving off `gh issue view 244` onto a 126-char grep result and then a 47-char heredoc echo,
    // exactly two rounds after each nudge, after which the model correctly re-fetched the issue.
    // That is the #251/#252 cascade continuation exists to prevent.
    const history: Message[] = [
      { role: 'user', content: '/issue 244' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', args: {} }] },
      { role: 'tool', callId: 'c1', summary: 'ran gh issue view', payload: 'THE ISSUE TEXT' },
    ];
    const specBefore = taskSpecIndex(history);
    expect(specBefore).toBe(2);

    h.scripted.push(truncated(healthy()), { content: 'done', toolCalls: undefined });
    const messages: Message[] = [];
    await runTurn({
      userInput: 'keep going',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'agent',
      onMessage: m => messages.push(m),
    });

    expect(history.some(m => m.role === 'user' && m.harness)).toBe(true);
    // The pin still names the issue payload, not anything the continuation produced.
    const spec = taskSpecIndex(history);
    expect(spec).toBeGreaterThanOrEqual(0);
    expect(history[spec].role === 'tool' && history[spec].payload).toBe('THE ISSUE TEXT');
  });
});
