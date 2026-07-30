import { describe, it, expect } from 'vitest';
import {
  expandPastes,
  isLargePaste,
  rememberPaste,
  MAX_PASTE_STORE_CHARS,
  PASTE_CHAR_THRESHOLD,
  PASTE_LINE_THRESHOLD,
} from './pastes.js';

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

describe('isLargePaste', () => {
  it('leaves a short multi-line paste in the buffer', () => {
    expect(isLargePaste(lines(PASTE_LINE_THRESHOLD - 1))).toBe(false);
  });

  it('catches a paste at the line threshold', () => {
    expect(isLargePaste(lines(PASTE_LINE_THRESHOLD))).toBe(true);
  });

  it('catches one enormous line, which wraps to just as many rows', () => {
    expect(isLargePaste('x'.repeat(PASTE_CHAR_THRESHOLD))).toBe(true);
    expect(isLargePaste('x'.repeat(PASTE_CHAR_THRESHOLD - 1))).toBe(false);
  });

  it('ignores a trailing newline when counting lines', () => {
    expect(isLargePaste(lines(PASTE_LINE_THRESHOLD - 1) + '\n')).toBe(false);
  });
});

describe('rememberPaste', () => {
  it('mints a numbered marker', () => {
    const { marker } = rememberPaste([], lines(400));
    expect(marker).toBe('[Pasted text #1]');
  });

  it('numbers each paste so two of them stay distinguishable', () => {
    const first = rememberPaste([], lines(20));
    const second = rememberPaste(first.pastes, lines(20));
    expect(second.marker).toBe('[Pasted text #2]');
    expect(second.pastes).toHaveLength(2);
  });

  it('drops the oldest pastes once the store is over its cap', () => {
    const big = 'x'.repeat(MAX_PASTE_STORE_CHARS - 10);
    const first = rememberPaste([], big);
    const second = rememberPaste(first.pastes, big);
    expect(second.pastes.map(p => p.marker)).toEqual([second.marker]);
  });
});

describe('expandPastes', () => {
  it('splices the text back in where the marker sits', () => {
    const { pastes, marker } = rememberPaste([], 'a\nb\nc');
    expect(expandPastes(`explain ${marker} please`, pastes)).toBe('explain a\nb\nc please');
  });

  it('expands every marker in the prompt', () => {
    const first = rememberPaste([], 'ONE');
    const second = rememberPaste(first.pastes, 'TWO');
    expect(expandPastes(`${first.marker} vs ${second.marker}`, second.pastes)).toBe('ONE vs TWO');
  });

  it('leaves a marker the user deleted out of the prompt entirely', () => {
    const { pastes } = rememberPaste([], 'dropped');
    expect(expandPastes('never mind', pastes)).toBe('never mind');
  });

  it('leaves an unbacked marker literal rather than dropping it', () => {
    expect(expandPastes('see [Pasted text #9]', [{ marker: '[Pasted text #1]', text: 'x' }])).toBe(
      'see [Pasted text #9]',
    );
  });

  it('never re-reads pasted text as another marker', () => {
    const pastes = [
      { marker: '[Pasted text #1]', text: '[Pasted text #2]' },
      { marker: '[Pasted text #2]', text: 'INNER' },
    ];
    expect(expandPastes('[Pasted text #1]', pastes)).toBe('[Pasted text #2]');
  });

  it('treats $-sequences in pasted text as literal', () => {
    const { pastes, marker } = rememberPaste([], 'cost is $&$1 total');
    expect(expandPastes(marker, pastes)).toBe('cost is $&$1 total');
  });
});
