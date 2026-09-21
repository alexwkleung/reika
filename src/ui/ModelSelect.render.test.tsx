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

  it('renders an ad-hoc entry as its bare model with the off-config marker', () => {
    const targets: ModelTarget[] = [
      ...TARGETS,
      {
        name: 'foo-32b',
        model: 'Foo-32B',
        baseURL: BASE,
        kind: 'profile',
        active: true,
        adhoc: true,
      },
    ];
    const { lastFrame } = render(
      <ModelSelect targets={targets} selectedIndex={0} currentModel="Foo-32B" baseURL={BASE} />,
    );
    const frame = lastFrame() ?? '';
    // Bare model name, not the `foo-32b → Foo-32B` mapping a named profile gets.
    expect(frame).not.toContain('foo-32b →');
    expect(frame).toMatch(/Foo-32B\s+\(not in config\)\s+\(current\)/);
  });

  it("renders a named profile's extra model as its bare name on the profile's base", () => {
    const targets: ModelTarget[] = [
      ...TARGETS,
      {
        name: 'muse-spark',
        model: 'Muse-Spark',
        baseURL: 'https://router.example/v1',
        kind: 'profile',
        active: false,
      },
    ];
    const { lastFrame } = render(
      <ModelSelect targets={targets} selectedIndex={0} currentModel="m" baseURL={BASE} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('muse-spark →');
    expect(frame).toMatch(/Muse-Spark\s+@ https:\/\/router\.example\/v1/);
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
