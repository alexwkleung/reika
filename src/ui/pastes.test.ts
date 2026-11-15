import { describe, it, expect } from 'vitest';
import {
  adoptPastes,
  expandPastes,
  hasPasteMarker,
  isPasteMarker,
  pasteMarkersIn,
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
  it('mints a numbered marker naming the line count', () => {
    const { marker } = rememberPaste([], lines(400));
    expect(marker).toBe('[Pasted text #1 +400 lines]');
  });

  it('names chars when the paste is a single long line', () => {
    const { marker } = rememberPaste([], 'x'.repeat(2000));
    expect(marker).toBe('[Pasted text #1 +2000 chars]');
  });

  it('numbers each paste so two of the same size stay distinguishable', () => {
    const first = rememberPaste([], lines(20));
    const second = rememberPaste(first.pastes, lines(20));
    expect(second.marker).toBe('[Pasted text #2 +20 lines]');
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
    const pastes = [{ marker: '[Pasted text #1 +2 lines]', text: 'x' }];
    expect(expandPastes('see [Pasted text #9 +3 lines]', pastes)).toBe(
      'see [Pasted text #9 +3 lines]',
    );
  });

  it('never re-reads pasted text as another marker', () => {
    const pastes = [
      { marker: '[Pasted text #1 +1 lines]', text: '[Pasted text #2 +1 lines]' },
      { marker: '[Pasted text #2 +1 lines]', text: 'INNER' },
    ];
    expect(expandPastes('[Pasted text #1 +1 lines]', pastes)).toBe('[Pasted text #2 +1 lines]');
  });

  it('treats $-sequences in pasted text as literal', () => {
    const { pastes, marker } = rememberPaste([], 'cost is $&$1 total');
    expect(expandPastes(marker, pastes)).toBe('cost is $&$1 total');
  });
});

describe('hasPasteMarker', () => {
  it('sees a marker this module minted', () => {
    const { marker } = rememberPaste([], lines(PASTE_LINE_THRESHOLD));
    expect(hasPasteMarker(`${marker} explain`)).toBe(true);
  });

  it('is not fooled by prose about a paste', () => {
    expect(hasPasteMarker('the pasted text above')).toBe(false);
    expect(hasPasteMarker('[Pasted text]')).toBe(false);
  });

  it('does not carry lastIndex between calls', () => {
    const { marker } = rememberPaste([], lines(PASTE_LINE_THRESHOLD));
    expect(hasPasteMarker(marker)).toBe(true);
    expect(hasPasteMarker(marker)).toBe(true);
  });
});

describe('isPasteMarker', () => {
  it('takes a whole marker and nothing else', () => {
    expect(isPasteMarker('[Pasted text #3 +412 lines]')).toBe(true);
    expect(isPasteMarker('[Pasted text #3 +1500 chars]')).toBe(true);
    expect(isPasteMarker(' [Pasted text #3 +412 lines]')).toBe(false);
    expect(isPasteMarker('[Pasted text #3 +412 lines] and more')).toBe(false);
    expect(isPasteMarker('[Pasted text #x +4 lines]')).toBe(false);
    expect(isPasteMarker('')).toBe(false);
  });
});

describe('adoptPastes', () => {
  const big = (tag: string) => `${tag}\n`.repeat(PASTE_LINE_THRESHOLD);
  const tab = (id: number, text: string) => ({
    marker: `[Pasted text #${id} +${PASTE_LINE_THRESHOLD} lines]`,
    text,
  });

  it('gives each incoming paste a marker of the store, in one pass', () => {
    const own = rememberPaste([], big('own'));
    // The tab's #1 and #2 become the store's #2 and #3; a sequential rewrite would turn the new #2
    // into #3 when it reached the tab's #2.
    const incoming = [tab(1, big('a')), tab(2, big('b'))];
    const out = adoptPastes(
      own.pastes,
      `x ${incoming[0].marker} y ${incoming[1].marker}`,
      incoming,
    );
    expect(out.text).toBe(
      `x [Pasted text #2 +${PASTE_LINE_THRESHOLD} lines] y [Pasted text #3 +${PASTE_LINE_THRESHOLD} lines]`,
    );
    expect(expandPastes(out.text, out.pastes)).toBe(`x ${big('a')} y ${big('b')}`);
  });

  it("leaves the store's own markers from a recalled line alone", () => {
    const own = rememberPaste([], big('own'));
    const incoming = [tab(5, big('new'))];
    const out = adoptPastes(own.pastes, `${own.marker} then ${incoming[0].marker}`, incoming);
    expect(expandPastes(out.text, out.pastes)).toBe(`${big('own')} then ${big('new')}`);
  });

  it('keeps no incoming paste whose marker the text no longer holds', () => {
    const incoming = [tab(1, big('gone')), tab(2, big('kept'))];
    const out = adoptPastes([], `only ${incoming[1].marker}`, incoming);
    expect(out.pastes.map(p => p.text)).toEqual([big('kept')]);
    expect(out.text).toBe(`only [Pasted text #1 +${PASTE_LINE_THRESHOLD} lines]`);
  });

  it('maps a marker written twice to one paste', () => {
    const incoming = [tab(7, big('twice'))];
    const out = adoptPastes([], `${incoming[0].marker} ${incoming[0].marker}`, incoming);
    expect(out.pastes).toHaveLength(1);
    expect(expandPastes(out.text, out.pastes)).toBe(`${big('twice')} ${big('twice')}`);
  });

  it('does not read a marker inside pasted text as one of its own', () => {
    const inner = `log line [Pasted text #9 +${PASTE_LINE_THRESHOLD} lines]\n`.repeat(2);
    const incoming = [tab(1, big('x') + inner), tab(9, big('nine'))];
    const out = adoptPastes([], incoming[0].marker, incoming);
    expect(out.pastes).toHaveLength(1);
    expect(expandPastes(out.text, out.pastes)).toBe(big('x') + inner);
  });

  it('changes nothing with no incoming pastes', () => {
    const own = rememberPaste([], big('own'));
    const out = adoptPastes(own.pastes, own.marker, []);
    expect(out).toEqual({ pastes: own.pastes, text: own.marker });
  });
});

describe('pasteMarkersIn', () => {
  it('lists every marker in order, after hasPasteMarker has moved the shared regex', () => {
    const text =
      'a [Pasted text #2 +12 lines] b [Pasted text #1 +40 chars] [Pasted text #2 +12 lines]';
    expect(hasPasteMarker(text)).toBe(true);
    expect(pasteMarkersIn(text)).toEqual([
      '[Pasted text #2 +12 lines]',
      '[Pasted text #1 +40 chars]',
      '[Pasted text #2 +12 lines]',
    ]);
    expect(pasteMarkersIn('nothing here')).toEqual([]);
  });
});
