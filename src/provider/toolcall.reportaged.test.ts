import { describe, expect, it } from 'vitest';
import { messagesToOpenAI, type AgedStats } from './toolcall.js';
import type { Message } from '../types.js';

// #354: a subagent report is already a digest. Aged, it used to serialize as its summary —
// `Subagent completed (5165 chars)`, a byte count — and the parent went back to reading the files
// the subagent had read. Now it keeps its head, sized like a compaction note.

const REPORT = [
  '**Ordered chain (file → function):**',
  '1. `src/tools/bash.ts` — `bashTool.run` (line 21), gate at line 39: `if (ctx.requestApproval)`.',
  '2. `src/tools/_danger.ts` — `detectDangerousPatterns` (line 697) → `detectAtDepth`.',
  ...Array.from({ length: 80 }, (_, i) => `${i + 3}. finding ${i}: ${'detail '.repeat(8)}`),
  '**Not covered:**',
  '- src/agent/loop.ts runTurn body — no exact line for the dispatch.',
].join('\n');

// Same shape as toolcall.agedstats.test: a spec-pin holder first so the slot under test ages, the
// subagent result in the middle, and a huge trailing read so the window is over budget.
const history = (summary: string, payload: string): Message[] => [
  { role: 'user', content: 'trace it' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'grep', args: {} }] },
  { role: 'tool', callId: 'spec', summary: 'Found 3 matches', payload: 'a\nb\nc' },
  { role: 'assistant', content: '', toolCalls: [{ id: 's', name: 'subagent', args: {} }] },
  { role: 'tool', callId: 's', summary, payload },
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
  return { aged: out.find(m => m.tool_call_id === 's')!.content, stats: stats! };
}

describe('aged subagent report keeps its head (#354)', () => {
  it('serializes the chain, not the byte count, and counts as `report`', () => {
    const { aged, stats } = serialize(history('Subagent completed (5000 chars)', REPORT));
    expect(aged).toContain('Subagent completed (5000 chars)');
    expect(aged).toContain('bashTool.run');
    expect(aged).toContain('detectDangerousPatterns');
    expect(aged).toContain('report continues');
    expect(aged.length).toBeLessThan(REPORT.length);
    expect(stats.report).toBe(1);
    expect(stats.summary).toBe(0);
  });

  it('takes the model-named summary shape too, and cuts on a line boundary', () => {
    const { aged } = serialize(history('Subagent (qwen) completed (5000 chars)', REPORT));
    expect(aged).toContain('bashTool.run');
    const body = aged.split('\n\n').slice(1).join('\n\n');
    const lines = body.split('\n');
    // Every kept line is a whole line of the report (the head is trimmed, so compare trimmed);
    // the marker is last.
    const source = REPORT.split('\n').map(l => l.trimEnd());
    for (const l of lines.slice(0, -1)) expect(source).toContain(l.trimEnd());
    expect(lines[lines.length - 1]).toMatch(/^\(… report continues/);
  });

  it('keeps a short report whole, under the crumb floor', () => {
    const short = 'Chain: a → b → c.\nNot covered: d.';
    const { aged, stats } = serialize(history('Subagent completed (40 chars)', short));
    expect(aged).toContain(short);
    expect(stats.whole).toBe(1);
  });

  it('leaves a non-subagent payload of the same prose shape on the old path', () => {
    const { aged, stats } = serialize(history('Ran: cat notes.md (5000 bytes output)', REPORT));
    expect(stats.report).toBe(0);
    expect(aged).toBe('Ran: cat notes.md (5000 bytes output)');
  });
});
