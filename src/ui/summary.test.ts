import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { buildSummary, hasActivity } from './summary.js';

const NOW = Date.now();
const startedAt = NOW - 60_000; // 1 minute ago

const baseUsage = { promptTokens: 0, completionTokens: 0 };
const baseApprovals = { approved: 0, declined: 0 };

describe('hasActivity', () => {
  it('returns false for empty messages', () => {
    expect(hasActivity([])).toBe(false);
  });

  it('returns false for only nested user messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'sub task', nested: true }];
    expect(hasActivity(msgs)).toBe(false);
  });

  it('returns true when a top-level user message exists', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hi' }];
    expect(hasActivity(msgs)).toBe(true);
  });
});

describe('buildSummary', () => {
  it('reports zero turns and zero tools on empty history', () => {
    const out = buildSummary([], baseUsage, startedAt, baseApprovals);
    expect(out).toContain('0 user · 0 assistant');
    expect(out).toContain('Tools:           0');
  });

  it('counts top-level turns but skips nested ones', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'sub', nested: true },
      { role: 'assistant', content: 'sub-resp', nested: true },
      { role: 'user', content: 'c' },
    ];
    const out = buildSummary(msgs, baseUsage, startedAt, baseApprovals);
    expect(out).toContain('2 user · 1 assistant');
  });

  it('counts tool calls and lists them in descending order', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: '1', name: 'grep', args: {} },
          { id: '2', name: 'grep', args: {} },
          { id: '3', name: 'read', args: {} },
        ],
      },
    ];
    const out = buildSummary(msgs, baseUsage, startedAt, baseApprovals);
    expect(out).toContain('Tools:           3');
    expect(out).toMatch(/2 grep.*1 read/); // ordered by count desc
  });

  it('extracts files modified from edit/write tool calls', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: '1', name: 'edit', args: { path: 'src/foo.ts' } },
          { id: '2', name: 'write', args: { path: 'src/bar.ts' } },
          { id: '3', name: 'read', args: { path: 'src/baz.ts' } }, // not a mutation
        ],
      },
    ];
    const out = buildSummary(msgs, baseUsage, startedAt, baseApprovals);
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('src/bar.ts');
    expect(out).not.toContain('src/baz.ts');
  });

  it('counts subagent calls separately', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '1', name: 'subagent', args: { task: 'x' } }],
      },
    ];
    const out = buildSummary(msgs, baseUsage, startedAt, baseApprovals);
    expect(out).toContain('Subagents:       1');
  });

  it('renders token counts with thousands separators', () => {
    const out = buildSummary(
      [],
      { promptTokens: 12345, completionTokens: 6789 },
      startedAt,
      baseApprovals,
    );
    expect(out).toContain('12,345');
    expect(out).toContain('6,789');
  });

  it('shows approval counts', () => {
    const out = buildSummary([], baseUsage, startedAt, { approved: 3, declined: 1 });
    expect(out).toContain('3 approved, 1 declined');
  });

  it('reports (none) when no files modified', () => {
    const out = buildSummary([], baseUsage, startedAt, baseApprovals);
    expect(out).toContain('Files modified:  (none)');
  });
});
