import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  formatContext,
  formatCache,
  prChip,
  statusChips,
  type Chip,
  type StatusProps,
} from './Status.js';
import { packChips, packStatus, type StatusPack } from './statuspack.js';
import { theme } from './theme.js';
import { contextFill, formatShrink, kFormat } from './format.js';

describe('kFormat', () => {
  it('shows raw numbers below 1k', () => {
    expect(kFormat(0)).toBe('0');
    expect(kFormat(42)).toBe('42');
    expect(kFormat(999)).toBe('999');
  });

  it('shows one decimal in k for 1k–9.9k', () => {
    expect(kFormat(1000)).toBe('1.0k');
    expect(kFormat(1234)).toBe('1.2k');
    expect(kFormat(9876)).toBe('9.9k');
  });

  it('rounds to whole k for 10k–999k', () => {
    expect(kFormat(10_000)).toBe('10k');
    expect(kFormat(12_345)).toBe('12k');
    expect(kFormat(125_500)).toBe('126k');
    expect(kFormat(999_000)).toBe('999k');
  });

  it('shows one decimal in M for 1M–9.9M', () => {
    expect(kFormat(1_000_000)).toBe('1.0M');
    expect(kFormat(1_250_900)).toBe('1.3M');
    expect(kFormat(9_876_543)).toBe('9.9M');
  });

  it('rounds to whole M for 10M–999M', () => {
    expect(kFormat(10_000_000)).toBe('10M');
    expect(kFormat(12_345_678)).toBe('12M');
    expect(kFormat(999_000_000)).toBe('999M');
  });

  it('shows one decimal in B for 1B–9.9B', () => {
    expect(kFormat(1_000_000_000)).toBe('1.0B');
    expect(kFormat(2_500_000_000)).toBe('2.5B');
    expect(kFormat(9_876_543_210)).toBe('9.9B');
  });

  it('rounds to whole B for 10B+', () => {
    expect(kFormat(10_000_000_000)).toBe('10B');
    expect(kFormat(123_456_789_012)).toBe('123B');
  });

  it('does not produce the old broken 1250.9k format', () => {
    // Regression test: previously kFormat(1_250_900) returned "1250.9k"
    expect(kFormat(1_250_900)).not.toContain('1250');
    expect(kFormat(1_250_900)).toMatch(/M$/);
  });

  it('does not produce the 1000M cliff at the M→B boundary', () => {
    // Without B handling, kFormat(1_000_000_000) would have produced "1000M"
    expect(kFormat(1_000_000_000)).not.toContain('1000M');
    expect(kFormat(1_000_000_000)).toMatch(/B$/);
  });
});

describe('contextFill', () => {
  it('returns the used fraction when both operands are known', () => {
    expect(contextFill(32_000, 128_000)).toBeCloseTo(0.25);
  });

  it('returns null when either operand is missing or zero', () => {
    expect(contextFill(undefined, 128_000)).toBeNull();
    expect(contextFill(0, 128_000)).toBeNull();
    expect(contextFill(32_000, undefined)).toBeNull();
  });
});

describe('formatContext', () => {
  it('shows tokens, window, and percent when the window is known', () => {
    expect(formatContext(45_000, 128_000)).toBe('ctx 45k/128k (35%)');
  });

  it('measures the percent against the usable ceiling when it is known, keeping the raw ratio', () => {
    // 24k window, 6144 reserve: compactThreshold ≈ 16,070. A prompt at that size is at the shed
    // trigger — 100% — even though it fills only 67% of the raw window.
    expect(formatContext(16_070, 24_000, 16_070)).toBe('ctx 16k/24k (100% of 16k)');
    // Just after a shed (the 0.7 low watermark) reads 70%, not 47%.
    expect(formatContext(11_249, 24_000, 16_070)).toBe('ctx 11k/24k (70% of 16k)');
  });

  it('can exceed 100% — the request that trips the shed measured above the ceiling', () => {
    expect(formatContext(17_000, 24_000, 16_070)).toBe('ctx 17k/24k (106% of 16k)');
  });

  it('shows only the size when the window is unknown', () => {
    expect(formatContext(45_000)).toBe('ctx 45k');
  });

  it('renders nothing before any context exists', () => {
    expect(formatContext(undefined)).toBe('');
    expect(formatContext(0, 128_000)).toBe('');
  });
});

