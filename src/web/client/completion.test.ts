import { describe, expect, it } from 'vitest';
import { MAX_COMPLETE_CHARS } from '../protocol.js';
import {
  acceptCompletion,
  completionRequestText,
  splitDisplay,
  wantsCompletion,
} from './completion.js';

describe('wantsCompletion', () => {
  it('asks for a command line or a trailing @word only', () => {
    expect(wantsCompletion('/mo')).toBe(true);
    expect(wantsCompletion('/model qw')).toBe(true);
    expect(wantsCompletion('look at @src/a')).toBe(true);
    expect(wantsCompletion('@')).toBe(true);
    expect(wantsCompletion('plain words')).toBe(false);
    expect(wantsCompletion('/two\nlines')).toBe(false);
    expect(wantsCompletion('mail me@ then more')).toBe(false);
    expect(wantsCompletion('')).toBe(false);
  });
});

describe('completionRequestText', () => {
  it('sends the text whole under the cap, and only the trailing @word past it', () => {
    expect(completionRequestText('see @app')).toBe('see @app');
    const long = `${'x '.repeat(MAX_COMPLETE_CHARS)}@app`;
    expect(completionRequestText(long)).toBe('@app');
    expect(completionRequestText(`${'x'.repeat(MAX_COMPLETE_CHARS + 1)}`)).toBe('');
  });
});

describe('acceptCompletion', () => {
  it('replaces the partial at the end of the text', () => {
    expect(acceptCompletion('look at @ap', '@src/app.ts', '@ap')).toBe('look at @src/app.ts');
    expect(acceptCompletion('/mo', '/model', '/mo')).toBe('/model');
  });
});

describe('splitDisplay', () => {
  it('splits a command from its description, a model from its group, and leaves a path whole', () => {
    expect(splitDisplay('/help  —  show this list')).toEqual({
      label: '/help',
      detail: 'show this list',
    });
    expect(splitDisplay('/model b  (go)')).toEqual({ label: '/model b', detail: 'go' });
    expect(splitDisplay('src/app.ts')).toEqual({ label: 'src/app.ts', detail: null });
  });
});
