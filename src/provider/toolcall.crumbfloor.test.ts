import { describe, expect, it } from 'vitest';
import { agedContentChars, messagesToOpenAI, type AgedStats } from './toolcall.js';
import type { Message } from '../types.js';

// #257: aging is size-blind once the bulk/crumbs sweep split has had its say — the second sweep
// still takes the crumbs when the first misses target. Measured twice on the same task: a 755-char
// `src/cli.tsx` was shed inside an event that shed 18,935 chars, and since the hole marker alone is
// ~590 chars the eviction bought 114. The model re-read the file three times, hit maxrepeat=3, and
// took a tool withdrawal; the runs that never shed it finished in half the rounds. Under the floor
// an aged payload therefore keeps its bytes, bounded in aggregate so a session of small greps can't
// pile up chars aging is unable to reclaim.

const g = (n: number, text: string): string => `${String(n).padStart(5, ' ')}│${text}`;

// The real file from both measured runs — small enough that the ~590-char hole marker is most of
// what would replace it.
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

// Well past the floor, and mostly body — the outline branch, not the crumb branch.
const BIG_FILE = [
  g(1, "import { readFile } from 'node:fs/promises';"),
  g(2, 'export function one(): void {'),
  ...Array.from({ length: 400 }, (_, i) => g(i + 3, `  const filler${i} = ${i};`)),
  g(403, 'export function two(): void {'),
].join('\n');

const round = (id: string, summary: string, payload: string): Message[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', args: {} }] },
  { role: 'tool', callId: id, summary, payload },
];

// A spec-pin holder leads every history: the turn's first payload under TASK_SPEC_PIN_CHARS stays
// live (#227), so a read in that slot would never age and the case would measure the live branch.
const history = (...rounds: Message[][]): Message[] => [
  { role: 'user', content: 'review' },
  ...round('spec', 'Ran: gh pr view 225', 'PR BODY'),
  ...rounds.flat(),
  // Trailing bulk, so everything before it is outside the fresh block and over the window.
  ...round('z', 'Read z', 'Z'.repeat(40_000)),
];

function serialize(h: Message[]): {
  contentFor: (id: string) => string;
  stats: AgedStats;
} {
  let stats: AgedStats | undefined;
  const out = messagesToOpenAI('sys', h, {
    contextWindow: 8192,
    onAgedStats: s => {
      stats = s;
    },
  }) as Array<{ tool_call_id?: string; content: string }>;
  return {
    contentFor: id => out.find(m => m.tool_call_id === id)!.content,
    stats: stats!,
  };
}

describe('an aged crumb keeps its bytes (#257)', () => {
  it('serves the file whole instead of the outline that cost a round-trip three times', () => {
    const { contentFor, stats } = serialize(
      history(round('r', 'Read src/cli.tsx lines 1-13 of 13', CLI_TSX)),
    );
    expect(contentFor('r')).toContain('void sweepStaleSpills();');
    expect(contentFor('r')).not.toContain('no longer in context');
    expect(stats.whole).toBe(1);
    expect(stats.outline).toBe(0);
  });

  it('keeps a crumb with no structure at all — the shape of the payload is not the question', () => {
    const { contentFor, stats } = serialize(
      history(round('r', 'Ran: git status (86 bytes output)', 'On branch main\nnothing to commit')),
    );
    expect(contentFor('r')).toContain('nothing to commit');
    expect(stats.whole).toBe(1);
    expect(stats.summary).toBe(0);
  });

  it('still ages a payload over the floor to its outline', () => {
    const { contentFor, stats } = serialize(
      history(round('r', 'Read src/big.ts lines 1-403 of 403', BIG_FILE)),
    );
    expect(contentFor('r')).toContain('export function one(): void {');
    expect(contentFor('r')).not.toContain('const filler7 =');
    expect(stats.outline).toBe(1);
  });

  it('applies under prefix-stable too, where liveness is sticky rather than trailing-block', () => {
    const h: Message[] = [
      { role: 'user', content: 'go' },
      ...round('r', 'Read src/cli.tsx lines 1-13 of 13', CLI_TSX),
      ...round('fresh', 'Read fresh', 'FRESH PAYLOAD'),
    ];
    (h[2] as Message & { role: 'tool' }).aged = true;
    const out = messagesToOpenAI('sys', h, {
      contextWindow: 8192,
      prefixStable: true,
    }) as Array<{ tool_call_id?: string; content: string }>;
    expect(out.find(m => m.tool_call_id === 'r')!.content).toContain('void sweepStaleSpills();');
  });
});

describe('the exemption is bounded in aggregate (#257)', () => {
  // Twelve 1,000-char crumbs: the ceiling admits four, and the rest age normally. Without a ceiling
  // a long session's small greps become chars no shrink event can ever reclaim, and an event that
  // cannot reach its watermark escalates to a fold — worse than the eviction the floor prevents.
  const crumbs = Array.from({ length: 12 }, (_, i) =>
    round(`c${i}`, `Ran: grep ${i} (1000 bytes output)`, `hit ${i} `.padEnd(1000, '.')),
  );

  it('grants the floor to only as many crumbs as the ceiling holds', () => {
    const { stats } = serialize(history(...crumbs));
    expect(stats.whole).toBe(4);
    expect(stats.summary).toBe(8);
  });

  it('spends the ceiling newest-first — the oldest crumbs are the least likely to be wanted', () => {
    const { contentFor } = serialize(history(...crumbs));
    expect(contentFor('c11')).toContain('hit 11 ');
    expect(contentFor('c8')).toContain('hit 8 ');
    expect(contentFor('c7')).not.toContain('hit 7 ');
    expect(contentFor('c0')).not.toContain('hit 0 ');
  });
});

describe('the estimators price a crumb at what it really costs (#257)', () => {
  // The aging walk sheds until its estimate reaches target, and the fresh cap subtracts everything
  // else in the request from the window. Both call agedContentChars with no request-scoped budget,
  // so it answers "crumb, therefore whole" — ignoring the ceiling. That over-prices at worst, which
  // shrinks the fresh cap and folds sooner; under-pricing is what sends a request out over window.
  const msg = {
    role: 'tool' as const,
    callId: 'r',
    summary: 'Read src/cli.tsx lines 1-13 of 13',
    payload: CLI_TSX,
  };

  it('prices a crumb at summary plus its whole payload', () => {
    expect(agedContentChars(msg)).toBe(msg.summary.length + 2 + CLI_TSX.length);
  });

  it('follows the request when it is told what the ceiling decided', () => {
    // A payload the ceiling can plausibly refuse: over the crossover (its outline is a fraction of
    // it) but under the floor, so the answer really does turn on the ceiling and nothing else.
    const mid = {
      role: 'tool' as const,
      callId: 'r',
      summary: 'Read src/mid.ts lines 1-62 of 62',
      payload: [
        g(1, 'export function only(): void {'),
        ...Array.from({ length: 60 }, (_, i) => g(i + 2, `  const filler${i} = ${i};`)),
        g(62, '}'),
      ].join('\n'),
    };
    expect(mid.payload.length).toBeLessThan(2048);
    expect(agedContentChars(mid, false)).toBeLessThan(agedContentChars(mid, true));
    expect(agedContentChars(mid)).toBe(agedContentChars(mid, true));
  });
});
