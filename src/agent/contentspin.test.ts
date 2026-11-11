import { describe, expect, it } from 'vitest';
import {
  CONTENT_SPIN_MIN_CHARS,
  CONTENT_SPIN_RATIO,
  contentSpinSignal,
  fenceOpenAtTail,
} from './contentspin.js';

// The gate this file exists for: cut a reply that repeats itself near-verbatim, and never cut one
// that merely repeats its SHAPE. Both corpus fixtures below are reduced from the two saved content
// loops in #944; the healthy ones are the output kinds the issue names as must-not-cut — a table, a
// generated fixture, a numbered list, and switch-heavy code.

// Case 1 (lfm2.5, 16k window): thinking leaked into the output channel, so the reasoning detectors
// never saw it. The shape is one paragraph re-emitted with small variations, in a first-person voice.
function leakedThinking(n = 120): string {
  return Array.from(
    { length: n },
    () =>
      'let me re-read the task again and check the fetch failed branch: the sandbox is blocking ' +
      'repeated reads, so maybe the message comes from callMcpTool rather than the tool result',
  ).join('\n\n');
}

// Case 2 (qwen3.6, 32k window): one code block written over and over. Long enough to matter, and
// long enough that a narrow window would read it low — this is what the wider window scale is for.
function repeatedCodeBlock(n = 70): string {
  const block = [
    '```ts',
    'function paintTree(node: ScopeNode, theme: Record<string, Paint>): void {',
    '  for (const child of node.children) {',
    '    if (typeof child === "string") continue;',
    '    const paint = theme[child.scope] ?? theme.fallback;',
    '    paintRows(child, paint);',
    '  }',
    '}',
    '```',
  ].join('\n');
  return Array.from({ length: n }, () => block).join('\n\n');
}

// A long table: every row differs in its numbers, so the 8-grams differ even though the shape is
// identical. The exact thing a ratio gate must not read as a loop.
function longTable(n = 400): string {
  const rows = ['| file | lines | tokens | bytes |', '| --- | --- | --- | --- |'];
  for (let i = 0; i < n; i++) {
    rows.push(`| src/module${i}.ts | ${i * 7 + 11} | ${i * 31 + 3} | ${i * 97 + 5} |`);
  }
  return rows.join('\n');
}

// Generated fixtures: a numbered list whose items share a shape and differ only in their values.
function numberedList(n = 220): string {
  return Array.from(
    { length: n },
    (_, i) =>
      `${i + 1}. case ${i}: expect(caller(${i * 13 + 2})).toBe(${i * 29 + 7}) — asserts the ` +
      `handler at offset ${i * 41 + 9} returns record ${i * 17 + 1}`,
  ).join('\n');
}

// Switch-heavy code: near-identical arms over distinct identifiers (config maps, reducer cases).
function switchHeavyCode(n = 130): string {
  const arms = Array.from(
    { length: n },
    (_, i) =>
      `    case Action.CASE_${i}: {\n      const next = reduce${i}(state, action);\n` +
      `      return { ...state, values${i}: next.value, touched: ${i} };\n    }`,
  );
  return [
    '```ts',
    'export function mapState(state: State, action: Action): State {',
    '  switch (action.type) {',
    ...arms,
    '  }',
    '}',
    '```',
  ].join('\n');
}

