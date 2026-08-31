import { describe, it, expect } from 'vitest';
import { isWarmEdge, isWarmableInput } from './warmtrigger.js';
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

  it('holds off on an image path dragged into the box, absolute or relative', () => {
    // A drop inserts a bare path with no '@'. The absolute form also happens to start with
    // '/', so assert both — the slash rule must not be the only thing covering this.
    expect(isWarmableInput('/Users/dev/Desktop/screenshot.png')).toBe(false);
    expect(isWarmableInput('./shot.png')).toBe(false);
    expect(isWarmableInput('assets/logo.png what is wrong here')).toBe(false);
  });

  it('lets an image filename with no path through — nothing expands it', () => {
    expect(isWarmableInput('rename shot.png to logo.png')).toBe(true);
  });

  it('warms once a mention-free prompt survives the leading characters', () => {
    expect(isWarmableInput('fix @src/ui/App.tsx')).toBe(true);
    expect(isWarmableInput('mail me at me@example.com')).toBe(true);
  });
});

// Each keystroke as (previous buffer, next buffer); true means the warm fires on that edit.
const type = (steps: string[]): boolean[] =>
  steps.slice(1).map((next, i) => isWarmEdge(steps[i], next));

describe('isWarmEdge', () => {
  it('fires once on the keystroke that opens a prompt', () => {
    expect(type(['', 'f', 'fi', 'fix'])).toEqual([true, false, false]);
  });

  it('stays quiet through a mention typed from an empty box', () => {
    expect(type(['', '@', '@sr', '@src/ui/App.tsx'])).toEqual([false, false, false]);
  });

  it('does not fire when a mention is retyped after backspacing a prompt away', () => {
    // The predicate reads only the buffer in front of it, so '@' is no more warmable at the
    // start of the second prompt than it was at the start of the session.
    expect(type(['', 'f', 'fix', 'fi', 'f', '', '@', '@s'])).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('does not fire when a slash command is retyped after backspacing a mention away', () => {
    expect(type(['', '@', '', '/', '/m'])).toEqual([false, false, false, false]);
  });

  it('re-arms when the box is cleared and prose is typed again', () => {
    expect(type(['fix', '', 'r'])).toEqual([false, true]);
  });

  it('arms when a leading slash is deleted off an otherwise ordinary prompt', () => {
    expect(type(['/fix it', 'fix it'])).toEqual([true]);
  });

  it('does not re-fire once a mention is appended to a warmed prompt', () => {
    expect(type(['', 'f', 'fix ', 'fix @src/ui/App.tsx'])).toEqual([true, false, false]);
  });
});
