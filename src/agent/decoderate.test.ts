import { describe, expect, it } from 'vitest';
import { DecodeRate, decodeRate } from './decoderate.js';

// A call that spent `ttft` ms on prefill and then streamed for `decode` ms.
const timing = (ttftMs: number, decodeMs: number) => ({ ttftMs, totalMs: ttftMs + decodeMs });
const usage = (completionTokens: number) => ({ promptTokens: 5000, completionTokens });

describe('decodeRate', () => {
  it('divides the generated tokens by the window after the first token', () => {
    // 600 tokens in 30 s, with 10 s of prefill in the call that must not count.
    expect(decodeRate(usage(600), timing(10_000, 30_000))).toBeCloseTo(20, 5);
  });

  it('measures nothing when no timing came back — an empty or aborted stream', () => {
    expect(decodeRate(usage(600), undefined)).toBeUndefined();
  });

  it('measures nothing without a token count to divide', () => {
    // A provider that doesn't report usage, or the note rounds' empty reply.
    expect(decodeRate(undefined, timing(10_000, 30_000))).toBeUndefined();
    expect(decodeRate(usage(0), timing(10_000, 30_000))).toBeUndefined();
  });

  // A 40-token tool call is 0.4 s of clock at 100 tok/s, where one late chunk moves the quotient by
  // tens of tok/s — the sample is the engine's chunking, not its throughput.
  it('rejects a window too short or a run too small to be about throughput', () => {
    expect(decodeRate(usage(40), timing(5_000, 100))).toBeUndefined();
    expect(decodeRate(usage(8), timing(5_000, 4_000))).toBeUndefined();
  });

  it('rejects a rate outside the plausible band, which is a clock artifact', () => {
    // 20 tokens over an hour is a stall, not a rate.
    expect(decodeRate(usage(20), timing(1_000, 3_600_000))).toBeUndefined();
    // 100k tokens in 1 s is inconsistent accounting.
    expect(decodeRate(usage(100_000), timing(1_000, 1_000))).toBeUndefined();
  });
});

describe('DecodeRate', () => {
  it('learns a rate from the first usable round', () => {
    const r = new DecodeRate();
    expect(r.get()).toBeUndefined();
    expect(r.observe(usage(600), timing(10_000, 30_000))).toBeCloseTo(20, 5);
    expect(r.get()).toBeCloseTo(20, 5);
  });

  it('keeps the rate it had when a round is too small to measure', () => {
    const r = new DecodeRate();
    r.observe(usage(600), timing(10_000, 30_000));
    expect(r.observe(usage(8), timing(1_000, 50))).toBeUndefined();
    expect(r.get()).toBeCloseTo(20, 5);
  });

  it('smooths rather than jumping to the newest sample', () => {
    const r = new DecodeRate();
    r.observe(usage(600), timing(0, 30_000)); // 20 tok/s
    expect(r.observe(usage(6000), timing(0, 30_000))).toBeCloseTo(20 * 0.7 + 200 * 0.3, 5);
  });

  it('seeds from the prior turn so the first round of a turn is not blank', () => {
    expect(new DecodeRate(21.5).get()).toBe(21.5);
    // A seed outside the plausible band is a corrupt value, not a starting point.
    expect(new DecodeRate(1).get()).toBe(1);
    expect(new DecodeRate(0).get()).toBeUndefined();
    expect(new DecodeRate(Number.NaN).get()).toBeUndefined();
  });
});
