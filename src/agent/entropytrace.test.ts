import { describe, expect, it } from 'vitest';
import type { SampledToken } from '../types.js';
import {
  EntropyTrace,
  empiricalEntropy,
  formatEntropyReading,
  klDivergence,
  logprobStats,
  textTokens,
  tokenCounts,
} from './entropytrace.js';

const counts = (text: string): Map<string, number> => tokenCounts(textTokens(text));

// A position whose top-k is a uniform k-way split: entropy log(k), coverage 1.
const uniformTop = (k: number): SampledToken => ({
  token: 'x',
  logprob: Math.log(1 / k),
  top: Array.from({ length: k }, (_, i) => ({ token: `t${i}`, logprob: Math.log(1 / k) })),
});

describe('textTokens', () => {
  it('lowercases and splits on punctuation, keeping underscores', () => {
    expect(textTokens('Read the File_Path, then STOP.')).toEqual([
      'read',
      'the',
      'file_path',
      'then',
      'stop',
    ]);
  });

  it('yields nothing for text with no word characters', () => {
    expect(textTokens('   ...   ')).toEqual([]);
  });
});

describe('empiricalEntropy', () => {
  it('is log(n) for a uniform distribution, normalizing to 1', () => {
    const { entropy, normalized } = empiricalEntropy(counts('alpha beta gamma delta'));
    expect(entropy).toBeCloseTo(Math.log(4), 10);
    expect(normalized).toBeCloseTo(1, 10);
  });

  it('is 0 for a single repeated symbol — the degenerate-output floor', () => {
    expect(empiricalEntropy(counts('same same same same'))).toEqual({ entropy: 0, normalized: 0 });
  });

  it('is 0 for an empty distribution (no evidence, not certainty)', () => {
    expect(empiricalEntropy(new Map())).toEqual({ entropy: 0, normalized: 0 });
  });

  it('ranks repetitive output below varied output at equal length', () => {
    // Both rounds are nine tokens, so the normalization's length bias is controlled and the only
    // difference is repetition: three words said three times vs nine distinct ones.
    const repetitive = empiricalEntropy(counts('fix the bug fix the bug fix the bug'));
    const varied = empiricalEntropy(counts('read the file then edit another module quickly now'));
    expect(repetitive.normalized).toBeCloseTo(0.5, 10);
    expect(varied.normalized).toBeCloseTo(1, 10);
  });
});

describe('klDivergence', () => {
  it('is exactly 0 against an identical distribution', () => {
    const c = counts('the model reads a file and edits it');
    expect(klDivergence(c, c)).toBe(0);
  });

  it('stays finite for disjoint vocabularies (the case unsmoothed KL cannot express)', () => {
    const kl = klDivergence(counts('alpha beta gamma'), counts('delta epsilon zeta'));
    expect(Number.isFinite(kl)).toBe(true);
    expect(kl).toBeGreaterThan(0);
  });

  it('orders near-identical < paraphrased < unrelated', () => {
    const base = counts('read the composer file and check the props it passes down');
    const nearIdentical = counts('read the composer file and check the props it passes down now');
    const paraphrased = counts('open the composer module and inspect which props it forwards');
    const unrelated = counts('deploy the database migration to staging before the release window');

    const near = klDivergence(nearIdentical, base);
    const para = klDivergence(paraphrased, base);
    const far = klDivergence(unrelated, base);
    expect(near).toBeLessThan(para);
    expect(para).toBeLessThan(far);
  });

  it('is asymmetric — it weights by the round being judged', () => {
    const p = counts('alpha beta gamma delta epsilon zeta eta theta');
    const q = counts('alpha beta');
    expect(klDivergence(p, q)).not.toBeCloseTo(klDivergence(q, p), 6);
  });

  it('returns 0 when either side is empty', () => {
    expect(klDivergence(counts('anything at all'), new Map())).toBe(0);
    expect(klDivergence(new Map(), counts('anything at all'))).toBe(0);
  });
});

describe('logprobStats', () => {
  it('returns null when the engine reported no tokens', () => {
    expect(logprobStats([])).toBeNull();
  });

  it('averages the sampled tokens surprisal in nats', () => {
    const stats = logprobStats([
      { token: 'a', logprob: Math.log(0.5) },
      { token: 'b', logprob: Math.log(0.5) },
    ]);
    expect(stats?.surprisal).toBeCloseTo(-Math.log(0.5), 10);
    expect(stats?.positions).toBe(2);
  });

  it('leaves entropy unmeasured when logprobs came back without top_logprobs', () => {
    const stats = logprobStats([{ token: 'a', logprob: -0.1 }]);
    expect(stats?.entropy).toBeUndefined();
    expect(stats?.coverage).toBeUndefined();
    expect(stats?.surprisal).toBeCloseTo(0.1, 10);
  });

  it('computes log(k) entropy and full coverage for a uniform top-k', () => {
    const stats = logprobStats([uniformTop(5), uniformTop(5)]);
    expect(stats?.entropy).toBeCloseTo(Math.log(5), 10);
    expect(stats?.coverage).toBeCloseTo(1, 10);
  });

  it('reports a peaked position as low entropy, and its unmeasured tail as low coverage', () => {
    // Top-2 of a distribution whose remaining mass (0.1) is spread outside the reported list.
    const peaked = logprobStats([
      {
        token: 'the',
        logprob: Math.log(0.8),
        top: [
          { token: 'the', logprob: Math.log(0.8) },
          { token: 'a', logprob: Math.log(0.1) },
        ],
      },
    ]);
    expect(peaked?.entropy).toBeLessThan(Math.log(2));
    expect(peaked?.coverage).toBeCloseTo(0.9, 10);
  });

  it('averages entropy only over positions that carried a top-k, but surprisal over all', () => {
    const stats = logprobStats([uniformTop(4), { token: 'y', logprob: Math.log(1 / 4) }]);
    expect(stats?.positions).toBe(2);
    expect(stats?.entropy).toBeCloseTo(Math.log(4), 10); // one contributing position, not halved
    expect(stats?.surprisal).toBeCloseTo(-Math.log(1 / 4), 10);
  });
});