describe('formatShrink', () => {
  it('pluralizes each count and omits zeros', () => {
    expect(formatShrink(3, 1)).toBe('3 sheds · 1 fold');
    expect(formatShrink(1, 2)).toBe('1 shed · 2 folds');
    expect(formatShrink(5, 0)).toBe('5 sheds');
    expect(formatShrink(0, 1)).toBe('1 fold');
    expect(formatShrink(0, 0)).toBe('');
  });
});

describe('prChip', () => {
  const URL = 'https://github.com/o/r/pull/99';
  const text = (chip: Chip) => chip.map(s => s.text).join('');

  it('shows the PR the branch is attached to', () => {
    expect(text(prChip({ number: 99 })!)).toBe('PR #99');
  });

  // The label is a plain chip segment and the number is the link: an OSC 8 opener around it, the
  // link hue, and the underline that says it clicks. `links` is the terminal's answer.
  it('links the number, never the label, where the terminal takes hyperlinks', () => {
    expect(prChip({ number: 99, url: URL }, true)).toEqual([
      { text: 'PR ', color: theme.secondary },
      { text: `\u001b]8;;${URL}\u0007#99\u001b]8;;\u0007`, color: theme.link, underline: true },
    ]);
  });

  // An underline runs the width of the segment it is on, so the space separating the label from
  // the number has to live on the label: inside the underlined run it draws a column of underline
  // past the `#`, and opens a clickable gap ahead of it.
  it('keeps the separating space out of the underlined run', () => {
    const [label, number] = prChip({ number: 99, url: URL }, true)!;
    expect(label).toEqual({ text: 'PR ', color: theme.secondary });
    expect(number.text).toBe(`\u001b]8;;${URL}\u0007#99\u001b]8;;\u0007`);
  });

  // No click to deliver: the hue stays (it is what marks the badge as the PR's), the underline
  // does not — the same rule markdown.ts's renderLink follows.
  it('drops the underline and the escape where the terminal has no hyperlinks', () => {
    expect(prChip({ number: 99, url: URL }, false)).toEqual([
      { text: 'PR ', color: theme.secondary },
      { text: '#99', color: theme.link },
    ]);
  });

  it('keeps the number plain when there is no URL to open', () => {
    expect(prChip({ number: 99 }, true)).toEqual([
      { text: 'PR ', color: theme.secondary },
      { text: '#99', color: theme.secondary },
    ]);
  });

  // The escapes are control codes, not columns: a linked number must not be laid out as a URL.
  it('measures the linked number as its visible width', () => {
    const chip = prChip({ number: 99, url: URL }, true)!;
    expect(chip.reduce((n, s) => n + stringWidth(s.text), 0)).toBe(6);
  });

  it('labels a draft and a merged PR, with merged in its own color', () => {
    expect(prChip({ number: 99, state: 'draft' }, false)).toEqual([
      { text: 'PR ', color: theme.secondary },
      { text: '#99', color: theme.secondary },
      { text: ' draft', color: theme.secondary },
    ]);
    expect(prChip({ number: 99, state: 'merged' }, false)!.at(-1)).toEqual({
      text: ' merged',
      color: theme.prMerged,
    });
  });

  it('keeps the state word out of the link', () => {
    const chip = prChip({ number: 99, url: URL, state: 'merged' }, true)!;
    expect(chip[1].underline).toBe(true);
    expect(chip[1].text).not.toContain('merged');
    expect(chip[2]).toEqual({ text: ' merged', color: theme.prMerged });
  });

  it('renders nothing when the branch has no PR', () => {
    expect(prChip(null)).toBeNull();
    expect(prChip(undefined)).toBeNull();
    expect(prChip({ number: 0 })).toBeNull();
  });
});

