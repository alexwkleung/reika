import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../types.js';

const ocr = vi.hoisted(() => ({ result: { ok: true, text: 'hello' } as unknown }));
vi.mock('../ocr/system.js', () => ({ systemOcr: () => async () => ocr.result }));
vi.mock('../ocr/vision.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  visionOcr: () => async () => ocr.result,
}));

const { imageReadLabel, readImageAttachment } = await import('./imageattach.js');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cfg = (over: Partial<Config> = {}) => ({ model: 'local', ...over }) as Config;

describe('readImageAttachment (#979)', () => {
  it('hands native bytes on to a model that can see, reading nothing', async () => {
    const read = await readImageAttachment(png, cfg({ vision: 'native' }), 'image');
    expect(read).toMatchObject({
      ok: true,
      native: { mime: 'image/png' },
      detail: 'sent to local as an image',
    });
    expect(imageReadLabel(cfg({ vision: 'native' }))).toBeNull();
  });

  it('names the reader in the receipt and the label', async () => {
    ocr.result = { ok: true, text: 'hello' };
    expect(await readImageAttachment(png, cfg(), 'clipboard image')).toMatchObject({
      ok: true,
      text: 'hello',
      detail: '5 chars read from the clipboard image',
    });
    expect(imageReadLabel(cfg())).toBe('Extracting text');
    const vision = cfg({ visionModel: 'qwen-vl', baseURL: 'http://x', apiKey: 'k' });
    expect(await readImageAttachment(png, vision, 'image')).toMatchObject({
      detail: '5 chars described by qwen-vl',
    });
    expect(imageReadLabel(vision)).toBe('Describing image with qwen-vl');
  });

  it('words each failure for the user', async () => {
    ocr.result = { ok: false, reason: 'no-text' };
    expect(await readImageAttachment(png, null, 'image')).toEqual({
      ok: false,
      notice: 'No text found in the pasted image.',
    });
    ocr.result = { ok: false, reason: 'failed', detail: 'boom' };
    expect(await readImageAttachment(png, null, 'image')).toEqual({
      ok: false,
      notice: "Couldn't read the pasted image: boom",
    });
  });
});
