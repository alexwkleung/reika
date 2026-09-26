import { describe, expect, it } from 'vitest';
import type { EngineTimings } from '../provider/client.js';
import {
  DecodeRate,
  decodeSample,
  derivedDecodeRate,
  engineDecodeRate,
  formatRate,
} from './decoderate.js';

// A call that spent `ttft` ms on prefill and then streamed for `decode` ms.
const timing = (ttftMs: number, decodeMs: number) => ({ ttftMs, totalMs: ttftMs + decodeMs });
const usage = (completionTokens: number) => ({ promptTokens: 5000, completionTokens });
// The same round as the engine reported it (#536): `predictedN` tokens over `predictedMs`, at
// `perSecond`.
const engine = (predictedN: number, predictedMs: number, perSecond: number): EngineTimings => ({
  predictedN,
  predictedMs,
  perSecond,
});

describe('derivedDecodeRate', () => {
  it('divides the tokens after the first by the window after the first token', () => {
    // 601 tokens: the first opens the window, the other 600 land in its 30 s. The 10 s of prefill
    // in the call must not count.
    expect(derivedDecodeRate(usage(601), timing(10_000, 30_000))).toBeCloseTo(20, 5);
  });

  // The window never timed the first token, so counting it overshoots by n/(n-1) — the same n-1
  // the engine divides, and the bound applies to it the same way.
  it('does not credit the window with the token that opened it', () => {
    expect(derivedDecodeRate(usage(17), timing(5_000, 1_000))).toBeCloseTo(16, 5);
    expect(derivedDecodeRate(usage(16), timing(5_000, 1_000))).toBeUndefined();
  });

  it('measures nothing when no timing came back — an empty or aborted stream', () => {
    expect(derivedDecodeRate(usage(600), undefined)).toBeUndefined();
  });

  it('measures nothing without a token count to divide', () => {
    // A provider that doesn't report usage, or the note rounds' empty reply.
    expect(derivedDecodeRate(undefined, timing(10_000, 30_000))).toBeUndefined();
    expect(derivedDecodeRate(usage(0), timing(10_000, 30_000))).toBeUndefined();
  });

  // A 40-token tool call is 0.4 s of clock at 100 tok/s, where one late chunk moves the quotient by
  // tens of tok/s — the sample is the engine's chunking, not its throughput.
  it('rejects a window too short or a run too small to be about throughput', () => {
    expect(derivedDecodeRate(usage(40), timing(5_000, 100))).toBeUndefined();
    expect(derivedDecodeRate(usage(8), timing(5_000, 4_000))).toBeUndefined();
  });

  it('rejects a rate outside the plausible band, which is a clock artifact', () => {
    // 20 tokens over an hour is a stall, not a rate.
    expect(derivedDecodeRate(usage(20), timing(1_000, 3_600_000))).toBeUndefined();
    // 100k tokens in 1 s is inconsistent accounting.
    expect(derivedDecodeRate(usage(100_000), timing(1_000, 1_000))).toBeUndefined();
  });
});

describe('engineDecodeRate', () => {
  it('reads the rate the engine measured', () => {
    expect(engineDecodeRate(engine(600, 30_000, 19.5))).toBe(19.5);
  });

  // The engine's window, and the quotient above it, are about n-1 tokens: the first one falls out
  // of the last prompt batch's logits and costs no decode step. Bounding the full count would admit
  // exactly the small rounds the bound exists for.
  it('bounds the count the rate divides, not the count the round produced', () => {
    expect(engineDecodeRate(engine(16, 5_000, 60))).toBeUndefined();
    expect(engineDecodeRate(engine(17, 5_000, 60))).toBe(60);
  });

  // The same bounds as the derivation, and each means the same thing here: the engine rates the
  // same round we do, so a round carries a measurement under both sources or under neither.
  it('rejects a window too short or a rate outside the plausible band', () => {
    expect(engineDecodeRate(engine(600, 100, 60))).toBeUndefined();
    expect(engineDecodeRate(engine(600, 30_000, 0))).toBeUndefined();
    expect(engineDecodeRate(engine(600, 30_000, 20_000))).toBeUndefined();
    expect(engineDecodeRate(engine(600, 30_000, Number.NaN))).toBeUndefined();
  });

  it('measures nothing when the engine reported no stats at all', () => {
    expect(engineDecodeRate(undefined)).toBeUndefined();
  });
});

