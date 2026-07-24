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
});
