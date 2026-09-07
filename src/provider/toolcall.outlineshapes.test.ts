import { describe, expect, it } from 'vitest';
import { messagesToOpenAI } from './toolcall.js';
import type { Message } from '../types.js';

// #269: the single declaration-keyword rule scored 96% on plain source and 29% / 0% / 0% on test
// files, markdown and JSON across 12 real transcripts — 23 of 104 reads kept nothing, carrying
// 198KB between them. `describe(` is a call, `## Heading` is prose to a keyword matcher, and a JSON
// key is neither. Each shape gets the rule its own structure has, dispatched on the extension in
// the summary the message already carries.
const g = (n: number, text: string): string => `${String(n).padStart(5, ' ')}│${text}`;

const history = (summary: string, payload: string): Message[] => [
  { role: 'user', content: 'work' },
  // Spec-pin holder: the turn's first small payload stays live (#227) and would never age.
  { role: 'assistant', content: '', toolCalls: [{ id: 'spec', name: 'bash', args: {} }] },
  { role: 'tool', callId: 'spec', summary: 'Ran: gh issue view 269', payload: 'ISSUE' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read', args: {} }] },
  { role: 'tool', callId: 'r', summary, payload },
  { role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'read', args: {} }] },
  { role: 'tool', callId: 'z', summary: 'Read x', payload: 'Z'.repeat(40_000) },
];

const agedContent = (summary: string, payload: string): string => {
  const out = messagesToOpenAI('sys', history(summary, payload), {
    contextWindow: 8192,
  }) as Array<{ tool_call_id?: string; content: string }>;
  return out.find(m => m.tool_call_id === 'r')!.content;
};

// Padding keeps every fixture past the crossover where keeping the payload whole is cheaper.
const pad = (from: number, n: number, text: string): string[] =>
  Array.from({ length: n }, (_, i) => g(from + i, text));

describe('test files outline by their block openers (#269)', () => {
  const TEST_FILE = [
    g(1, "import { describe, expect, it } from 'vitest';"),
    g(2, ''),
    g(3, "describe('spillResult', () => {"),
    ...pad(4, 40, "  it('writes a file', async () => {"),
    g(44, '});'),
    g(45, ''),
    g(46, "describe('footers', () => {"),
    ...pad(47, 40, '  const fixture = makeFixture();'),
    g(87, '});'),
  ].join('\n');

  it('keeps describe() openers a declaration-keyword rule cannot see', () => {
    const aged = agedContent('Read src/tools/_spill.test.ts lines 1-87 of 238', TEST_FILE);
    expect(aged).toContain("    3│describe('spillResult', () => {");
    expect(aged).toContain("   46│describe('footers', () => {");
    // Indented `it(` is a body detail at this granularity — an outline of every case is a listing.
    expect(aged).not.toContain("it('writes a file'");
    expect(aged).not.toContain('makeFixture');
  });

  it('leaves the closing brackets out — a `});` column is not a map', () => {
    const aged = agedContent('Read src/tools/_spill.test.ts lines 1-87 of 238', TEST_FILE);
    expect(aged).not.toContain('│});');
  });
});

describe('markdown outlines by heading (#269)', () => {
  const DOC = [
    g(1, '# Agent Guide for Reika'),
    ...pad(2, 30, 'Prose that runs on for a while and carries no structure at all.'),
    g(32, '## Code conventions'),
    ...pad(33, 30, '- A bullet: formatter is Prettier, single quotes, semicolons.'),
    g(63, '### Adding a tool'),
    ...pad(64, 30, 'More prose, this time about tools and where they live.'),
  ].join('\n');

  it('keeps the heading tree with its line numbers', () => {
    const aged = agedContent('Read AGENTS.md lines 1-93 of 828', DOC);
    expect(aged).toContain('    1│# Agent Guide for Reika');
    expect(aged).toContain('   32│## Code conventions');
    expect(aged).toContain('   63│### Adding a tool');
    expect(aged).not.toContain('Prose that runs on');
  });

  it('does not treat a shell comment as a heading in a code file', () => {
    // `#` is why markdown needed its own rule instead of a shared one: in a .sh these are comments.
    const SH = [
      g(1, '# Build the thing'),
      ...pad(2, 40, '# another comment line that is not structure'),
      g(42, '# Deploy the thing'),
    ].join('\n');
    expect(agedContent('Read scripts/deploy.sh lines 1-42 of 42', SH)).toBe(
      'Read scripts/deploy.sh lines 1-42 of 42',
    );
  });
});

