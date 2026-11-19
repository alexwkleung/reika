import { describe, expect, it } from 'vitest';
import { composerTokens } from './composertokens.js';

describe('composerTokens', () => {
  it('bubbles a leading command and the paste and image markers', () => {
    expect(composerTokens('/review 412')).toEqual([
      { text: '/review', token: 'command' },
      { text: ' 412' },
    ]);
    expect(composerTokens('/mcp')).toEqual([{ text: '/mcp', token: 'command' }]);
    expect(composerTokens('see [Image 1] and [Pasted text #2 +400 lines] here')).toEqual([
      { text: 'see ' },
      { text: '[Image 1]', token: 'marker' },
      { text: ' and ' },
      { text: '[Pasted text #2 +400 lines]', token: 'marker' },
      { text: ' here' },
    ]);
  });

  it('leaves a path, a mid-line slash and a half-typed marker alone', () => {
    expect(composerTokens('/Users/octocat/a.ts is broken')).toEqual([
      { text: '/Users/octocat/a.ts is broken' },
    ]);
    expect(composerTokens('/tmp/x')).toEqual([{ text: '/tmp/x' }]);
    expect(composerTokens('run /review')).toEqual([{ text: 'run /review' }]);
    expect(composerTokens('[Image ')).toEqual([{ text: '[Image ' }]);
  });

  it('chips an @file mention where the mention parser reads one, not an email address', () => {
    expect(composerTokens('look at @src/a.ts and @b.md')).toEqual([
      { text: 'look at ' },
      { text: '@src/a.ts', token: 'file' },
      { text: ' and ' },
      { text: '@b.md', token: 'file' },
    ]);
    expect(composerTokens('@README.md')).toEqual([{ text: '@README.md', token: 'file' }]);
    expect(composerTokens('mail octocat@example.com')).toEqual([
      { text: 'mail octocat@example.com' },
    ]);
  });
});
