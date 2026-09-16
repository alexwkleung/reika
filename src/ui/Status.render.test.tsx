import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Status } from './Status.js';

const BASE = {
  model: 'Qwen2.5-Coder',
  turns: 2,
  status: 'idle',
  elapsed: null,
  usage: { promptTokens: 0, completionTokens: 0 },
};

describe('Status', () => {
  it('shows the PR badge when the branch is attached to one', () => {
    const { lastFrame } = render(<Status {...BASE} pr={99} />);
    expect(lastFrame()).toContain('PR: #99');
  });

  it('leaves the badge off when there is no PR', () => {
    const { lastFrame } = render(<Status {...BASE} pr={null} />);
    expect(lastFrame()).not.toContain('PR:');
  });

  it('shows shrink chips after the gauge once something has shrunk', () => {
    const { lastFrame } = render(
      <Status
        {...BASE}
        contextTokens={11_249}
        contextWindow={24_000}
        contextUsable={16_070}
        sheds={3}
        folds={1}
      />,
    );
    expect(lastFrame()).toContain('ctx 11k/24k (70% of 16k) · 3 sheds · 1 fold');
  });

  it('shows no chips at zero — a large window never sheds, and "0 sheds" would be a standing question', () => {
    const { lastFrame } = render(
      <Status {...BASE} contextTokens={11_249} contextWindow={24_000} sheds={0} folds={0} />,
    );
    expect(lastFrame()).not.toContain('shed');
    expect(lastFrame()).not.toContain('fold');
  });

  // The approval chip describes a gate; chat mode's tools never ask and shell mode never runs
  // the model, so there the chip would be a standing claim about nothing (#373).
  it.each(['chat', 'shell'])('hides the approval chip in %s mode', modeTag => {
    const { lastFrame } = render(<Status {...BASE} modeTag={modeTag} autoApprove="bypass" />);
    expect(lastFrame()).toContain(modeTag);
    expect(lastFrame()).not.toContain('bypass approvals');
  });

  it.each(['agent', 'plan', 'vibe'])('keeps the approval chip in %s mode', modeTag => {
    const { lastFrame } = render(<Status {...BASE} modeTag={modeTag} autoApprove="safe" />);
    expect(lastFrame()).toContain('auto approve');
  });
});

// A full status at 40 columns. Before #295 the row Box handed each sibling <Text> its own
// column and every chip wrapped in place into a stack of shards ("qwen3-cod", "r-30b-a3b",
// "instruct"); packing whole chips onto lines is what a narrow terminal should show.
describe('Status wrap', () => {
  const FULL = {
    ...BASE,
    model: 'qwen3-coder-30b-a3b-instruct',
    turns: 12,
    usage: { promptTokens: 123_456, completionTokens: 4567 },
    contextTokens: 11_249,
    contextWindow: 24_000,
    contextUsable: 16_070,
    sheds: 3,
    folds: 1,
    cachedTokens: 9000,
    pr: 99,
    modeTag: 'agent',
    autoApprove: 'safe' as const,
  };

  const withColumns = <T,>(columns: number, fn: () => T): T => {
    const prev = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: prev, configurable: true });
    }
  };

  const lines = (frame: string | undefined) => (frame ?? '').split('\n');

  it('wraps at chip boundaries, never inside a chip, and every line fits', () => {
    const rows = withColumns(40, () => lines(render(<Status {...FULL} />).lastFrame()));
    expect(rows).toEqual([
      'agent (shift+tab to cycle)',
      'auto approve',
      'qwen3-coder-30b-a3b-instruct · turn 12',
      'idle · 123k↑ 4.6k↓',
      'ctx 11k/24k (70% of 16k)',
      '3 sheds · 1 fold · cache 80% · PR: #99',
      'ctrl-c to exit',
    ]);
    // The App's paddingX={1} takes two columns off the terminal's 40.
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(38);
  });

  it('stays on one line when it fits', () => {
    // ink-testing-library's stdout is 100 columns, so the full status can't be tested unwrapped;
    // a short one can.
    const rows = withColumns(100, () => lines(render(<Status {...BASE} pr={99} />).lastFrame()));
    expect(rows).toEqual(['Qwen2.5-Coder · turn 2 · idle · PR: #99 · ctrl-c to exit']);
  });

  it('re-packs when the terminal is resized, without anything else re-rendering', async () => {
    // Ink re-lays its yoga tree on resize but does not re-run components, so an idle status
    // (no timer ticking) would otherwise keep the old packing until the next keystroke.
    const wide = withColumns(100, () => lines(render(<Status {...FULL} />).lastFrame()).length);
    const narrow = withColumns(40, () => lines(render(<Status {...FULL} />).lastFrame()).length);
    expect(narrow).toBeGreaterThan(wide);

    const app = withColumns(100, () => render(<Status {...FULL} />));
    expect(lines(app.lastFrame())).toHaveLength(wide);
    withColumns(40, () => {
      process.stdout.emit('resize');
    });
    await new Promise(r => setTimeout(r, 0));
    expect(lines(app.lastFrame())).toHaveLength(narrow);
    app.unmount();
  });
});
