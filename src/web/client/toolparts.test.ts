import { describe, expect, it } from 'vitest';
import { callParts, literal, summaryParts } from './toolparts.js';

describe('callParts', () => {
  it('draws the argument a tool acts on as code and the rest muted', () => {
    expect(callParts('bash', { command: 'pnpm test' })).toEqual([
      { text: 'pnpm test', code: true },
    ]);
    expect(callParts('read', { path: 'src/a.ts', offset: 10, limit: 40 })).toEqual([
      { text: 'src/a.ts', code: true },
      { text: 'offset=10, limit=40', muted: true },
    ]);
    // An edit's strings stay hidden, as the TUI hides them: its diff shows them.
    expect(callParts('edit', { path: 'b.ts', old_string: 'x', new_string: 'y' })).toEqual([
      { text: 'b.ts', code: true },
    ]);
    expect(callParts('ask_user', { question: 'ok?' })).toEqual([
      { text: 'question="ok?"', muted: true },
    ]);
  });

  it('keeps one line of a multi-line literal, and cuts a long one', () => {
    expect(literal("cat > a <<'EOF'\nbody\nEOF")).toBe("cat > a <<'EOF' …");
    expect(literal('x'.repeat(200))).toHaveLength(120);
  });
});

describe('summaryParts', () => {
  it('splits the tools’ own summaries into verb, literal and detail', () => {
    expect(summaryParts('Ran: pnpm test (exit 1, 2048 bytes output)')).toEqual([
      { text: 'Ran ' },
      { text: 'pnpm test', code: true },
      { text: ' (exit 1, 2048 bytes output)', muted: true },
    ]);
    expect(summaryParts('Read src/a.ts lines 1-40 of 120')).toEqual([
      { text: 'Read ' },
      { text: 'src/a.ts', code: true },
      { text: ' lines 1-40 of 120', muted: true },
    ]);
    // A lone read has dropped its verb (elidedReadSummary).
    expect(summaryParts('src/a.ts lines 1-40 of 120')[0]).toEqual({ text: 'src/a.ts', code: true });
    expect(summaryParts('Edited b.ts at line 4 (+2 -1)')[1]).toEqual({ text: 'b.ts', code: true });
    expect(summaryParts('Found 3 matches for /foo|bar/')[1]).toEqual({
      text: '/foo|bar/',
      code: true,
    });
    expect(summaryParts('Fetched https://example.com/a (900 chars extracted)')[1]).toEqual({
      text: 'https://example.com/a',
      code: true,
    });
    expect(summaryParts('Bash declined by user: rm -rf build')).toEqual([
      { text: 'Bash declined by user: ' },
      { text: 'rm -rf build', code: true },
    ]);
  });

  it('leaves a shape it does not know as plain text', () => {
    expect(summaryParts('Edit failed: old_string not found in a.ts.')).toEqual([
      { text: 'Edit failed: old_string not found in a.ts.' },
    ]);
    expect(summaryParts('Subagent completed (6400 chars)')).toEqual([
      { text: 'Subagent completed (6400 chars)' },
    ]);
  });
});

describe('summaryParts stat', () => {
  it('colors an edit summary counts by side', () => {
    const parts = summaryParts('Edited src/a.ts at line 3 (+2 -1)');
    expect(parts.filter(p => p.side).map(p => [p.text, p.side])).toEqual([
      ['+2', 'added'],
      ['-1', 'removed'],
    ]);
  });
});
