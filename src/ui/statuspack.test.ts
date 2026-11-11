import { describe, expect, it } from 'vitest';
import { type Chip, chipWidth, packChips, packStatus } from './statuspack.js';

const chip = (text: string): Chip => [{ text, color: 'x' }];
const texts = (lines: Chip[][]): string[][] =>
  lines.map(l => l.map(c => c.map(s => s.text).join('')));

describe('packChips', () => {
  it('packs chips first-fit, paying for the separator between them', () => {
    // 'aaaa · bbbb' is 11 columns; a third 4-wide chip needs 18.
    expect(texts(packChips([chip('aaaa'), chip('bbbb'), chip('cccc')], 12))).toEqual([
      ['aaaa', 'bbbb'],
      ['cccc'],
    ]);
    expect(texts(packChips([chip('aaaa'), chip('bbbb'), chip('cccc')], 18))).toEqual([
      ['aaaa', 'bbbb', 'cccc'],
    ]);
  });

  it('never splits a chip — one wider than the line gets a line of its own', () => {
    expect(texts(packChips([chip('ab'), chip('a much longer chip'), chip('cd')], 10))).toEqual([
      ['ab'],
      ['a much longer chip'],
      ['cd'],
    ]);
  });

  it('measures a multi-segment chip as one unit, in columns', () => {
    // 'agent' + ' (hint)' is 12 wide, the token chip 11: together with the separator, 26.
    const multi: Chip = [
      { text: 'agent', color: 'a' },
      { text: ' (hint)', color: 'b' },
    ];
    expect(texts(packChips([multi, chip('123k↑ 4.6k↓')], 26))).toEqual([
      ['agent (hint)', '123k↑ 4.6k↓'],
    ]);
    expect(texts(packChips([multi, chip('123k↑ 4.6k↓')], 25))).toEqual([
      ['agent (hint)'],
      ['123k↑ 4.6k↓'],
    ]);
  });
});

// #948. The bar is re-packed on every render and its volatile chips change width every second, so
// what these pin is that the row count it takes does not follow every one of those changes.
describe('packStatus', () => {
  // A bar of a real shape and a real size: 'agent (shift+tab to cycle)' is 27 columns, 'auto
  // approve' 12, the model 28, the keys hint 15.
  const bar = (timer: string, cached = '82% cached (9.0k)'): Chip[] => [
    [
      { text: 'agent', color: 'a' },
      { text: ' (shift+tab to cycle)', color: 'b' },
    ],
    chip('auto approve'),
    chip('qwen3-coder-30b-a3b-instruct'),
    chip(`streaming · ${timer}`),
    chip('123k↑ 4.6k↓'),
    chip('ctx 11k/24k (70% of 16k)'),
    chip(cached),
    chip('ctrl-c to abort'),
  ];
  // At 46 columns a round's timer takes five lines on the way up and four once it resets.
  const WIDTH = 46;

  it('lays the bar out exactly like a fresh fit when it has nothing held', () => {
    const chips = bar('1m 09s');
    const pack = packStatus(chips, WIDTH);
    expect(texts(pack.lines)).toEqual(texts(packChips(chips, WIDTH)));
    expect(pack.rows).toBe(pack.lines.length);
  });

  it('keeps the row a round had instead of handing it back when its timer resets', () => {
    const long = packStatus(bar('1m 09s'), WIDTH);
    // A fresh fit folds the reset bar onto four lines; the held one keeps the five it drew.
    expect(packChips(bar('0s'), WIDTH)).toHaveLength(long.lines.length - 1);
    const reset = packStatus(bar('0s'), WIDTH, long);
    expect(reset.lines).toHaveLength(long.lines.length);
    expect(reset.rows).toBe(long.rows);
  });

  it('takes a row the moment the bar needs one', () => {
    const reset = packStatus(bar('0s'), WIDTH);
    const grown = packStatus(bar('1m 09s'), WIDTH, reset);
    expect(grown.lines).toHaveLength(packChips(bar('1m 09s'), WIDTH).length);
  });

  it('gives a held line up as soon as the bar outgrows it', () => {
    // The held shape has `ctx … (70% of 16k)` and the cache chip as its fourth line, exactly 46
    // columns of it: a longer cache count no longer fits there, so the breaks are re-fitted.
    const long = packStatus(bar('1m 09s'), WIDTH);
    const grown = bar('1m 09s', '82% cached (123.4k)');
    expect(texts(packStatus(grown, WIDTH, long).lines)).toEqual(texts(packChips(grown, WIDTH)));
  });

  it('has nothing to hold once the bar has a different set of chips', () => {
    const before = packStatus(bar('1m 09s'), WIDTH);
    const fewer = bar('1m 09s').slice(0, -1);
    expect(texts(packStatus(fewer, WIDTH, before).lines)).toEqual(texts(packChips(fewer, WIDTH)));
  });

  it('never holds more than one row past a fresh fit', () => {
    // A shape latched from a pane three times this wide: every chip on a line of its own.
    const chips = bar('1m 09s');
    const stale = {
      lines: chips.map(c => [c]),
      rows: chips.length,
    };
    const pack = packStatus(chips, WIDTH, stale);
    expect(pack.lines).toHaveLength(packChips(chips, WIDTH).length);
    expect(pack.rows).toBe(pack.lines.length);
  });

  it('is a fixed point: packing its own output again draws the same bar', () => {
    // A frame can be rendered twice (a StrictMode pass, a re-render mid-tick), and the second pass
    // must not move the bar its first pass drew.
    for (const timer of ['0s', '1m 09s']) {
      const once = packStatus(bar(timer), WIDTH);
      const twice = packStatus(bar(timer), WIDTH, once);
      expect(texts(twice.lines)).toEqual(texts(once.lines));
      expect(twice.rows).toBe(once.rows);
    }
  });

  it('stops the bar gaining and losing its last row every round', () => {
    // Two rounds of a minute each, a tick a second: the timer climbs `0s` → `1m 09s` and resets. A
    // fresh fit loses its last row at each reset and gains it back on the way up again.
    const round = Array.from({ length: 70 }, (_, t) =>
      t < 10 ? `${t}s` : `1m ${String(t - 10).padStart(2, '0')}s`,
    );
    const timers = [...round, ...round];
    const flips = (counts: number[]): number =>
      counts.filter((n, i) => i > 0 && n !== counts[i - 1]).length;
    const fresh = flips(timers.map(t => packChips(bar(t), WIDTH).length));
    let pack = packStatus(bar(timers[0]!), WIDTH);
    const held = [pack.lines.length];
    for (const timer of timers.slice(1)) {
      pack = packStatus(bar(timer), WIDTH, pack);
      held.push(pack.lines.length);
    }
    // The fresh fit gains and loses that row at every round boundary; the held one takes it once,
    // on the tick the timer genuinely outgrew its line, and never gives it back.
    expect(fresh).toBe(3);
    expect(held.every((n, i) => i === 0 || n >= held[i - 1]!)).toBe(true);
    expect(flips(held)).toBe(1);
  });
});

describe('chipWidth', () => {
  it('measures columns, not code units', () => {
    expect(chipWidth([{ text: '↑↓', color: '' }])).toBe(2);
    expect(chipWidth([{ text: '·', color: '' }])).toBe(1);
  });
});
