import { describe, it, expect } from 'vitest';
import { isWarmableInput } from './warmtrigger.js';
import { rememberPaste } from './pastes.js';
import { nextImageMarker } from '../agent/attachments.js';

describe('isWarmableInput', () => {
  it('treats an ordinary first character as a prompt', () => {
    expect(isWarmableInput('f')).toBe(true);
  });

  it('does not treat an empty buffer as a prompt', () => {
    expect(isWarmableInput('')).toBe(false);
  });

  it('holds off on a slash command', () => {
    expect(isWarmableInput('/')).toBe(false);
    expect(isWarmableInput('/model')).toBe(false);
  });

  it('holds off on a file mention, before and after the path is typed (#202)', () => {
    expect(isWarmableInput('@')).toBe(false);
    expect(isWarmableInput('@src/ui/App.tsx explain this')).toBe(false);
  });

  it('holds off while the buffer stands in for a parked paste', () => {
    const { marker } = rememberPaste([], 'x\n'.repeat(40));
    expect(isWarmableInput(marker)).toBe(false);
    expect(isWarmableInput(`${marker} what does this do?`)).toBe(false);
  });

  it('holds off while the buffer stands in for a pasted image', () => {
    const marker = nextImageMarker([]);
    expect(isWarmableInput(`${marker} `)).toBe(false);
    expect(isWarmableInput(`fix the error in ${marker}`)).toBe(false);
  });

  it('warms once a mention-free prompt survives the leading characters', () => {
    expect(isWarmableInput('fix @src/ui/App.tsx')).toBe(true);
    expect(isWarmableInput('mail me at me@example.com')).toBe(true);
  });
});
