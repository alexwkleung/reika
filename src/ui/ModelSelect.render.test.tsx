import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ModelSelect } from './ModelSelect.js';
import type { ModelTarget } from './models.js';

const BASE = 'http://localhost:11434/v1';

const TARGETS: ModelTarget[] = [
  { name: 'qwen2.5-coder', model: 'Qwen2.5-Coder', baseURL: BASE, kind: 'model', active: true },
  { name: 'glm-4', model: 'GLM-4', baseURL: BASE, kind: 'model', active: false },
  {
    name: 'big',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.com/v1',
    kind: 'profile',
    active: false,
  },
];

describe('ModelSelect', () => {
  it('renders header context, entries, and markers', () => {
    const { lastFrame } = render(
      <ModelSelect
        targets={TARGETS}
        selectedIndex={1}
        currentModel="Qwen2.5-Coder"
        baseURL={BASE}
        subagent="qwen2.5-coder:7b"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('• Model');
    expect(frame).toContain(`base: ${BASE}`);
    expect(frame).toContain('subagent: qwen2.5-coder:7b');
    // Selection cursor on the second entry, (current) marker on the first.
    expect(frame).toContain('› GLM-4');
    expect(frame).toMatch(/Qwen2\.5-Coder\s+\(current\)/);
    // Named profile shows its mapping and its off-default base URL.
    expect(frame).toContain('big → deepseek-chat');
    expect(frame).toContain('@ https://api.deepseek.com/v1');
    expect(frame).toContain('enter switch');
  });

  it('omits the subagent line when not provided', () => {
    const { lastFrame } = render(
      <ModelSelect
        targets={TARGETS}
        selectedIndex={0}
        currentModel="Qwen2.5-Coder"
        baseURL={BASE}
      />,
    );
    expect(lastFrame() ?? '').not.toContain('subagent:');
  });
});
