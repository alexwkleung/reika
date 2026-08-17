import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { clearIdentity, setIdentity } from './identity.js';
import { displayCwd } from './scrub.js';

afterEach(() => clearIdentity());

// The splash and header carried their own copies of this; they were the two surfaces that stay
// on screen for a whole screen recording and the two that never picked up a later scrub layer.
describe('displayCwd', () => {
  const HOME = homedir();

  it('collapses a directory under $HOME', () => {
    expect(displayCwd(`${HOME}/Git/proj`)).toBe('~/Git/proj');
  });

  // Regression guard for the consolidation: scrubPaths matches `$HOME/` *with* the separator, so
  // routing this through it alone would print the full home path when reika is run from $HOME.
  it('collapses a cwd that is exactly $HOME', () => {
    expect(displayCwd(HOME)).toBe('~');
  });

  it('leaves a path outside $HOME alone', () => {
    expect(displayCwd('/opt/work/proj')).toBe('/opt/work/proj');
  });

  it('does not empty the field by scrubbing the cwd against itself', () => {
    expect(displayCwd('/opt/work/proj')).not.toBe('');
  });

  it('substitutes an identity token outside $HOME', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    expect(displayCwd('/Volumes/scratch/octocat/proj')).toBe('/Volumes/scratch/<user>/proj');
  });
});
