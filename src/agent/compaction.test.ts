import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { compactHistory, shouldCompact, compactThreshold } from './compaction.js';

describe('shouldCompact', () => {
  it('is false without a context window', () => {
    expect(shouldCompact(1_000_000, undefined)).toBe(false);
  });

  it('triggers around the window minus the generation reserve, not a fixed fraction', () => {
    const window = 16384;
    const minGen = 2048;
    const threshold = compactThreshold(window, minGen);
    expect(shouldCompact(threshold - 1, window, minGen)).toBe(false);
    expect(shouldCompact(threshold + 1, window, minGen)).toBe(true);
  });

  it('tightens the trigger as the generation reserve grows (small-window thinking model)', () => {
    const window = 16384;
    // A bigger reserve must lower the threshold so generation room is preserved.
    expect(compactThreshold(window, 8192)).toBeLessThan(compactThreshold(window, 2048));
  });
});

// Build one user→tool→answer turn.
function turn(n: number, file: string): Message[] {
  return [
    { role: 'user', content: `q${n}` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${n}`, name: 'read', args: { path: file } }],
    },
    { role: 'tool', callId: `c${n}`, summary: `read ${file}`, payload: 'X'.repeat(500) },
    { role: 'assistant', content: `answer${n}` },
  ];
}

// Small window chosen so a handful of these tiny turns exceed the keep budget
// (window * 4 * 0.3 chars) and force compaction.
const W = 130;

describe('compactHistory', () => {
  it('does nothing when history fits the keep budget', () => {
    const history = [...turn(1, 'a.ts'), ...turn(2, 'b.ts')];
    const before = history.length;
    expect(compactHistory(history, 16384)).toBe(0);
    expect(history).toHaveLength(before);
  });

  it('does nothing without a context window', () => {
    const history = [...turn(1, 'a.ts'), ...turn(2, 'b.ts'), ...turn(3, 'c.ts')];
    expect(compactHistory(history, 0)).toBe(0);
  });

  it('collapses older turns into one front recap, keeping recent turns verbatim', () => {
    const history = [
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    const removed = compactHistory(history, W, 1, 0);
    expect(removed).toBeGreaterThan(0);
    expect(history[0].role).toBe('compaction');
    // Kept region starts at a user-message boundary.
    expect(history[1].role).toBe('user');
    // The most recent turn is still intact.
    expect(history.some(m => m.role === 'user' && m.content === 'q4')).toBe(true);
  });

  it('captures intent, tools, and files in the recap; excludes kept-verbatim turns', () => {
    const history = [
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    const recap = (history[0] as { content: string }).content;
    expect(recap).toContain('q1');
    expect(recap).toContain('a.ts');
    expect(recap).toContain('Tools used');
    expect(recap).not.toContain('q4'); // kept verbatim, not summarized
    expect(recap).not.toContain('XXXXX'); // raw payloads never enter the recap
  });

  it('bounds recap size and condenses the oldest turns once over the recap budget', () => {
    const history: Message[] = [];
    for (let i = 1; i <= 40; i++) history.push(...turn(i, `f${i}.ts`));
    compactHistory(history, W, 1, 0);
    const recap = (history[0] as { content: string }).content;
    // Bounded regardless of session length (40 turns in, recap stays compact).
    expect(recap.length).toBeLessThan(800);
    expect(recap).toMatch(/\+\d+ earlier turns? condensed/);
  });

  it('carries a prior recap forward into the new one', () => {
    const history: Message[] = [
      { role: 'compaction', content: 'PRIOR RECAP' },
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    expect((history[0] as { content: string }).content).toContain('PRIOR RECAP');
  });

  it('never leaves a tool result without its tool_call (splits on user boundaries)', () => {
    const history = [
      ...turn(1, 'a.ts'),
      ...turn(2, 'b.ts'),
      ...turn(3, 'c.ts'),
      ...turn(4, 'd.ts'),
    ];
    compactHistory(history, W, 1, 0);
    const kept = history.slice(1);
    for (const m of kept) {
      if (m.role === 'tool') {
        const hasCall = kept.some(
          a => a.role === 'assistant' && a.toolCalls?.some(tc => tc.id === m.callId),
        );
        expect(hasCall).toBe(true);
      }
    }
  });
});
