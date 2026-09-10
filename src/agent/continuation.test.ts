import { describe, expect, it } from 'vitest';

import {
  CONTINUATION_NOVELTY_LIMIT,
  ContinuationGate,
  MAX_CONSECUTIVE_CONTINUATIONS,
  continuationGate,
  continuationMarker,
  continuationTail,
} from './continuation.js';

// Distinct prose, long enough to shingle. Repeating a *different* sentence each time keeps
// selfRepeatRatio near zero the way healthy reasoning does.
function healthy(n: number, seed = 0): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = seed * 10_000 + i;
    out.push(
      `step ${k}: the index at position ${k} resolves to offset ${k * 3} which the caller then ` +
        `compares against the ${k} boundary before moving on to the next candidate line`,
    );
  }
  return out.join('\n');
}

// One sentence over and over — the Layer-1 verbatim signature.
function degenerate(n: number): string {
  const line = 'the previous line starts at the index after the newline that terminates it';
  return Array.from({ length: n }, () => line).join('\n');
}

describe('continuationGate', () => {
  it('carries healthy reasoning forward', () => {
    const g = continuationGate(healthy(200));
    expect(g.continuable).toBe(true);
    expect(g.ratio).toBeLessThan(g.threshold);
  });

  it('refuses a verbatim-degenerate block', () => {
    const g = continuationGate(degenerate(200));
    expect(g.continuable).toBe(false);
    expect(g.ratio).toBeGreaterThanOrEqual(g.threshold);
  });

  it('never calls a block too short to judge degenerate', () => {
    // Under VERBATIM_LEN_MIN the threshold is Infinity, so even a pathological ratio continues —
    // a 400-char block that says one sentence twice scores high without being stuck.
    const short = degenerate(4);
    expect(short.length).toBeLessThan(2000);
    const g = continuationGate(short);
    expect(g.continuable).toBe(true);
    expect(g.threshold).toBe(Number.POSITIVE_INFINITY);
  });

  it('clears the bar by a wide margin at the measured values (#284)', () => {
    // The real truncated block: 30,270 chars at selfRepeatRatio 0.014, against a 0.25 threshold —
    // below the p90 of healthy blocks in the calibration corpus. This is the case the whole feature
    // exists for, so it is anchored rather than left implicit.
    const g = continuationGate(healthy(400));
    expect(g.threshold).toBeLessThanOrEqual(0.35);
    expect(g.ratio).toBeLessThan(g.threshold / 2);
    expect(g.continuable).toBe(true);
  });
});

describe('continuationTail', () => {
  it('carries a short block verbatim', () => {
    const text = 'a short cut-off thought that already fits inside the budget';
    expect(continuationTail(text, 5000)).toEqual({ text, omitted: 0 });
  });

  it('keeps the END of an oversized block — the resume anchor', () => {
    const text = `${'x'.repeat(500)}the previous line is [0, 1), and pos (end`;
    const { text: out, omitted } = continuationTail(text, 100);
    expect(out.endsWith('and pos (end')).toBe(true);
    expect(omitted).toBeGreaterThan(0);
    expect(out).toContain(continuationMarker(omitted));
  });

  it('reports omitted as the chars actually dropped', () => {
    const text = 'y'.repeat(1000);
    const { text: out, omitted } = continuationTail(text, 100);
    // No newline anywhere, so the raw cut stands: 100 chars survive, 900 are gone.
    expect(omitted).toBe(900);
    expect(out.endsWith('y'.repeat(100))).toBe(true);
  });

  it('opens at a paragraph boundary when one lands early in the window', () => {
    const tail = 'the resolved answer follows here and continues to the very end of the block';
    const text = `${'z'.repeat(1000)}\n\n${tail}`;
    const { text: out } = continuationTail(text, tail.length + 20);
    // The blank line sits inside the first quarter of the window, so it is honored and the carried
    // body starts clean rather than mid-run of z's.
    expect(out).toContain(`\n\n${tail}`);
    expect(out).not.toContain('zz');
  });

  it('ignores a boundary buried deep in the window rather than dropping the answer', () => {
    // The only blank line sits ~90% through the window: honoring it would trade the body for a tidy
    // opening. The raw cut stands instead.
    const head = 'q'.repeat(90);
    const text = `${'p'.repeat(1000)}${head}\n\nshort`;
    const { text: out } = continuationTail(text, 100);
    expect(out).toContain('qqq');
    expect(out.endsWith('short')).toBe(true);
  });

  it('carries nothing at a budget of zero — the nudge-only arm', () => {
    // `slice(-0)` is `slice(0)`, so an unguarded zero budget would carry the ENTIRE block: the arm
    // meant to isolate the nudge would silently measure the largest possible tail instead.
    const text = 'z'.repeat(500);
    const { text: out, omitted } = continuationTail(text, 0);
    expect(omitted).toBe(500);
    expect(out).not.toContain('zz');
    expect(out).toBe(continuationMarker(500));
  });
});

describe('ContinuationGate', () => {
  it('allows continuations up to the consecutive bound, then stops on count', () => {
    const gate = new ContinuationGate();
    // Each round carries genuinely new text — what the model generated on that round, not the
    // accumulated tail. Only the count should ever stop this sequence.
    for (let i = 0; i < MAX_CONSECUTIVE_CONTINUATIONS; i++) {
      const verdict = gate.allow(healthy(20, i + 1));
      expect(verdict.ok).toBe(true);
      gate.noteContinuation(healthy(20, i + 1));
    }
    const stopped = gate.allow(healthy(20, 99));
    expect(stopped.ok).toBe(false);
    expect(stopped.reason).toBe('count');
  });

  it('stops a continuation that merely restates the previous one', () => {
    const gate = new ContinuationGate();
    const block = healthy(30);
    expect(gate.allow(block).ok).toBe(true);
    gate.noteContinuation(block);
    const repeat = gate.allow(block);
    expect(repeat.ok).toBe(false);
    expect(repeat.reason).toBe('novelty');
    expect(repeat.sim).toBeGreaterThanOrEqual(CONTINUATION_NOVELTY_LIMIT);
  });

  it('allows a continuation that is genuinely new', () => {
    const gate = new ContinuationGate();
    gate.noteContinuation(healthy(30));
    const verdict = gate.allow(degenerate(30));
    expect(verdict.ok).toBe(true);
    expect(verdict.sim).toBeLessThan(CONTINUATION_NOVELTY_LIMIT);
  });

  it('progress resets both the count and the novelty memory', () => {
    const gate = new ContinuationGate();
    const block = healthy(30);
    for (let i = 0; i < MAX_CONSECUTIVE_CONTINUATIONS; i++) gate.noteContinuation(block);
    expect(gate.allow(block).ok).toBe(false);
    expect(gate.spent).toBe(MAX_CONSECUTIVE_CONTINUATIONS);

    gate.noteProgress();
    expect(gate.spent).toBe(0);
    // The same block is allowed again: novelty is measured against the previous *continuation*, and
    // progress cleared it. A model that acted and then truncated on the same analysis is not looping.
    const verdict = gate.allow(block);
    expect(verdict.ok).toBe(true);
    expect(verdict.sim).toBe(0);
  });
});
