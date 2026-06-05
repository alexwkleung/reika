import { describe, expect, it } from 'vitest';
import {
  computeMaxTokens,
  shouldRetryTruncated,
  BUDGET_MARGIN_TOKENS,
  MAX_LENGTH_RETRIES,
} from './budget.js';

describe('computeMaxTokens', () => {
  it('returns the user cap unchanged when no window is known', () => {
    expect(computeMaxTokens({ promptTokens: 5000, userMaxTokens: 2048 })).toBe(2048);
    expect(computeMaxTokens({ promptTokens: 5000 })).toBeUndefined();
  });

  it('caps generation to the room left in the window', () => {
    const window = 16384;
    const promptTokens = 10000;
    expect(computeMaxTokens({ contextWindow: window, promptTokens })).toBe(
      window - promptTokens - BUDGET_MARGIN_TOKENS,
    );
  });

  it('shrinks as the prompt grows (dynamic per-turn budget)', () => {
    const window = 16384;
    const small = computeMaxTokens({ contextWindow: window, promptTokens: 4000 })!;
    const large = computeMaxTokens({ contextWindow: window, promptTokens: 12000 })!;
    expect(large).toBeLessThan(small);
  });

  it('honors an explicit user cap as a ceiling, never raising it', () => {
    // Plenty of room, but the user asked for at most 1024 — respect it.
    expect(
      computeMaxTokens({ contextWindow: 32768, promptTokens: 1000, userMaxTokens: 1024 }),
    ).toBe(1024);
  });

  it('clamps the user cap down to the room actually left', () => {
    // User asked for 8192 but only ~2000 tokens fit — give what fits, not the wish.
    const window = 16384;
    const promptTokens = 14000;
    const fits = window - promptTokens - BUDGET_MARGIN_TOKENS;
    expect(computeMaxTokens({ contextWindow: window, promptTokens, userMaxTokens: 8192 })).toBe(
      fits,
    );
  });

  it('never returns below the 256-token last-resort floor', () => {
    // Prompt nearly fills the window: still hand back a few tokens, not zero/negative.
    expect(computeMaxTokens({ contextWindow: 16384, promptTokens: 16384 })).toBe(256);
  });
});

describe('shouldRetryTruncated', () => {
  it('retries a length-stop with no tool call, within the retry budget', () => {
    expect(
      shouldRetryTruncated({ finishReason: 'length', hasToolCalls: false, priorRetries: 0 }),
    ).toBe(true);
  });

  it('does not retry a normal (non-length) finish', () => {
    expect(
      shouldRetryTruncated({ finishReason: 'stop', hasToolCalls: false, priorRetries: 0 }),
    ).toBe(false);
    expect(
      shouldRetryTruncated({ finishReason: undefined, hasToolCalls: false, priorRetries: 0 }),
    ).toBe(false);
  });

  it('leaves a length-stop alone when it still produced a tool call', () => {
    // The call closed before the cut, so it's usable — proceed normally.
    expect(
      shouldRetryTruncated({ finishReason: 'length', hasToolCalls: true, priorRetries: 0 }),
    ).toBe(false);
  });

  it('stops after MAX_LENGTH_RETRIES consecutive truncations (no infinite loop)', () => {
    expect(
      shouldRetryTruncated({
        finishReason: 'length',
        hasToolCalls: false,
        priorRetries: MAX_LENGTH_RETRIES,
      }),
    ).toBe(false);
  });
});
