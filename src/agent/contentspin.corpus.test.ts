import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_SPIN_DEBOUNCE, contentSpinSignal } from './contentspin.js';

// Real replies from saved sessions, labelled by reading each one whole, run through the content gate
// the way the stream does. evals/contentspin-replay.ts finds new cases but reads private history, so
// it cannot run in CI; this is the part that can. The gate first shipped with a fix that dropped
// `loop-inband-edit` to 0.000 while every synthetic test stayed green.

type Entry = { id: string; label: 'loop' | 'healthy'; model: string; note: string; text: string };

const CORPUS: Entry[] = JSON.parse(
  readFileSync(new URL('./contentspin.corpus.json', import.meta.url), 'utf8'),
);

// Stepped at the loop's own debounce, so a reply that loops and then recovers is judged on the prefix
// where it looped, not on its final score.
function firstCut(text: string): number | null {
  for (
    let at = CONTENT_SPIN_DEBOUNCE;
    at < text.length + CONTENT_SPIN_DEBOUNCE;
    at += CONTENT_SPIN_DEBOUNCE
  ) {
    const prefix = text.slice(0, Math.min(at, text.length));
    if (contentSpinSignal(prefix).spinning) return prefix.length;
  }
  return null;
}

describe('content gate against the labelled corpus', () => {
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
