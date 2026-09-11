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
      <Status {...BASE} contextTokens={11_249} contextWindow={24_000} contextUsable={16_070} sheds={3} folds={1} />,
    );
    expect(lastFrame()).toContain('ctx 11k/24k (70% of 16k) · 3 sheds · 1 fold');
  });

  it('shows no chips at zero — a large window never sheds, and "0 sheds" would be a standing question', () => {
    const { lastFrame } = render(<Status {...BASE} contextTokens={11_249} contextWindow={24_000} sheds={0} folds={0} />);
    expect(lastFrame()).not.toContain('shed');
    expect(lastFrame()).not.toContain('fold');
  });
});
