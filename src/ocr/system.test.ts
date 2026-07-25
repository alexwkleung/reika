import { describe, expect, it } from 'vitest';
import { recognizeWith } from './system.js';

const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function stub(impl: () => Promise<{ text: string; confidence: number }>) {
  return { recognize: impl };
}

describe('recognizeWith', () => {
  it('returns the recognized text, trimmed', async () => {
    const out = await recognizeWith(
      stub(async () => ({ text: '  TypeError: boom\n', confidence: 0.9 })),
      IMAGE,
    );
    expect(out).toEqual({ ok: true, text: 'TypeError: boom' });
  });

  it('keeps text that the recognizer scored as low confidence', async () => {
    // Vision reports ~0.44 on character-perfect extractions, so confidence must not gate.
    const out = await recognizeWith(
      stub(async () => ({ text: 'readable', confidence: 0.01 })),
      IMAGE,
    );
    expect(out).toEqual({ ok: true, text: 'readable' });
  });

  it('maps an all-whitespace result to no-text', async () => {
    const out = await recognizeWith(
      stub(async () => ({ text: '   \n ', confidence: 0.9 })),
      IMAGE,
    );
    expect(out).toEqual({ ok: false, reason: 'no-text' });
  });

  it('maps the "No text recognized" throw to no-text, not a failure', async () => {
    const out = await recognizeWith(
      stub(async () => {
        throw new Error('No text recognized');
      }),
      IMAGE,
    );
    expect(out).toEqual({ ok: false, reason: 'no-text' });
  });

  it('reports any other throw as a failure with its detail', async () => {
    const out = await recognizeWith(
      stub(async () => {
        throw new Error('image decode failed');
      }),
      IMAGE,
    );
    expect(out).toEqual({ ok: false, reason: 'failed', detail: 'image decode failed' });
  });

  it('passes configured languages through, and omits an empty list', async () => {
    const seen: unknown[] = [];
    const mod = {
      recognize: async (_img: Uint8Array, _acc?: unknown, langs?: string[] | null) => {
        seen.push(langs);
        return { text: 'x', confidence: 1 };
      },
    };
    await recognizeWith(mod, IMAGE, ['ja-JP']);
    await recognizeWith(mod, IMAGE, []);
    await recognizeWith(mod, IMAGE);
    expect(seen).toEqual([['ja-JP'], null, null]);
  });
});
