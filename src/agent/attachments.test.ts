import { describe, expect, it } from 'vitest';
import {
  attachImageBlocks,
  hasImageMarker,
  imageBlock,
  MAX_IMAGE_TEXT,
  nextImageMarker,
  truncateImageText,
  type ImageAttachment,
} from './attachments.js';

function attachment(marker: string, text = 'extracted'): ImageAttachment {
  return { marker, text, source: 'clipboard' };
}

describe('nextImageMarker', () => {
  it('starts at 1', () => {
    expect(nextImageMarker([])).toBe('[Image 1]');
  });

  it('counts up from the highest marker in use', () => {
    expect(nextImageMarker([attachment('[Image 1]'), attachment('[Image 2]')])).toBe('[Image 3]');
  });

  it('does not reuse a number after an earlier attachment was dropped', () => {
    // The user deleted [Image 1] from the buffer but [Image 2] is still there — reusing 1
    // would be fine, but reusing 2 would collide with a live marker.
    expect(nextImageMarker([attachment('[Image 2]')])).toBe('[Image 3]');
  });
});

describe('imageBlock', () => {
  it('renders attributes and text', () => {
    expect(imageBlock({ id: '1', source: 'clipboard' }, 'hello')).toBe(
      '<image id="1" source="clipboard">\nhello\n</image>',
    );
  });

  it('escapes quotes in attribute values so a filename cannot break the tag', () => {
    expect(imageBlock({ path: 'we"ird.png' }, 'x')).toContain('path="we&quot;ird.png"');
  });
});

describe('truncateImageText', () => {
  it('leaves text under the cap alone', () => {
    expect(truncateImageText('short')).toBe('short');
  });

  it('truncates past the cap and says how much was dropped', () => {
    const out = truncateImageText('a'.repeat(MAX_IMAGE_TEXT + 50));
    expect(out).toContain('…(truncated, 50 more chars)');
    expect(out.startsWith('a'.repeat(MAX_IMAGE_TEXT))).toBe(true);
  });
});

describe('attachImageBlocks', () => {
  it('returns the input untouched when nothing is attached', () => {
    expect(attachImageBlocks('plain', [])).toBe('plain');
  });

  it('prepends a block and leaves the marker inline for context', () => {
    const out = attachImageBlocks('why does [Image 1] happen', [attachment('[Image 1]', 'boom')]);
    expect(out).toBe(
      '<image id="1" source="clipboard">\nboom\n</image>\n\nwhy does [Image 1] happen',
    );
  });

  it('drops an attachment whose marker the user deleted while editing', () => {
    const out = attachImageBlocks('never mind', [attachment('[Image 1]', 'boom')]);
    expect(out).toBe('never mind');
  });

  it('keeps only the referenced attachments when several were pasted', () => {
    const out = attachImageBlocks('compare [Image 2] with this', [
      attachment('[Image 1]', 'first'),
      attachment('[Image 2]', 'second'),
    ]);
    expect(out).toContain('second');
    expect(out).not.toContain('first');
  });

  it('truncates an oversized extraction', () => {
    const out = attachImageBlocks('[Image 1]', [
      attachment('[Image 1]', 'b'.repeat(MAX_IMAGE_TEXT + 10)),
    ]);
    expect(out).toContain('…(truncated, 10 more chars)');
  });
});

describe('hasImageMarker', () => {
  it('detects a marker', () => {
    expect(hasImageMarker('see [Image 3] here')).toBe(true);
  });

  it('is not fooled by similar text', () => {
    expect(hasImageMarker('the image 3 shows')).toBe(false);
    expect(hasImageMarker('[image]')).toBe(false);
  });

  it('is not sticky across calls (shared regex lastIndex)', () => {
    expect(hasImageMarker('[Image 1]')).toBe(true);
    expect(hasImageMarker('[Image 1]')).toBe(true);
  });
});
