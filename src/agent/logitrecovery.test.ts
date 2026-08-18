import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  selectBiasWords,
  buildLogitBias,
  buildRuminationLogitBias,
  biasableShingles,
} from './logitrecovery.js';

describe('selectBiasWords', () => {
  it('drops stopwords and short words, frequency-ranks, and caps at max', () => {
    const shingles = [
      'the textarea overflow gutter padding because the layout overflow',
      'the textarea overflow gutter padding inset overflow layout',
    ];
    const words = selectBiasWords(shingles, { max: 3, minLen: 4 });
    expect(words).not.toContain('the'); // stopword
    expect(words).not.toContain('because'); // stopword
    expect(words.length).toBeLessThanOrEqual(3);
    expect(words[0]).toBe('overflow'); // most frequent distinctive word
  });

  it('returns empty when nothing survives the filter', () => {
    expect(selectBiasWords(['the a is to of and we it'], { max: 5, minLen: 4 })).toEqual([]);
  });
});

describe('buildLogitBias', () => {
  it('assembles a uniform map, dedups ids, drops exempt, and caps the count', () => {
    const bias = buildLogitBias({
      entryIds: [10, 10, 11, 12, 13],
      exempt: new Set([12]),
      bias: -4,
      cap: 2,
    });
    // 10 deduped, 12 exempt, capped at 2 so 13 never lands.
    expect(bias).toEqual({ 10: -4, 11: -4 });
  });
});

describe('buildRuminationLogitBias', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Deterministic fake tokenizer: each word's id is the char code of its first letter, so the test
  // can predict exactly which ids land in the map.
  const fakeTokenizer = () =>
    vi.fn(async (_url: string, init: { body: string }) => {
      const { content } = JSON.parse(init.body) as { content: string };
      const code = content.trim().charCodeAt(0);
      return new Response(JSON.stringify({ tokens: [code] }), { status: 200 });
    });

  it('biases the ruminated words and exempts tool-name entry tokens', async () => {
    vi.stubGlobal('fetch', fakeTokenizer());
    const shingles = ['overflow gutter padding layout overflow gutter padding inset'];
    const bias = await buildRuminationLogitBias({
      baseURL: 'http://x/v1',
      apiKey: '',
      shingles,
      toolNames: ['read'], // 'r' → 114, exempt
    });
    expect(bias).not.toBeNull();
    expect(bias![111]).toBe(-4); // 'o' (overflow)
    expect(bias![112]).toBe(-4); // 'p' (padding)
    expect(bias![114]).toBeUndefined(); // 'r' (read) exempted
  });

  it('honors a milder bias override (plan-mode uses a gentler value)', async () => {
    vi.stubGlobal('fetch', fakeTokenizer());
    const bias = await buildRuminationLogitBias({
      baseURL: 'http://x/v1',
      apiKey: '',
      shingles: ['overflow gutter padding layout overflow gutter padding inset'],
      toolNames: ['read'],
      bias: -3,
    });
    expect(bias).not.toBeNull();
    expect(bias![111]).toBe(-3); // 'o' (overflow) at the overridden magnitude
  });

  it('returns null when the backend cannot tokenize (no /tokenize)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const bias = await buildRuminationLogitBias({
      baseURL: 'http://x/v1',
      apiKey: '',
      shingles: ['overflow gutter padding layout inset margin'],
      toolNames: ['read'],
    });
    expect(bias).toBeNull();
  });

  it('returns null when no words survive the filter (nothing to bias)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const bias = await buildRuminationLogitBias({
      baseURL: 'http://x/v1',
      apiKey: '',
      shingles: ['the a is to of and we it'],
      toolNames: ['read'],
    });
    expect(bias).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); // short-circuits before any tokenize call
  });
});

describe('biasableShingles', () => {
  const span = [
    'the cache invalidation happens before the write completes so',
    'a second recurring gram here for the test',
  ];

  it('passes reasoning-channel shingles through for biasing', () => {
    expect(biasableShingles(span, 'reasoning')).toEqual(span);
  });

  // Content-channel repeats are the model's answer text, not filler thinking — biasing against them
  // is the loop-tokens-≡-work-tokens trap. Both hosts fail open on an empty span.
  it('withholds content-channel shingles so no bias is built', () => {
    expect(biasableShingles(span, 'content')).toEqual([]);
  });
});