describe('decodeSample', () => {
  // The split this exists for (#536): on a local engine the derived rate ran 1.5-2.5 tok/s above the
  // number the server itself reported, so wherever there is an engine number it is the round's
  // answer — 600 tokens over a 30 s window derives 20, and the engine reports 19.5.
  it('prefers the engine number over our own derivation', () => {
    expect(decodeSample(usage(600), timing(10_000, 30_000), engine(600, 30_000, 19.5))).toEqual({
      rate: 19.5,
      source: 'engine',
    });
  });

  it('derives the rate for an endpoint that reports no stats', () => {
    expect(decodeSample(usage(601), timing(10_000, 30_000))).toEqual({
      rate: 20,
      source: 'derived',
    });
  });

  // A round the engine declined to rate is not handed to the derivation: 16 tokens is 15 decode
  // steps, under the bound, while the derivation's full count and longer window would clear it —
  // readmitting exactly the small round the n-1 bound exists to keep out, at the high-reading rate.
  it('offers no sample when the engine rejected its own round', () => {
    expect(decodeSample(usage(16), timing(10_000, 300), engine(16, 250, 64))).toBeUndefined();
    expect(decodeSample(usage(600), timing(10_000, 30_000), engine(600, 150, 60))).toBeUndefined();
  });

  it('offers no sample when neither source can carry the round', () => {
    expect(decodeSample(usage(8), timing(5_000, 50), engine(8, 50, 160))).toBeUndefined();
    expect(decodeSample(undefined, undefined)).toBeUndefined();
  });
});

describe('DecodeRate', () => {
  const sample = (rate: number, source: 'engine' | 'derived' = 'derived') => ({ rate, source });

  it('learns a rate from the first usable round', () => {
    const r = new DecodeRate();
    expect(r.get()).toBeUndefined();
    expect(r.observe(sample(20))).toBeCloseTo(20, 5);
    expect(r.get()).toBeCloseTo(20, 5);
  });

  it('keeps the rate it had when a round offers no sample', () => {
    const r = new DecodeRate();
    r.observe(sample(20));
    expect(r.observe(undefined)).toBeUndefined();
    expect(r.get()).toBeCloseTo(20, 5);
  });

  it('smooths rather than jumping to the newest sample', () => {
    const r = new DecodeRate();
    r.observe(sample(20));
    expect(r.observe(sample(200))).toBeCloseTo(20 * 0.7 + 200 * 0.3, 5);
  });

  // Provenance is the debug line's business, not the fold's: an engine's number and ours both mean
  // "how fast this round decoded", so a source switch mid-session keeps folding rather than
  // restarting. Only a different engine (a subagent's endpoint) starts a new learner.
  it('folds an engine sample over a derived one without distinguishing them', () => {
    const r = new DecodeRate();
    r.observe(sample(20, 'derived'));
    expect(r.observe(sample(30, 'engine'))).toBeCloseTo(20 * 0.7 + 30 * 0.3, 5);
  });

  it('seeds from the prior turn so the first round of a turn is not blank', () => {
    expect(new DecodeRate(21.5).get()).toBe(21.5);
    // A seed outside the plausible band is a corrupt value, not a starting point.
    expect(new DecodeRate(1).get()).toBe(1);
    expect(new DecodeRate(0).get()).toBeUndefined();
    expect(new DecodeRate(Number.NaN).get()).toBeUndefined();
  });
});

describe('formatRate', () => {
  it('prints whole numbers from 10 up and one decimal below', () => {
    expect(formatRate(19.77)).toBe('20tok/s');
    expect(formatRate(8.44)).toBe('8.4tok/s');
    expect(formatRate(1204.3)).toBe('1204tok/s');
  });

  // The log's field shape, not an omitted one: a round that measured nothing has to say so, and `?`
  // is what makes `decode=? smoothed=20tok/s` readable as "this round measured nothing, the chip is
  // still showing the last rate" rather than as a value that went missing.
  it('states a missing value rather than dropping the field', () => {
    expect(formatRate(undefined)).toBe('?');
  });
});