describe('contentSpinSignal', () => {
  it('fires on thinking leaked into the content channel (case 1)', () => {
    const r = contentSpinSignal(leakedThinking());
    expect(r.chars).toBeGreaterThan(CONTENT_SPIN_MIN_CHARS);
    expect(r.ratio).toBeGreaterThanOrEqual(CONTENT_SPIN_RATIO);
    expect(r.spinning).toBe(true);
  });

  it('fires on a re-emitted code block (case 2)', () => {
    const r = contentSpinSignal(repeatedCodeBlock());
    expect(r.chars).toBeGreaterThan(CONTENT_SPIN_MIN_CHARS);
    expect(r.spinning).toBe(true);
  });

  it('does not fire under the minimum length, however perfectly it repeats', () => {
    // A verbatim repeat scores ~1.0 at any length — the bar is the length gate, not the ratio. One
    // paragraph said twice in 4k chars is not worth a wrong cut.
    const r = contentSpinSignal(repeatedCodeBlock(1).repeat(4));
    expect(r.chars).toBeLessThan(CONTENT_SPIN_MIN_CHARS);
    expect(r.ratio).toBe(0);
    expect(r.spinning).toBe(false);
  });

  it('catches a repeat whose period is wider than the shortest window', () => {
    // A ~8k block re-emitted 8 times is a loop, but read over the 16k minimum window it scores ~0.5
    // (1.9 copies visible) and would be left alone. The wider scales exist for exactly this: the
    // ratio is the strongest across all of them, so the period never decides the verdict.
    const block = Array.from(
      { length: 65 },
      (_, i) =>
        `the walker at step ${i} visits node ${i * 37 + 5}, records column ${i % 13} and then ` +
        `descends into the ${i % 7 === 0 ? 'left' : 'right'} branch before emitting span ${i * 11 + 3}`,
    ).join('\n');
    expect(block.length).toBeGreaterThan(7000);
    const wide = contentSpinSignal(Array.from({ length: 8 }, () => block).join('\n'));
    expect(wide.ratio).toBeGreaterThanOrEqual(CONTENT_SPIN_RATIO);
    expect(wide.spinning).toBe(true);
    // Two-and-a-bit copies is not a loop yet: three copies at the same period stay under the bar,
    // which is the length gate doing its job rather than a bogus period-blindness.
    expect(contentSpinSignal(Array.from({ length: 3 }, () => block).join('\n')).spinning).toBe(
      false,
    );
  });

  it('leaves a long table alone', () => {
    const r = contentSpinSignal(longTable());
    expect(r.chars).toBeGreaterThan(CONTENT_SPIN_MIN_CHARS);
    expect(r.ratio).toBeLessThan(0.2);
    expect(r.spinning).toBe(false);
  });

  it('leaves a generated fixture of numbered assertions alone', () => {
    const r = contentSpinSignal(numberedList());
    expect(r.chars).toBeGreaterThan(CONTENT_SPIN_MIN_CHARS);
    expect(r.spinning).toBe(false);
  });

  it('leaves switch-heavy code alone', () => {
    const r = contentSpinSignal(switchHeavyCode());
    expect(r.chars).toBeGreaterThan(CONTENT_SPIN_MIN_CHARS);
    expect(r.spinning).toBe(false);
  });

  it('clears once the model breaks out of the repeat (the cut is recoverable)', () => {
    // The ratio is a TRAILING window, so a long repeat followed by 40k chars of real work is a
    // finished reply, not a loop. Without this the gate would be a death sentence on any recovery.
    const r = contentSpinSignal(
      leakedThinking() + '\n\n' + longTable(400) + '\n\n' + numberedList(300),
    );
    expect(r.chars).toBeGreaterThan(60000);
    expect(r.spinning).toBe(false);
  });

  it('has no length ceiling of its own: long DISTINCT output is never evidence of a loop', () => {
    const r = contentSpinSignal(longTable(1600));
    expect(r.chars).toBeGreaterThan(60000);
    expect(r.spinning).toBe(false);
  });

  it('reports which window produced the ratio, clamped to the reply', () => {
    const r = contentSpinSignal(leakedThinking());
    expect(r.window).toBeGreaterThanOrEqual(CONTENT_SPIN_MIN_CHARS);
    expect(r.window).toBeLessThanOrEqual(r.chars);
  });
});

describe('fenceOpenAtTail', () => {
  it('is false for prose with no fence', () => {
    expect(fenceOpenAtTail('a reply with no code in it at all')).toBe(false);
  });

  it('is false after a closed fence', () => {
    expect(fenceOpenAtTail('text\n```ts\nconst a = 1;\n```\nafter')).toBe(false);
  });

  it('is true inside an unclosed fence', () => {
    expect(fenceOpenAtTail('text\n```ts\nconst a = 1;\n')).toBe(true);
  });

  it('accepts indented and tilde fences, and does not let a bare line close a longer one', () => {
    expect(fenceOpenAtTail('  ```\ncode')).toBe(true);
    expect(fenceOpenAtTail('~~~\ncode')).toBe(true);
    expect(fenceOpenAtTail('````\ncode\n```\nstill code')).toBe(true);
  });

  it('treats a fence line with an info string as an opener, not a closer', () => {
    expect(fenceOpenAtTail('```ts\ncode\n```js\nmore code')).toBe(true);
  });
});