describe('json outlines by top-level key (#269)', () => {
  const PKG = [
    g(1, '{'),
    g(2, '  "name": "reika",'),
    ...pad(3, 30, '    "some-dep": "^1.0.0",'),
    g(33, '  "scripts": {'),
    ...pad(34, 30, '    "test": "vitest run",'),
    g(64, '  },'),
    g(65, '  "type": "module"'),
    g(66, '}'),
  ].join('\n');

  it('keeps the top-level keys and drops the nested ones', () => {
    const aged = agedContent('Read package.json lines 1-66 of 68', PKG);
    expect(aged).toContain('    2│  "name": "reika",');
    expect(aged).toContain('   33│  "scripts": {');
    expect(aged).toContain('   65│  "type": "module"');
    expect(aged).not.toContain('some-dep');
  });
});

describe('an unknown extension stays on the conservative rule (#269)', () => {
  it('outlines by declaration keyword only, never by block opener', () => {
    // A `.txt` whose prose happens to end lines in `:` must not read as structure. Keywords still
    // apply, so a genuinely declaration-shaped line in an unknown dialect is still kept.
    const PROSE = [
      g(1, 'Summary:'),
      ...pad(2, 40, 'Consider the following:'),
      g(42, 'Conclusion:'),
    ].join('\n');
    expect(agedContent('Read notes/design.txt lines 1-42 of 42', PROSE)).toBe(
      'Read notes/design.txt lines 1-42 of 42',
    );
  });

  it('falls back to the default rule when the summary names no file at all', () => {
    const CODE = [
      g(1, "import { readFile } from 'node:fs/promises';"),
      ...pad(2, 40, '  const x = 1;'),
      g(42, 'export function two(): void {'),
    ].join('\n');
    const aged = agedContent('Read x', CODE);
    expect(aged).toContain("    1│import { readFile } from 'node:fs/promises';");
    expect(aged).toContain('   42│export function two(): void {');
  });
});

describe('structure is relative to the page, not the file (#269)', () => {
  it('outlines the cases when the page is one suite’s interior', () => {
    // `read src/tools/_spill.test.ts lines 42-186` — the enclosing `describe(` is back at line 30,
    // so every opener on this page is indented. Six of the misses this issue measured were this.
    const INTERIOR = [
      g(42, "  it('sweeps a stale dir', async () => {"),
      ...pad(43, 30, '    expect(await sweep()).toBe(1);'),
      g(73, '  });'),
      g(74, "  it('leaves a live dir alone', async () => {"),
      ...pad(75, 30, '    expect(await sweep()).toBe(0);'),
      g(105, '  });'),
    ].join('\n');
    const aged = agedContent('Read src/tools/_spill.test.ts lines 42-105 of 238', INTERIOR);
    expect(aged).toContain("   42│  it('sweeps a stale dir', async () => {");
    expect(aged).toContain("   74│  it('leaves a live dir alone', async () => {");
    expect(aged).not.toContain('expect(await sweep())');
  });

  it('keeps a single opener — one line is still a map of the range', () => {
    const ONE = [
      g(218, "describe('footers', () => {"),
      ...pad(219, 40, "  expect(footer(page)).toContain('more lines below');"),
      g(259, '});'),
    ].join('\n');
    const aged = agedContent('Read src/tools/_spill.test.ts lines 218-259 of 259', ONE);
    expect(aged).toContain("  218│describe('footers', () => {");
    expect(aged).not.toContain('more lines below');
  });

  it('still keeps nothing when the page has no structural line at all', () => {
    // A mid-function body: `const` at an indent is a local, not a declaration, and `}` is a closer.
    const BODY = [
      ...pad(120, 40, '    const partial = accumulate(chunk);'),
      g(160, '    return partial;'),
      g(161, '  }'),
    ].join('\n');
    expect(agedContent('Read src/tools/edit.ts lines 120-161 of 455', BODY)).toBe(
      'Read src/tools/edit.ts lines 120-161 of 455',
    );
  });
});
