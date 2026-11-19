import { describe, expect, it } from 'vitest';
import { continuationMarker, continuationTail } from '../agent/continuation.js';
import { stripHarnessEcho } from './harnessecho.js';

describe('stripHarnessEcho', () => {
  // The sighted reply (#745): the model's own count, not the harness's, and a stub reika never emits.
  it('drops a copied continuation marker and an invented stub from the head of a reply', () => {
    const content = [
      '[reika: 26476 chars of your earlier reasoning trimmed to fit — what follows is your most recent working]',
      '',
      '[tool result omitted: repeated from earlier]',
      '',
      'Now a quick look at the test file additions.',
    ].join('\n');
    expect(stripHarnessEcho(content)).toBe('Now a quick look at the test file additions.');
  });

  it('drops the exact marker a carried tail opens with', () => {
    const tail = continuationTail('x'.repeat(50) + '\n\nthe most recent working', 30).text;
    expect(tail.startsWith('[reika: ')).toBe(true);
    expect(stripHarnessEcho(tail)).toBe('the most recent working');
  });

  it("drops reika's parenthesized dedup-stub voice too", () => {
    expect(stripHarnessEcho('(reika: repeat of an earlier identical result — omitted)\nok')).toBe(
      'ok',
    );
  });

  it('returns an empty reply when the marker was all there was', () => {
    expect(stripHarnessEcho(continuationMarker(10))).toBe('');
  });

  // Past the head the same text is the model quoting reika on purpose — a review of this code.
  it('leaves a marker quoted further down the reply alone', () => {
    const content = 'The tail opens with\n[reika: 12 chars trimmed]\nwhich the model then copies.';
    expect(stripHarnessEcho(content)).toBe(content);
  });

  it('leaves a reply that opens with an ordinary bracket or a markdown link alone', () => {
    expect(stripHarnessEcho('[Note] the build is green.')).toBe('[Note] the build is green.');
    expect(stripHarnessEcho('[docs](https://example.com) say so.')).toBe(
      '[docs](https://example.com) say so.',
    );
    expect(stripHarnessEcho('  indented reply')).toBe('  indented reply');
  });
});
