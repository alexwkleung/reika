import { describe, expect, it } from 'vitest';
import {
  budgetWarning,
  bundleSections,
  formatBudget,
  formatBundleSize,
  historyBudgetTokens,
  MIN_WORKABLE_HISTORY_TOKENS,
} from './bundlesize.js';
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

// The toy bundle above has a ~560t system block; the budget floor is calibrated against a real
// one (~2,060t on the repo in #262), so these tests pad the repoMap to that size — otherwise the
// reported-bad config would look workable purely because the prompt is unrealistically small.
function realisticBundle(): ContextBundle {
  const base = makeBundle({ repoMap: '' });
  const scaffold = Math.ceil(buildSystemPrompt({ bundle: base, mode: 'agent' }).length / 4);
  return makeBundle({ repoMap: 'm'.repeat((2062 - scaffold) * 4) });
}

describe('historyBudgetTokens', () => {
  it('is the compaction threshold less the system block', () => {
    const bundle = makeBundle();
    const systemTokens = Math.ceil(buildSystemPrompt({ bundle, mode: 'agent' }).length / 4);
    // 12000 − 6144 = 5856 avail, × 0.9 safety = 5270.4 threshold.
    expect(historyBudgetTokens(bundle, 12000, 6144)).toBe(Math.round(5270.4 - systemTokens));
  });

  it('grows with the window and shrinks with the generation reserve', () => {
    const bundle = makeBundle();
    expect(historyBudgetTokens(bundle, 24000, 6144)).toBeGreaterThan(
      historyBudgetTokens(bundle, 12000, 6144),
    );
    expect(historyBudgetTokens(bundle, 12000, 6144)).toBeLessThan(
      historyBudgetTokens(bundle, 12000, 2048),
    );
  });
});

describe('budgetWarning', () => {
  // The reported config from #262: the reserve took over half the window before any history existed.
  it('warns on the configuration that derailed a run, naming the numbers and both knobs', () => {
    const warn = budgetWarning(realisticBundle(), { contextWindow: 12000, minGenTokens: 6144 });
    expect(warn).toBeDefined();
    expect(warn).toContain('12,000');
    expect(warn).toContain('6,144');
    expect(warn).toContain('REIKA_CONTEXT_WINDOW');
    expect(warn).toContain('REIKA_MIN_GEN_TOKENS');
  });

  it('stays quiet on a workable budget', () => {
    expect(
      budgetWarning(realisticBundle(), { contextWindow: 24000, minGenTokens: 6144 }),
    ).toBeUndefined();
    expect(
      budgetWarning(realisticBundle(), { contextWindow: 16000, minGenTokens: 6144 }),
    ).toBeUndefined();
  });

  // No window means nothing is capped and compaction never fires, so there is no floor to be under.
  it('stays quiet when no window is configured', () => {
    expect(budgetWarning(makeBundle(), {})).toBeUndefined();
  });

  it('fires exactly at the floor', () => {
    const bundle = realisticBundle();
    const cw = (window: number): number | undefined =>
      budgetWarning(bundle, { contextWindow: window, minGenTokens: 2048 }) === undefined ? 0 : 1;
    let boundary = 0;
    for (let w = 4000; w <= 20000; w += 10) {
      if (cw(w) === 0) {
        boundary = w;
        break;
      }
    }
    expect(historyBudgetTokens(bundle, boundary, 2048)).toBeGreaterThanOrEqual(
      MIN_WORKABLE_HISTORY_TOKENS,
    );
    expect(historyBudgetTokens(bundle, boundary - 10, 2048)).toBeLessThan(
      MIN_WORKABLE_HISTORY_TOKENS,
    );
  });
});

describe('formatBudget', () => {
  it('logs the arithmetic every session and flags the unworkable case', () => {
    const line = formatBudget(realisticBundle(), { contextWindow: 12000, minGenTokens: 6144 });
    expect(line).toContain('[reika:debug] budget window=12000 reserve=6144 threshold=5270');
    expect(line).toContain('UNWORKABLE');
    expect(line).not.toContain('\n');
    expect(
      formatBudget(realisticBundle(), { contextWindow: 24000, minGenTokens: 6144 }),
    ).not.toContain('UNWORKABLE');
  });

  it('says so when no window is configured', () => {
    expect(formatBudget(makeBundle(), {})).toContain('window=unset');
  });
});
