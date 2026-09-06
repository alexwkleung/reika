import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import {
  compactHistory,
  shouldCompact,
  compactThreshold,
  distillPlanHandoff,
  batchAgePayloads,
  AGE_LOW_FRACTION,
} from './compaction.js';

describe('shouldCompact', () => {
  it('is false without a context window', () => {
    expect(shouldCompact(1_000_000, undefined)).toBe(false);
  });

  it('triggers around the window minus the generation reserve, not a fixed fraction', () => {
    const window = 16384;
    const minGen = 2048;
    const threshold = compactThreshold(window, minGen);
    expect(shouldCompact(threshold - 1, window, minGen)).toBe(false);
    expect(shouldCompact(threshold + 1, window, minGen)).toBe(true);
  });

  it('tightens the trigger as the generation reserve grows (small-window thinking model)', () => {
    const window = 16384;
    // A bigger reserve must lower the threshold so generation room is preserved.
    expect(compactThreshold(window, 8192)).toBeLessThan(compactThreshold(window, 2048));
  });
});

// Build one user→tool→answer turn.
function turn(n: number, file: string): Message[] {
  return [
    { role: 'user', content: `q${n}` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${n}`, name: 'read', args: { path: file } }],
    },
    { role: 'tool', callId: `c${n}`, summary: `read ${file}`, payload: 'X'.repeat(500) },
    { role: 'assistant', content: `answer${n}` },
  ];
}

// Small window chosen so a handful of these tiny turns exceed the keep budget
// (window * 4 * 0.3 chars) and force compaction.
const W = 130;

describe('compactHistory', () => {
  it('does nothing when history fits the keep budget', () => {
    const history = [...turn(1, 'a.ts'), ...turn(2, 'b.ts')];
    const before = history.length;
    expect(compactHistory(history, 16384)).toBe(0);
    expect(history).toHaveLength(before);
  });

  it('does nothing without a context window', () => {
    const history = [...turn(1, 'a.ts'), ...turn(2, 'b.ts'), ...turn(3, 'c.ts')];
    expect(compactHistory(history, 0)).toBe(0);
  });

  it('collapses older turns into one front recap, keeping recent turns verbatim', () => {
    const history = [
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    const removed = compactHistory(history, W, 1, 0);
    expect(removed).toBeGreaterThan(0);
    // The original task is pinned verbatim at the front; the recap of the middle follows it.
    expect(history[0]).toMatchObject({ role: 'user', content: 'q1' });
    expect(history[1].role).toBe('compaction');
    // The most recent turn is still intact.
    expect(history.some(m => m.role === 'user' && m.content === 'q4')).toBe(true);
  });

  it('captures intent, tools, and files in the recap; excludes kept-verbatim turns', () => {
    const history = [
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    // q1's user text is pinned at the front, not summarized; the recap follows it.
    expect(history[0]).toMatchObject({ role: 'user', content: 'q1' });
    const recap = (history[1] as { content: string }).content;
    expect(recap).toContain('a.ts'); // q1's tool turn is summarized into the recap
    expect(recap).toContain('Tools used');
    expect(recap).not.toContain('q4'); // kept verbatim, not summarized
    expect(recap).not.toContain('XXXXX'); // raw payloads never enter the recap
  });

  it('bounds recap size and condenses the oldest turns once over the recap budget', () => {
    const history: Message[] = [];
    for (let i = 1; i <= 40; i++) history.push(...turn(i, `f${i}.ts`));
    compactHistory(history, W, 1, 0);
    const recap = (history[1] as { content: string }).content;
    // Bounded regardless of session length (40 turns in, recap stays compact).
    expect(recap.length).toBeLessThan(800);
    expect(recap).toMatch(/\+\d+ earlier turns? condensed/);
  });

  // The bug this guards: entries break only on a USER message, so one long agent turn is a single
  // entry — and the keep-loop used to exempt the newest entry from the budget entirely. An ordinary
  // long turn therefore produced a recap many times its own budget, i.e. the pass meant to reclaim
  // the window handed most of it straight back.
  it('bounds the recap when one long turn is a single entry', () => {
    const W16 = 16384;
    const history: Message[] = [{ role: 'user', content: 'refactor the parser' }];
    for (let i = 0; i < 800; i++) {
      history.push({
        role: 'assistant',
        content: `Round ${i}: checking the tokenizer boundary and the call site once more.`,
      });
    }
    expect(compactHistory(history, W16, 1, 512)).toBeGreaterThan(0);
    const recap = history.find(m => m.role === 'compaction') as { content: string };
    const budget = Math.floor((W16 - 512) * 4 * 0.1);
    expect(recap).toBeDefined();
    // Allow the tool/files/footer lines, which were never part of the entry budget.
    expect(recap.content.length).toBeLessThan(budget * 1.2);
  });

  it('keeps the turn intent and the most recent rounds when trimming a long entry', () => {
    const W16 = 16384;
    const history: Message[] = [{ role: 'user', content: 'refactor the parser' }];
    for (let i = 0; i < 800; i++) {
      history.push({ role: 'assistant', content: `Round ${i}: looked at the tokenizer boundary.` });
    }
    compactHistory(history, W16, 1, 512);
    const recap = (history.find(m => m.role === 'compaction') as { content: string }).content;
    // The task itself is pinned verbatim at the front rather than folded into the recap.
    expect(history[0]).toMatchObject({ role: 'user', content: 'refactor the parser' });
    expect(recap).toMatch(/\+\d+ rounds? condensed/); // says what it dropped
    expect(
      recap.includes('Round 799') ||
        history.some(m => m.role === 'assistant' && (m.content ?? '').includes('Round 799')),
    ).toBe(true);
    // The OLDEST round must not be the one that survived trimming.
    expect(recap).not.toContain('Round 0:');
  });

  it('carries a prior recap forward into the new one', () => {
    const history: Message[] = [
      { role: 'compaction', content: 'PRIOR RECAP' },
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    expect((history[0] as { content: string }).content).toContain('PRIOR RECAP');
  });

  it('compacts within a single long turn (one user message, many tool rounds)', () => {
    // Plan-mode exploration: one user task, then many read rounds with no later user boundary.
    // The old user-only boundary snapped to nothing here and grew unbounded; now it must compact.
    const history: Message[] = [{ role: 'user', content: 'the task' }];
    for (let i = 1; i <= 12; i++) {
      history.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `c${i}`, name: 'read', args: { path: `f${i}.ts` } }],
        },
        { role: 'tool', callId: `c${i}`, summary: `read f${i}.ts`, payload: 'X'.repeat(500) },
      );
    }
    const removed = compactHistory(history, W, 1, 0);
    expect(removed).toBeGreaterThan(0); // the bug: this used to be 0
    // The task survives verbatim; no kept tool result is orphaned from its tool_call.
    expect(history[0]).toMatchObject({ role: 'user', content: 'the task' });
    for (const [idx, m] of history.entries()) {
      if (m.role === 'tool') {
        const hasCall = history
          .slice(0, idx)
          .some(a => a.role === 'assistant' && a.toolCalls?.some(tc => tc.id === m.callId));
        expect(hasCall).toBe(true);
      }
    }
  });

  it('never leaves a tool result without its tool_call (splits on group boundaries)', () => {
    const history = [
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    const kept = history.slice(1);
    for (const m of kept) {
      if (m.role === 'tool') {
        const hasCall = kept.some(
          a => a.role === 'assistant' && a.toolCalls?.some(tc => tc.id === m.callId),
        );
        expect(hasCall).toBe(true);
      }
    }
  });

  it('never folds a slash-command echo (meta) into the recap', () => {
    const history: Message[] = [
      { role: 'user', content: '/model', meta: true },
      ...turn(1, 'a.ts'),
      { role: 'user', content: '/stats', meta: true },
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    const recap = history.find(m => m.role === 'compaction') as { content: string } | undefined;
    expect(recap).toBeDefined();
    // The command text must not reappear in the recap that merges into the system prompt.
    expect(recap!.content).not.toContain('/model');
    expect(recap!.content).not.toContain('/stats');
  });

  it('pins the real task, not a leading meta echo, at the front', () => {
    const history: Message[] = [
      { role: 'user', content: '/help', meta: true },
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    // recapStart=0 (leading message is meta, not pinned), so the recap leads and the
    // meta echo is dropped rather than preserved verbatim as "the original request".
    expect(history[0].role).toBe('compaction');
    expect((history[0] as { content: string }).content).not.toContain('/help');
  });
});

// A plan-mode history: one user request, a couple of read rounds, then the converged plan
// (marked planFinal, the anchor). `payloadA`/`payloadB` are distinctive so verbatim-vs-summary
// retention is observable in the digest.
const payloadA = 'PAYLOAD_A'.repeat(20);
const payloadB = 'PAYLOAD_B'.repeat(20);
function planHistory(): Message[] {
  return [
    { role: 'user', content: 'add a feature' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
    },
    { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: payloadA },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'read', args: { path: 'b.ts' } }],
    },
    { role: 'tool', callId: 'c2', summary: 'read b.ts', payload: payloadB },
    { role: 'assistant', content: '1. edit a.ts\n2. edit b.ts', planFinal: true },
  ];
}

describe('compactHistory keeps the task spec through the fold (#251)', () => {
  // The `/review` shape, which is what made this bite: the skill is ONE user message followed by
  // many tool rounds with no later user boundary, and it mandates a `gh` fetch as the opening call.
  // So the payload that DEFINES the task is the oldest message — first out under a backwards
  // keep-budget walk. taskSpecIndex is scoped to the last real user message, which in this shape is
  // still the first one. Before this fix the model was left with "Tools used: 5 bash", correctly
  // re-fetched, and the re-fetch re-inflated the estimate into the next compaction. Measured at
  // 3h29m with no review produced.
  const SPEC = 'ISSUE #224: spill artifacts leak when the process dies without a normal exit';
  // One tool round inside the same turn — no user message, so the turn never breaks.
  const round = (id: string, payload: string): Message[] => [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read', args: { path: `${id}.ts` } }],
    },
    { role: 'tool', callId: id, summary: `read ${id}.ts`, payload },
  ];
  const reviewTurn = (): Message[] => [
    { role: 'user', content: 'review 225' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'spec', name: 'bash', args: { command: 'gh pr view 225' } }],
    },
    { role: 'tool', callId: 'spec', summary: 'Ran: gh pr view 225', payload: SPEC },
    ...round('a', 'X'.repeat(500)),
    ...round('b', 'X'.repeat(500)),
    ...round('c', 'X'.repeat(500)),
    ...round('d', 'X'.repeat(500)),
  ];

  it('carries the spec payload verbatim into the recap', () => {
    const history = reviewTurn();
    expect(compactHistory(history, W, 1, 0)).toBeGreaterThan(0);
    const recap = history.find(m => m.role === 'compaction');
    expect(recap).toBeDefined();
    expect(recap!.content).toContain(SPEC);
    // And says plainly that it is the real thing, so it is not read as another summary.
    expect(recap!.content).toContain('not a summary');
  });

  it('leaves the spec alone when the fold does not reach it', () => {
    const history = reviewTurn().slice(0, 3);
    expect(compactHistory(history, 16384)).toBe(0);
    expect(history[2].role).toBe('tool');
  });

  it('folds exactly as before when the opening payload is too big to be a spec', () => {
    // taskSpecIndex refuses a first result over its pin cap — a huge opening dump is a dump, not a
    // task definition. Nothing is carried, and the old behaviour is unchanged.
    const history: Message[] = [
      { role: 'user', content: 'review 225' },
      ...round('big', 'X'.repeat(5000)),
      ...round('a', 'X'.repeat(500)),
      ...round('b', 'X'.repeat(500)),
      ...round('c', 'X'.repeat(500)),
    ];
    expect(compactHistory(history, W, 1, 0)).toBeGreaterThan(0);
    const recap = history.find(m => m.role === 'compaction');
    expect(recap).toBeDefined();
    expect(recap!.content).not.toContain('not a summary');
  });

  it('never leaves a tool message directly after the recap', () => {
    // The reason the payload is carried as text rather than by keeping the message: a tool result
    // may not lead a request, and its assistant parent may have had sibling calls that were folded.
    const history = reviewTurn();
    compactHistory(history, W, 1, 0);
    const at = history.findIndex(m => m.role === 'compaction');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(history[at + 1]?.role).not.toBe('tool');
  });
});

describe('distillPlanHandoff', () => {
  // #126: `planFinal` marks the end of the plan turn, not the existence of a plan. Anchoring on a
  // step-less message is the worst outcome available — the exploration that could have grounded
  // the next turn is folded away, and "I couldn't determine…" is what survives verbatim.
  it('refuses to fold when the marked message has no steps', () => {
    const history = planHistory();
    const plan = history[history.length - 1] as { content: string };
    plan.content = 'I could not determine which file handles this.';
    const before = history.length;

    const { folded, reason } = distillPlanHandoff(history, 16384, 1, 0);

    expect(reason).toBe('no-steps');
    expect(folded).toBe(0);
    // History is untouched: an un-distilled turn is merely bigger, not misleading.
    expect(history).toHaveLength(before);
    expect(history.some(m => m.role === 'compaction')).toBe(false);
  });

  it('folds the exploration, keeping the request and the plan verbatim', () => {
    const history = planHistory();
    const { folded, reason } = distillPlanHandoff(history, 16384, 1, 0);
    expect(folded).toBeGreaterThan(0);
    expect(reason).toBe('folded');
    // Request pinned at the front, plan kept verbatim as the anchor at the back, exactly one
    // compaction message between them.
    expect(history[0]).toMatchObject({ role: 'user', content: 'add a feature' });
    const last = history[history.length - 1];
    expect(last).toMatchObject({ role: 'assistant', planFinal: true });
    expect((last as { content: string }).content).toBe('1. edit a.ts\n2. edit b.ts');
    expect(history.filter(m => m.role === 'compaction')).toHaveLength(1);
    expect(history[1].role).toBe('compaction');
  });

  it('indexes the files examined and carries recent findings verbatim under a generous budget', () => {
    const history = planHistory();
    distillPlanHandoff(history, 16384, 1, 0);
    const digest = (history[1] as { content: string }).content;
    expect(digest).toContain('Files examined:');
    expect(digest).toContain('a.ts');
    expect(digest).toContain('b.ts');
    // Generous budget → the read payloads survive verbatim in the digest.
    expect(digest).toContain(payloadB);
    expect(digest).toContain(payloadA);
  });

  it('degrades older findings to summary-only under a tight findings budget', () => {
    const history = planHistory();
    // Tiny window + tiny fraction → the findings budget can't hold the raw payloads.
    distillPlanHandoff(history, 100, 1, 0, 0.05);
    const digest = (history[1] as { content: string }).content;
    expect(digest).toContain('shown as summary only');
    expect(digest).not.toContain(payloadA);
  });

  it('is a no-op when there is no plan-final marker (ordinary agent turn)', () => {
    const history = [...turn(1, 'a.ts'), ...turn(2, 'b.ts')];
    const before = history.length;
    expect(distillPlanHandoff(history, 16384, 1, 0)).toEqual({ folded: 0, reason: 'no-marker' });
    expect(history).toHaveLength(before);
  });

  it('is a no-op when the plan was written with no exploration in front of it', () => {
    const history: Message[] = [
      { role: 'user', content: 'task' },
      // A real plan (steps parse) so this exercises the empty-span path rather than the
      // no-steps guard — both are no-ops, and only one of them is what this test is about.
      { role: 'assistant', content: '1. edit a.ts', planFinal: true },
    ];
    expect(distillPlanHandoff(history, 16384, 1, 0)).toEqual({ folded: 0, reason: 'empty-span' });
  });

  it('is idempotent — a second pass over an already-distilled history does nothing', () => {
    const history = planHistory();
    expect(distillPlanHandoff(history, 16384, 1, 0).folded).toBeGreaterThan(0);
    expect(distillPlanHandoff(history, 16384, 1, 0)).toEqual({
      folded: 0,
      reason: 'already-distilled',
    });
  });

  it('anchors on the most recent plan when the plan was refined twice', () => {
    const history: Message[] = [
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
      },
      { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: payloadA },
      { role: 'assistant', content: '1. OLD PLAN step', planFinal: true },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'read', args: { path: 'b.ts' } }],
      },
      { role: 'tool', callId: 'c2', summary: 'read b.ts', payload: payloadB },
      { role: 'assistant', content: '1. NEW PLAN step', planFinal: true },
    ];
    distillPlanHandoff(history, 16384, 1, 0);
    // The newest plan is the live anchor; the earlier one is folded away (superseded, not pinned).
    const last = history[history.length - 1];
    expect((last as { content: string }).content).toBe('1. NEW PLAN step');
    expect(history.filter(m => m.role === 'compaction')).toHaveLength(1);
    expect(history.some(m => m.role === 'assistant' && m.content === '1. OLD PLAN step')).toBe(
      false,
    );
    // The digest still indexes files read across the whole exploration, including pre-old-plan.
    expect((history[1] as { content: string }).content).toContain('a.ts');
  });

  it('carries a compaction that fired during plan mode forward into the digest', () => {
    const history: Message[] = [
      { role: 'user', content: 'task' },
      { role: 'compaction', content: 'PLAN-MODE PRIOR RECAP' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }],
      },
      { role: 'tool', callId: 'c1', summary: 'read a.ts', payload: payloadA },
      { role: 'assistant', content: 'plan', planFinal: true },
    ];
    distillPlanHandoff(history, 16384, 1, 0);
    expect((history[1] as { content: string }).content).toContain('PLAN-MODE PRIOR RECAP');
  });

  it('still folds when the window is unknown (positional-salience benefit)', () => {
    const history = planHistory();
    const { folded } = distillPlanHandoff(history, undefined, 1, 0);
    expect(folded).toBeGreaterThan(0);
    expect(history[1].role).toBe('compaction');
    // No window → everything kept verbatim.
    expect((history[1] as { content: string }).content).toContain(payloadA);
  });
});

// EXPERIMENT (REIKA_PREFIX_STABLE, issue #69): batch payload aging.
describe('batchAgePayloads', () => {
  const round = (id: string, payload: string, reasoning?: string): Message[] => [
    {
      role: 'assistant',
      content: '',
      ...(reasoning ? { reasoning } : {}),
      toolCalls: [{ id, name: 'read', args: {} }],
    },
    { role: 'tool', callId: id, summary: `${id}`, payload, rendered: `${id}\n\n${payload}` },
  ];
  // A state-sensitive stand-in for the request estimate: live payloads and unaged reasoning count
  // in full, aged ones at (roughly) summary cost — so marking visibly shrinks it.
  const estimateOf = (history: Message[]) => (): number =>
    history.reduce((n, m) => {
      if (m.role === 'tool') return n + (m.aged ? m.summary.length : (m.payload?.length ?? 0));
      if (m.role === 'assistant') return n + (m.reasoningAged ? 0 : (m.reasoning?.length ?? 0));
      return n;
    }, 0);

  it('is a no-op below the compaction threshold', () => {
    const history: Message[] = [{ role: 'user', content: 'go' }, ...round('a', 'x'.repeat(50))];
    expect(batchAgePayloads(history, estimateOf(history), 1000, 0).marked).toBe(0);
    expect((history[2] as Message & { role: 'tool' }).aged).toBeUndefined();
  });

  it('ages oldest-first down to the low watermark and clears frozen renders', () => {
    // threshold = (1000 − 0) × 0.9 = 900; estimate starts at 50 + 3 × 400 = 1250. The 50-char
    // opening round is the turn's task spec (#227) and is exempt, so aging starts at 'a'.
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('spec', 'q'.repeat(50)),
      ...round('a', 'x'.repeat(400)),
      ...round('b', 'y'.repeat(400)),
      ...round('c', 'z'.repeat(400)),
    ];
    const aged = batchAgePayloads(history, estimateOf(history), 1000, 0);
    expect(aged.marked).toBeGreaterThan(0);
    const tools = history.filter(m => m.role === 'tool') as Array<Message & { role: 'tool' }>;
    // Oldest non-spec aged (render cleared), trailing block protected.
    expect(tools[1].aged).toBe(true);
    expect(tools[1].rendered).toBeUndefined();
    expect(tools[3].aged).toBeUndefined();
    expect(tools[3].rendered).toBeDefined();
    expect(estimateOf(history)()).toBeLessThanOrEqual(900 * AGE_LOW_FRACTION);
  });

  it("never ages the turn's task spec, even as everything older-first around it goes (#227)", () => {
    // The observed failure: `/issue` mandates `gh issue view` as the opening call, so the payload
    // that DEFINES the task is the oldest and therefore the first one aging sacrifices — after
    // which its summary ("Ran: … (505 bytes output)") reads as handled and the model confabulates
    // the issue text instead of re-fetching.
    const history: Message[] = [
      { role: 'user', content: 'read the skill body then work on issue 213' },
      ...round('spec', 'ISSUE BODY'.repeat(20)),
      ...round('a', 'x'.repeat(4000)),
      ...round('b', 'y'.repeat(4000)),
      ...round('c', 'z'.repeat(400)),
    ];
    batchAgePayloads(history, estimateOf(history), 1000, 0);
    const tools = history.filter(m => m.role === 'tool') as Array<Message & { role: 'tool' }>;
    expect(tools[0].aged).toBeUndefined();
    expect(tools[0].rendered).toBeDefined();
    expect(tools[1].aged).toBe(true);
    expect(tools[2].aged).toBe(true);
  });

  it('pins nothing when the turn opens with a payload too large to be a spec', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('dump', 'x'.repeat(5000)),
      ...round('a', 'y'.repeat(400)),
      ...round('b', 'z'.repeat(400)),
    ];
    batchAgePayloads(history, estimateOf(history), 1000, 0);
    expect((history[2] as Message & { role: 'tool' }).aged).toBe(true);
  });

  it("moves the pin to the new turn, releasing the previous turn's spec", () => {
    // Spec payloads are sized like the real thing (an issue/PR body, under TASK_SPEC_PIN_CHARS)
    // rather than a token string: aging now sheds bulk before crumbs, and an 8-char payload is a
    // crumb the first sweep correctly declines to spend a re-read risk on. What this test is about
    // is which spec is PINNED, not the size of either.
    const history: Message[] = [
      { role: 'user', content: 'turn 1' },
      ...round('spec1', 'OLD SPEC'.repeat(300)),
      { role: 'user', content: 'turn 2' },
      ...round('spec2', 'NEW SPEC'.repeat(300)),
      ...round('a', 'x'.repeat(4000)),
      ...round('b', 'y'.repeat(400)),
    ];
    batchAgePayloads(history, estimateOf(history), 1000, 0);
    const tools = history.filter(m => m.role === 'tool') as Array<Message & { role: 'tool' }>;
    expect(tools[0].aged).toBe(true); // turn 1's spec is no longer the task
    expect(tools[1].aged).toBeUndefined(); // turn 2's is
  });

  it('never ages the active roundtrip, even when the target is unreachable', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('a', 'x'.repeat(5000), 'r'.repeat(5000)),
    ];
    batchAgePayloads(history, estimateOf(history), 1000, 0);
    const tool = history[2] as Message & { role: 'tool' };
    const assistant = history[1] as Message & { role: 'assistant' };
    expect(tool.aged).toBeUndefined();
    expect(assistant.reasoningAged).toBeUndefined();
  });

  // #257: aging was strictly oldest-first regardless of size, so a 673-byte file got aged in an
  // event that shed 18,935 chars — and the model re-read it, twice. A re-read costs a whole round
  // AND puts the payload back in the window, pulling the next shrink event forward.
  it('sheds a bulky payload and leaves the crumb behind when that reaches the watermark', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('spec', 'q'.repeat(50)),
      ...round('tiny', 'x'.repeat(100)),
      ...round('big', 'y'.repeat(4000)),
      ...round('c', 'z'.repeat(400)),
    ];
    const aged = batchAgePayloads(history, estimateOf(history), 1000, 0);
    const tools = history.filter(m => m.role === 'tool') as Array<Message & { role: 'tool' }>;
    // The bulky payload is older-last but shed first; the crumb older-first and kept.
    expect(tools[2].aged).toBe(true);
    expect(tools[1].aged).toBeUndefined();
    expect(tools[1].rendered).toBeDefined();
    // The reported split is what a run's log is read by, so assert it, not just the marks.
    expect(aged.bulk).toBe(1);
    expect(aged.crumbs).toBe(0);
    expect(aged.kept).toBe(1);
    expect(estimateOf(history)()).toBeLessThanOrEqual(900 * AGE_LOW_FRACTION);
  });

  // The floor reorders; it must never gate the watermark, or a shrink event lands just under the
  // threshold and the next round re-fires it — consecutive full re-processes, the exact pattern
  // batching exists to prevent.
  it('ages the crumbs too when shedding bulk alone cannot reach the watermark', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('a', 'x'.repeat(300)),
      ...round('b', 'y'.repeat(300)),
      ...round('c', 'z'.repeat(300)),
      ...round('d', 'w'.repeat(300)),
    ];
    // Every payload is under the floor, so the first sweep can shed nothing at all.
    const aged = batchAgePayloads(history, estimateOf(history), 1000, 0);
    expect(aged.marked).toBeGreaterThan(0);
    expect(aged.bulk).toBe(0);
    expect(aged.crumbs).toBeGreaterThan(0);
    expect(estimateOf(history)()).toBeLessThanOrEqual(900 * AGE_LOW_FRACTION);
  });

  it('drops old reasoning in the same sweep as old payloads', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' },
      ...round('a', 'x'.repeat(400), 'r'.repeat(400)),
      ...round('b', 'y'.repeat(400)),
      ...round('c', 'z'.repeat(400)),
    ];
    batchAgePayloads(history, estimateOf(history), 1000, 0);
    expect((history[1] as Message & { role: 'assistant' }).reasoningAged).toBe(true);
  });
});