describe('EntropyTrace', () => {
  it('returns null for a round with nothing to measure', () => {
    expect(new EntropyTrace().record({ text: '' })).toBeNull();
  });

  it('reports no divergence on the first round — there is nothing to compare against', () => {
    const r = new EntropyTrace().record({ text: 'let me read the composer file first' });
    expect(r).toMatchObject({ source: 'text', klPrev: 0, klBase: 0 });
    expect(r?.tokens).toBe(7);
  });

  it('collapses klPrev to 0 when a round repeats the previous one verbatim (the stall signature)', () => {
    const trace = new EntropyTrace();
    const rumination = 'i should check whether the composer passes the props down correctly';
    trace.record({ text: rumination });
    const second = trace.record({ text: rumination });
    expect(second?.klPrev).toBe(0);
    expect(second?.klBase).toBe(0);
  });

  it('separates drift-and-stay (klBase high, klPrev low) from ongoing movement', () => {
    const trace = new EntropyTrace();
    trace.record({ text: 'read the composer component and its props' });
    const moved = trace.record({ text: 'deploy the staging database migration before release' });
    const stayed = trace.record({ text: 'deploy the staging database migration before release' });

    expect(moved?.klPrev).toBeGreaterThan(0);
    expect(moved?.klBase).toBeGreaterThan(0);
    // It went somewhere and stopped: still far from the turn's start, no longer moving.
    expect(stayed?.klPrev).toBe(0);
    expect(stayed?.klBase).toBeGreaterThan(0);
    expect(stayed?.klBase).toBeCloseTo(moved?.klBase ?? -1, 10);
  });

  it('does not let a text-less round blank out the drift signal for the rounds after it', () => {
    const trace = new EntropyTrace();
    trace.record({ text: 'inspect the composer props' });
    // A bare tool-call round: logprobs but no emitted text.
    const bare = trace.record({ text: '  ', sampled: [uniformTop(3)] });
    expect(bare?.klPrev).toBe(0); // nothing of its own to compare
    // The next real round is still measured against the last round that *had* text.
    const after = trace.record({ text: 'inspect the composer props' });
    expect(after?.klPrev).toBe(0);
    expect(after?.tokens).toBe(4);
  });

  it('prefers the engine distribution for entropy and reports both sources', () => {
    const r = new EntropyTrace().record({
      text: 'writing the answer out now',
      sampled: [uniformTop(5)],
    });
    expect(r?.source).toBe('logprobs');
    expect(r?.logprobs?.entropy).toBeCloseTo(Math.log(5), 10);
    // The empirical output entropy is still recorded alongside it.
    expect(r?.entropy).toBeGreaterThan(0);
  });

  it('falls back to text when the engine returned logprobs without top-k', () => {
    const r = new EntropyTrace().record({
      text: 'writing the answer out now',
      sampled: [{ token: 'a', logprob: -0.5 }],
    });
    expect(r?.source).toBe('text');
    expect(r?.logprobs?.surprisal).toBeCloseTo(0.5, 10);
  });
});

describe('EntropyTrace.summary', () => {
  it('is empty when nothing was recorded, so the caller can skip the line', () => {
    expect(new EntropyTrace().summary()).toBe('');
  });

  it('rolls up round count, entropy range and mean drift', () => {
    const trace = new EntropyTrace();
    trace.record({ text: 'alpha beta gamma delta' });
    trace.record({ text: 'epsilon zeta eta theta' });
    const summary = trace.summary();
    expect(summary).toContain('rounds=2');
    expect(summary).toContain('src=text');
    expect(summary).toMatch(/H=\d+\.\d\davg\(\d+\.\d\d\.\.\d+\.\d\d\)/);
    expect(summary).toMatch(/klPrev=\d+\.\d\davg/);
    expect(summary).toMatch(/klBase=\d+\.\d\dfinal/);
  });

  it('reports klPrev as n/a for a single-round turn rather than inventing a mean', () => {
    const trace = new EntropyTrace();
    trace.record({ text: 'alpha beta gamma' });
    expect(trace.summary()).toContain('klPrev=n/aavg');
  });
});

describe('formatEntropyReading', () => {
  it('leads with the engine entropy and its coverage when logprobs are present', () => {
    const r = new EntropyTrace().record({ text: 'some answer text', sampled: [uniformTop(4)] });
    const line = formatEntropyReading(r!);
    expect(line).toContain('src=logprobs');
    expect(line).toContain(`H=${Math.log(4).toFixed(2)}n`);
    expect(line).toContain('cover=1.00');
    expect(line).toContain('surprisal=');
    expect(line).toContain('positions=1');
  });

  it('reports normalized entropy when measuring from text alone', () => {
    const r = new EntropyTrace().record({ text: 'alpha beta gamma delta' });
    const line = formatEntropyReading(r!);
    expect(line).toContain('src=text');
    expect(line).toContain('(norm 1.00)');
    expect(line).toContain('klPrev=0.00 klBase=0.00 tokens=4');
    expect(line).not.toContain('positions=');
  });
});
