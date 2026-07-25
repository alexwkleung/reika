import { describe, expect, it } from 'vitest';
import { parseAppleScriptData } from './clipboard.js';

describe('parseAppleScriptData', () => {
  it('decodes the «data PNGf…» literal osascript prints', () => {
    const out = parseAppleScriptData('«data PNGf89504E470D0A1A0A»\n');
    expect(out?.subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('tolerates the whitespace osascript may wrap long payloads with', () => {
    const out = parseAppleScriptData('«data PNGf8950\n  4E47 0D0A1A0A»');
    expect(out?.toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('accepts other four-character type codes (a TIFF-only clipboard)', () => {
    expect(parseAppleScriptData('«data TIFF4D4D002A»')?.toString('hex')).toBe('4d4d002a');
  });

  it('returns null for the text osascript prints when the clipboard holds a string', () => {
    expect(parseAppleScriptData('just some copied text')).toBeNull();
  });

  it('returns null for an empty payload rather than a zero-length image', () => {
    expect(parseAppleScriptData('«data PNGf»')).toBeNull();
  });
});
