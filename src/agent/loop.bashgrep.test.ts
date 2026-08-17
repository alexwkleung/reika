import { describe, expect, it } from 'vitest';
import { isReadOnlyShell } from './loop.js';

describe('isReadOnlyShell', () => {
  // The read-only escapes actually observed in real loops — these must be refusable.
  it.each([
    'grep -n "isFavorite\\|toggleFavorite" web/src/scripts/state.ts | head -20',
    'cd /home/dev/example-app && grep -n "btn-favorite" web/src/components/NowPlaying.astro',
    'cd /home/dev/example-app && cat web/src/scripts/state.ts | tail -20',
    'grep -A 5 "favorite-btn" web/src/scripts/dom.ts | head -20',
    'cat web/src/components/NowPlaying.astro | grep -A 5 "btn-favorite"',
    'grep -n "repair-btn" web/src/scripts/dom.ts',
    'ls web/src/scripts',
    'find web/src -name "*.ts"',
    'wc -l web/src/scripts/dom.ts',
  ])('classifies read-only inspection as read-only: %s', cmd => {
    expect(isReadOnlyShell(cmd)).toBe(true);
  });

  // Mutating / build / write commands must NEVER be refused — refusing these is the expensive mistake.
  it.each([
    'npm run build',
    'npm run build 2>&1 | head -50', // redirection → write signal, bail to allowed
    'git commit -m "favorites"',
    'mkdir -p web/src/scripts',
    'grep foo bar > out.txt', // output redirection
    'cat a.ts > b.ts',
    'sed -i "s/x/y/" file.ts', // in-place edit
    'find . -name "*.tmp" -delete',
    'find . -name "*.ts" -exec rm {} \\;',
    'echo hi | tee log.txt',
    'rm -rf dist',
    'cd web && npm test',
    'grep foo file.ts && rm file.ts', // read-only THEN a mutator in the chain
  ])('classifies mutating/write commands as NOT read-only: %s', cmd => {
    expect(isReadOnlyShell(cmd)).toBe(false);
  });

  it('returns false for empty or whitespace-only commands', () => {
    expect(isReadOnlyShell('')).toBe(false);
    expect(isReadOnlyShell('   ')).toBe(false);
  });

  it('returns false when a cd hop leaves no inspection command', () => {
    expect(isReadOnlyShell('cd web/src')).toBe(false);
  });

  it('returns false for an unrecognized command anywhere in the pipeline', () => {
    expect(isReadOnlyShell('grep foo file | node script.js')).toBe(false);
    expect(isReadOnlyShell('curl example.com | grep foo')).toBe(false);
  });
});
