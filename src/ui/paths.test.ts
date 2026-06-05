import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { scrubPaths } from './paths.js';

describe('scrubPaths', () => {
  const home = homedir();
  const cwd = `${home}/project`;

  it('collapses a cwd-relative path to its relative form', () => {
    expect(scrubPaths(`"${cwd}/src/ui/App.tsx"`, cwd)).toBe('"src/ui/App.tsx"');
  });

  it('collapses paths outside cwd but under $HOME to ~', () => {
    expect(scrubPaths(`${home}/Downloads/x.txt`, cwd)).toBe('~/Downloads/x.txt');
  });

  it('prefers the cwd match over the home match (longer prefix wins)', () => {
    // cwd is itself under $HOME, so a naive home-first replace would mangle it.
    expect(scrubPaths(`${cwd}/a.ts`, cwd)).toBe('a.ts');
  });

  it('scrubs paths embedded mid-string (e.g. bash commands)', () => {
    expect(scrubPaths(`cat ${cwd}/foo.ts | wc -l`, cwd)).toBe('cat foo.ts | wc -l');
  });

  it('leaves strings without known prefixes untouched', () => {
    expect(scrubPaths('/etc/hosts', cwd)).toBe('/etc/hosts');
    expect(scrubPaths('no paths here', cwd)).toBe('no paths here');
  });
});
