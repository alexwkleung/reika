import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import {
  compactHistory,
  shouldCompact,
  compactThreshold,
  distillPlanHandoff,
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

describe('distillPlanHandoff', () => {
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
      { role: 'assistant', content: 'plan', planFinal: true },
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
      { role: 'assistant', content: 'OLD PLAN', planFinal: true },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'read', args: { path: 'b.ts' } }],
      },
      { role: 'tool', callId: 'c2', summary: 'read b.ts', payload: payloadB },
      { role: 'assistant', content: 'NEW PLAN', planFinal: true },
    ];
    distillPlanHandoff(history, 16384, 1, 0);
    // The newest plan is the live anchor; the earlier one is folded away (superseded, not pinned).
    const last = history[history.length - 1];
    expect((last as { content: string }).content).toBe('NEW PLAN');
    expect(history.filter(m => m.role === 'compaction')).toHaveLength(1);
    expect(history.some(m => m.role === 'assistant' && m.content === 'OLD PLAN')).toBe(false);
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
