import { describe, it, expect } from 'vitest';
import { buildRestartHistory, lastUserRequest } from './compaction.js';
import type { Message } from '../types.js';

const REQUEST = 'add retry with backoff to the fetch helper';
const NUDGE = '(your reasoning was repeating the same text and was stopped)';

const base = (): Message[] => [
  { role: 'user', content: REQUEST },
  {
    role: 'assistant',
    content: 'Looking at the helper.',
    toolCalls: [{ id: 'r1', name: 'read', args: { path: 'fetch.ts' } }],
  },
  { role: 'tool', callId: 'r1', summary: 'read fetch.ts' },
  { role: 'user', harness: true, content: NUDGE },
  { role: 'assistant', content: 'Still checking.' },
];

const OPTS = { attempt: 1, maxAttempts: 2, contextWindow: 16384 };

describe('lastUserRequest', () => {
  it('finds what the user typed', () => {
    expect(lastUserRequest(base())).toBe(REQUEST);
  });

  // A restart built around a nudge would hand the model a loop-breaker as its goal.
  it('never returns harness scaffolding or a command echo', () => {
    const h: Message[] = [
      { role: 'user', content: REQUEST },
      { role: 'user', meta: true, content: '/plan' },
      { role: 'user', harness: true, content: NUDGE },
    ];
    expect(lastUserRequest(h)).toBe(REQUEST);
  });

  it('returns null when there is nothing the user asked for', () => {
    expect(lastUserRequest([{ role: 'assistant', content: 'hi' }])).toBeNull();
  });
});

describe('buildRestartHistory', () => {
  it('rebuilds a fresh conversation: digest, then the request verbatim', () => {
    const r = buildRestartHistory(base(), OPTS);
    expect(r).not.toBeNull();
    expect(r!.history.map(m => m.role)).toEqual(['compaction', 'user']);
    expect(r!.history[1].role === 'user' && r!.history[1].content).toBe(REQUEST);
  });

  it('states which attempt this is, so the notice and the prompt agree', () => {
    const r = buildRestartHistory(base(), { ...OPTS, attempt: 2, maxAttempts: 2 });
    expect(r!.digest).toContain('attempt 2 of 2');
  });

  // The edit-recovery dead-end restarts on a failure that leaves no diff, so the applied ledger
  // cannot carry it and the recap may summarize it away. Without the blocking fact stated outright
  // the restart re-derives the old_string that just failed.
  it('carries the blocking fact when the caller knows what defeated the last attempt', () => {
    const blocked = 'could not apply its edit to styles/global.css';
    const r = buildRestartHistory(base(), { ...OPTS, blocked });
    expect(r!.digest).toContain(blocked);
  });

  // A pure reasoning spiral has no single blocking fact; inventing one would assert a cause the
  // harness did not observe.
  it('says nothing about a blocker when the caller names none', () => {
    expect(buildRestartHistory(base(), OPTS)!.digest).not.toContain('could not apply');
  });

  // The goal must survive byte-for-byte: a paraphrase drifts on a small window, and a restart that
  // loses the goal is worse than the stop it replaced.
  it('does not restate the request in truncated form inside the recap', () => {
    const long = 'x'.repeat(400);
    const h: Message[] = [
      { role: 'user', content: long },
      { role: 'assistant', content: 'ok' },
    ];
    const r = buildRestartHistory(h, OPTS);
    expect(r!.history[1].role === 'user' && r!.history[1].content).toBe(long);
    expect(r!.digest).not.toContain('…'); // no truncated echo of the request
  });

  it('carries a converged plan through untouched, after the request', () => {
    const plan = '1. add a backoff helper\n2. wire it into fetch\n3. test the retry path';
    const h: Message[] = [...base(), { role: 'assistant', content: plan, planFinal: true }];
    const r = buildRestartHistory(h, OPTS);
    expect(r!.carriedPlan).toBe(true);
    expect(r!.history.map(m => m.role)).toEqual(['compaction', 'user', 'assistant']);
    const carried = r!.history[2];
    expect(carried.role === 'assistant' && carried.content).toBe(plan);
    expect(carried.role === 'assistant' && carried.planFinal).toBe(true);
  });

  it('reports no plan when the turn never converged on one', () => {
    const r = buildRestartHistory(base(), OPTS);
    expect(r!.carriedPlan).toBe(false);
  });

  it('includes the applied-changes ledger when work already landed', () => {
    const applied = 'Changes from this turn are ALREADY saved to disk:\n  - fetch.ts (+9/-2)';
    const r = buildRestartHistory(base(), { ...OPTS, applied });
    expect(r!.digest).toContain('fetch.ts (+9/-2)');
    expect(r!.digest).toContain('ALREADY saved');
  });

  it('says nothing about files when nothing landed', () => {
    const r = buildRestartHistory(base(), OPTS);
    expect(r!.digest).not.toContain('ALREADY saved');
  });

  it('tells the model to verify before re-editing and not to repeat the approach', () => {
    const r = buildRestartHistory(base(), OPTS);
    expect(r!.digest).toMatch(/check the current state/i);
    expect(r!.digest).toMatch(/different approach/i);
  });

  // With no goal to restate a restart would produce a conversation about nothing; the caller is
  // meant to fall through to the honest stop instead.
  it('declines to restart when there is no user request', () => {
    expect(buildRestartHistory([{ role: 'assistant', content: 'hi' }], OPTS)).toBeNull();
  });

  it('does not mutate the history it was given', () => {
    const h = base();
    const snapshot = JSON.stringify(h);
    buildRestartHistory(h, OPTS);
    expect(JSON.stringify(h)).toBe(snapshot);
  });

  // The restart is also the compaction pass when both would fire, so its output has to be small
  // regardless of how long the spiral ran.
  it('stays bounded when the spiral produced a very long history', () => {
    const h: Message[] = [{ role: 'user', content: REQUEST }];
    for (let i = 0; i < 400; i++) {
      h.push({
        role: 'assistant',
        content: `round ${i}: ${'considering the same thing '.repeat(20)}`,
      });
    }
    const r = buildRestartHistory(h, OPTS);
    const chars = r!.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
    expect(chars).toBeLessThan(16384); // comfortably inside a 16k-token window
  });
});
