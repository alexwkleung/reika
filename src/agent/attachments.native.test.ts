import { describe, expect, it, vi } from 'vitest';
import { readNativeAttachments, type ImageAttachment } from './attachments.js';
import { nativeImageReminder } from './loop.js';

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// A native attachment sent on a profile that can't see (a /model switch, or a queued message
// replayed after one) is read at send time rather than handing bytes to a text-only model.
describe('readNativeAttachments', () => {
  it('reads native attachments into text and drops their bytes', async () => {
    const ocr = vi.fn(async () => ({ ok: true as const, text: 'a stack trace' }));
    const attachments: ImageAttachment[] = [
      {
        marker: '[Image 1]',
        text: 'note',
        source: 'clipboard',
        native: { bytes, mime: 'image/png' },
      },
      { marker: '[Image 2]', text: 'already read', source: 'clipboard' },
    ];
    const out = await readNativeAttachments(attachments, ocr);
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(out.attachments).toEqual([
      { marker: '[Image 1]', text: 'a stack trace', source: 'clipboard' },
      { marker: '[Image 2]', text: 'already read', source: 'clipboard' },
    ]);
    expect(out.failed).toEqual([]);
  });

  it('reports a read that failed, without sending the bytes anyway', async () => {
    const ocr = async () => ({ ok: false as const, reason: 'failed' as const });
    const out = await readNativeAttachments(
      [
        {
          marker: '[Image 1]',
          text: 'note',
          source: 'clipboard',
          native: { bytes, mime: 'image/png' },
        },
      ],
      ocr,
    );
    expect(out.failed).toEqual(['[Image 1]']);
    expect(out.attachments[0].native).toBeUndefined();
  });
});

// The plan force-write rebuilds the request from a truncated task, often without the marker that
// ties an image to the message — the reminder names it so the image rides that round.
describe('nativeImageReminder', () => {
  it('names every live marker', () => {
    const images = ['[Image 1]', '[Image 3]'].map(marker => ({ marker, bytes, mime: 'image/png' }));
    const text = nativeImageReminder(images);
    expect(text).toContain('[Image 1]');
    expect(text).toContain('[Image 3]');
  });

  it('adds nothing without images', () => {
    expect(nativeImageReminder(undefined)).toBe('');
    expect(nativeImageReminder([])).toBe('');
  });
});
