import { describe, expect, it } from 'vitest';
import { messagesToOpenAI, type AgedStats } from './toolcall.js';
import type { Message } from '../types.js';

// #260 verification run 1: three re-reads and two folds in one 19-round /review, and nothing in the
// debug log said what the aged half of each request had actually serialized as — summaries and
// skeletons live only in the request, which nothing records. These counts are that missing line.
const g = (n: number, text: string): string => `${String(n).padStart(5, ' ')}│${text}`;

const CLI_TSX = [
  g(1, '#!/usr/bin/env node'),
  g(2, "import { render } from 'ink';"),
  g(3, "import { App } from './ui/App.js';"),
  g(4, "import { sweepStaleSpills } from './tools/_spill.js';"),
  g(5, ''),
  g(6, '// Spill directories are removed on a normal exit, but SIGHUP never reaches that handler.'),
  g(7, 'void sweepStaleSpills();'),
  g(8, ''),
  g(9, 'render(<App />, { exitOnCtrlC: false });'),
].join('\n');

const BIG_FILE = [
  g(1, "import { readFile } from 'node:fs/promises';"),
  g(2, 'export function one(): void {'),
  ...Array.from({ length: 400 }, (_, i) => g(i + 3, `  const filler${i} = ${i};`)),
  g(403, 'export function two(): void {'),
].join('\n');

const history = (payload: string): Message[] => [
  { role: 'user', content: 'review' },
  // A spec-pin holder first: the turn's first small payload stays live (#227), so a read in that
  // slot would never age and this file would be measuring the wrong thing.
  { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'bash', args: {} }] },
  { role: 'tool', callId: 'spec', summary: 'Ran: gh pr view 225', payload: 'PR BODY' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read', args: {} }] },
  { role: 'tool', callId: 'r', summary: 'Read src/cli.tsx lines 1-13 of 13', payload },
  { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'read', args: {} }] },
  { role: 'tool', callId: 'z', summary: 'Read x', payload: 'Z'.repeat(40_000) },
];

function serialize(h: Message[]): { aged: string; stats: AgedStats } {
  let stats: AgedStats | undefined;
  const out = messagesToOpenAI('sys', h, {
    contextWindow: 8192,
    onAgedStats: s => {
      stats = s;
    },
  }) as Array<{ tool_call_id?: string; content: string }>;
  return { aged: out.find(m => m.tool_call_id === 'r')!.content, stats: stats! };
}

describe('an aged payload never costs more than its own skeleton (#260)', () => {
  it('keeps a small file whole rather than paying more for the hole marker', () => {
    // The marker alone is ~590 chars, so a file this size is at or past the crossover where the
    // outline stops saving anything. Announcing a hole must never cost more than not making one.
    const { aged, stats } = serialize(history(CLI_TSX));
    expect(aged).toContain('void sweepStaleSpills();');
    expect(aged).not.toContain('no longer in context');
    expect(stats.whole).toBe(1);
    expect(stats.outline).toBe(0);
  });

  it('is never longer than the outline it displaced', () => {
    const { aged } = serialize(history(CLI_TSX));
    const summary = 'Read src/cli.tsx lines 1-13 of 13';
    expect(aged.length).toBeLessThanOrEqual(summary.length + 2 + CLI_TSX.length);
  });

  it('still outlines a file whose body is the bulk of it', () => {
    const { aged, stats } = serialize(history(BIG_FILE));
    expect(aged).toContain('export function one(): void {');
    expect(aged).not.toContain('const filler7 =');
    expect(stats.outline).toBe(1);
    expect(stats.whole).toBe(0);
  });
});

describe('aged-payload stats (#260)', () => {
  it('counts a payload that collapsed to its summary alone', () => {
    const { stats } = serialize(history('plain command output, no gutter and no hunks'));
    expect(stats.summary).toBe(1);
    expect(stats.outline + stats.diff + stats.whole).toBe(0);
  });

  it('counts a diff skeleton separately from a read outline', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '@@ -1,6 +1,7 @@',
      ...Array.from({ length: 200 }, (_, i) => `+  line ${i}`),
    ].join('\n');
    const { stats } = serialize(history(diff));
    expect(stats.diff).toBe(1);
    expect(stats.outline).toBe(0);
  });

  it('reports nothing when no payload is aged', () => {
    let stats: AgedStats | undefined;
    messagesToOpenAI('sys', history(CLI_TSX).slice(0, 3), {
      contextWindow: 32768,
      onAgedStats: s => {
        stats = s;
      },
    });
    expect(stats).toEqual({ summary: 0, diff: 0, outline: 0, whole: 0 });
  });
});
