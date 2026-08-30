import { describe, expect, it } from 'vitest';
import { bundleSections, formatBundleSize } from './bundlesize.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import type { ContextBundle } from '../types.js';

function makeBundle(over: Partial<ContextBundle> = {}): ContextBundle {
  return {
    projectSummary: 'a'.repeat(100),
    repoMap: 'b'.repeat(400),
    instructions: 'c'.repeat(800),
    cwd: '/repo',
    hash: 'deadbeefdeadbeef',
    fileIndex: ['src/a.ts', 'src/b.ts'],
    ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
    skills: [],
    ...over,
  };
}

describe('bundleSections', () => {
  it('reports chars and tokens for each section that reaches the prompt', () => {
    expect(bundleSections(makeBundle())).toEqual([
      { name: 'projectSummary', chars: 100, tokens: 25 },
      { name: 'repoMap', chars: 400, tokens: 100 },
      { name: 'instructions', chars: 800, tokens: 200 },
    ]);
  });

  // fileIndex and skills are bundle members that never reach the system prompt; counting
  // them would report a prefill cost the model never pays.
  it('ignores bundle members that are not interpolated into the prompt', () => {
    const big = makeBundle({ fileIndex: Array.from({ length: 5000 }, (_, i) => `f${i}.ts`) });
    expect(bundleSections(big)).toEqual(bundleSections(makeBundle()));
  });
});

describe('formatBundleSize', () => {
  it('names every section, the section total, and the whole agent prompt', () => {
    const line = formatBundleSize(makeBundle());
    expect(line).toContain('[reika:debug] bundle hash=deadbeefdeadbeef');
    expect(line).toContain('projectSummary=100c/25t');
    expect(line).toContain('repoMap=400c/100t');
    expect(line).toContain('instructions=800c/200t');
    expect(line).toContain('sections=1300c/325t');
    expect(line).not.toContain('\n');
  });

  // The point of the line is the round-0 prefill cost, so `prompt` must track the real
  // system prompt — sections plus the fixed rules block — not just the sections.
  it('counts the fixed scaffold the sections do not cover', () => {
    const bundle = makeBundle();
    const prompt = buildSystemPrompt({ bundle, mode: 'agent' });
    expect(formatBundleSize(bundle)).toContain(
      `prompt=${prompt.length}c/${Math.ceil(prompt.length / 4)}t`,
    );
    expect(prompt.length).toBeGreaterThan(1300);
  });

  it('omits nothing when a section is empty', () => {
    const line = formatBundleSize(makeBundle({ repoMap: '', instructions: '' }));
    expect(line).toContain('repoMap=0c/0t');
    expect(line).toContain('instructions=0c/0t');
    expect(line).toContain('sections=100c/25t');
  });
});