describe('formatCache', () => {
  it('shows the cached share of the last prompt and its size', () => {
    expect(formatCache(40_000, 50_000)).toBe('80% cached (40k)');
  });

  it('drops the count on a cold call, where it would only repeat the percent', () => {
    expect(formatCache(0, 50_000)).toBe('0% cached');
  });

  it('keeps the count when a small hit rounds to 0%', () => {
    expect(formatCache(200, 50_000)).toBe('0% cached (200)');
  });

  it('renders nothing when the provider does not report cache hits', () => {
    expect(formatCache(undefined, 50_000)).toBe('');
  });

  it('renders nothing when there is no prompt to compare against', () => {
    expect(formatCache(40_000, 0)).toBe('');
  });
});

// The rows the bar takes: App reserves them out of the live region's budget, since a narrow pane
// wraps the bar onto several and unbudgeted they push the frame to the viewport height. The count
// is held from frame to frame (#948), so it is measured the way App measures it.
describe('statusRows', () => {
  const props = {
    model: 'qwen3-coder-30b-a3b-instruct',
    turns: 3,
    status: 'thinking',
    elapsed: 12,
    usage: { promptTokens: 123_456, completionTokens: 4567 },
    contextTokens: 11_249,
    contextWindow: 24_000,
    contextUsable: 16_070,
    sheds: 1,
    folds: 0,
    cachedTokens: 9000,
    decodeRate: 21.4,
    pr: { number: 99 },
    autoApprove: 'safe' as const,
    modeTag: 'agent',
  };
  const statusRows = (p: StatusProps, width: number, prev?: StatusPack | null): number =>
    packStatus(statusChips(p), width, prev).rows;
  const flips = (counts: number[]): number =>
    counts.filter((n, i) => i > 0 && n !== counts[i - 1]).length;

  it('is one row on a wide pane and grows as the pane narrows', () => {
    expect(statusRows({ ...props, model: 'test-model' }, 200)).toBe(1);
    expect(statusRows(props, 60)).toBeGreaterThan(1);
    expect(statusRows(props, 30)).toBeGreaterThan(statusRows(props, 60));
  });

  it('counts the rows Ink hard-wraps a chip wider than the pane onto', () => {
    // `agent (shift+tab to cycle)` is 26 columns; at 10 it takes three rows on its own.
    expect(statusRows({ ...props, autoApprove: undefined }, 10)).toBeGreaterThanOrEqual(
      3 + packChips([[{ text: 'x', color: '' }]], 10).length,
    );
  });

  it('keeps the row a round had when the timer resets, given the frame before (#948)', () => {
    // A pane where the timer's five characters are what buys the bar's last line.
    const long = { ...props, status: 'streaming', elapsed: 69 };
    const reset = { ...long, elapsed: 0 };
    const width = Array.from({ length: 70 }, (_, i) => i + 32).find(
      w => packChips(statusChips(long), w).length > packChips(statusChips(reset), w).length,
    );
    expect(width).toBeDefined();
    const before = packStatus(statusChips(long), width!);
    // A fresh fit drops that line at the reset; the held one keeps it.
    expect(packChips(statusChips(reset), width!)).toHaveLength(before.lines.length - 1);
    expect(packStatus(statusChips(reset), width!, before).lines).toHaveLength(before.lines.length);
  });

  it('holds its rows through a round whose phase flips on every tool call (#948)', () => {
    // `streaming` and `tool` are five columns apart, and the phase flips between them at every call,
    // so a bar fitted fresh gains and loses its last row with each one — a row that comes and goes,
    // taking the live region and the input box with it.
    const round = Array.from({ length: 60 }, (_, t) => ({
      ...props,
      elapsed: t,
      status: t % 14 < 2 ? 'thinking' : t % 14 < 10 ? 'streaming' : 'tool',
    }));
    const width = 53;
    const fresh = flips(round.map(p => packChips(statusChips(p), width).length));
    let pack: StatusPack | null = null;
    const held: number[] = [];
    for (const p of round) {
      pack = packStatus(statusChips(p), width, pack);
      held.push(pack.lines.length);
    }
    expect(fresh).toBeGreaterThan(4);
    expect(flips(held)).toBeLessThanOrEqual(1);
  });
});
