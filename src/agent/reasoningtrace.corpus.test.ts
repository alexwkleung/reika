import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liveSpinSignal, verbatimAbortThreshold } from './reasoningtrace.js';

// Real reasoning blocks from saved sessions, labelled by reading each one whole, run through the live
// cut the way the stream does. The replays (evals/selfrepeat-report.ts) find new cases but read
// private history, so they cannot run in CI; this is the part that can. A threshold or window change
// that stops catching a loop here, or starts cutting a healthy block, fails the suite. Blocks near
// the bar whose label is unclear are left out on purpose: asserting either way would encode a guess.

type Entry = { id: string; label: 'loop' | 'healthy'; model: string; note: string; text: string };

const CORPUS: Entry[] = JSON.parse(
  readFileSync(new URL('./reasoningtrace.corpus.json', import.meta.url), 'utf8'),
);

// The loop re-checks every REASONING_SPIN_DEBOUNCE (400) chars; stepping the same way means a block
// that loops and then recovers is judged on the prefix where it looped, not on its final score.
const STEP = 400;

function firstCut(text: string): number | null {
  for (let at = STEP; at < text.length + STEP; at += STEP) {
    const prefix = text.slice(0, Math.min(at, text.length));
    if (liveSpinSignal(prefix).ratio >= verbatimAbortThreshold(prefix.length)) return prefix.length;
  }
  return null;
}

describe('reasoning cut against the labelled corpus', () => {
  it('holds both labels', () => {
    expect(CORPUS.some(e => e.label === 'loop')).toBe(true);
    expect(CORPUS.some(e => e.label === 'healthy')).toBe(true);
  });

  for (const e of CORPUS.filter(c => c.label === 'loop')) {
    it(`cuts ${e.id} (${e.model})`, () => {
      expect(firstCut(e.text)).not.toBeNull();
    });
  }

  for (const e of CORPUS.filter(c => c.label === 'healthy')) {
    it(`never cuts ${e.id} (${e.model})`, () => {
      expect(firstCut(e.text)).toBeNull();
    });
  }
});
