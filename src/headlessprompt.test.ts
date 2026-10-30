import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_LINES,
  approvalHeader,
  askApproval,
  askConfirm,
  askQuestion,
  createPrompter,
  parseChoice,
} from './headlessprompt.js';
import { skillConfirmSpec } from './ui/dialogspecs.js';
import type { ApprovalRequest } from './types.js';

// Feeds `answers` one line at a time, each once the prompter has asked for it, and records the
// terminal output, so a test reads what the user would have seen.
function terminal(answers: string[], signal?: AbortSignal) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', chunk => {
    shown += String(chunk);
    if (/[:?] $/.test(shown) && answers.length > 0) input.write(`${answers.shift()}\n`);
  });
  return { prompter: createPrompter(input, output, signal), shown: () => shown, input };
}

const bash: ApprovalRequest = { tool: 'bash', subject: 'npm test', preview: 'npm test' };

describe('parseChoice', () => {
  it('takes a 1-based row, the default on empty, and null for anything else', () => {
    expect(parseChoice('2', 3, 0)).toBe(1);
    expect(parseChoice('  ', 3, 2)).toBe(2);
    expect(parseChoice('4', 3, 0)).toBeNull();
    expect(parseChoice('0', 3, 0)).toBeNull();
    expect(parseChoice('yes', 3, 0)).toBeNull();
  });
});

describe('askApproval', () => {
  it('approves on Enter, since Approve is the default row as in the TUI', async () => {
    const t = terminal(['']);
    expect(await askApproval(t.prompter, bash)).toEqual({ answer: true, always: false });
    expect(t.shown()).toMatch(/approve .*npm test/);
    expect(t.shown()).toMatch(/1\. Approve {2}\(default\)/);
  });

  it('declines, and re-asks on an answer that is no row', async () => {
    const t = terminal(['9', '2']);
    expect(await askApproval(t.prompter, bash)).toEqual({ answer: false, always: false });
    expect(t.shown()).toMatch(/enter a number from 1 to 4/);
  });

  it('reports "Always (this session)" so the caller can lift its policy', async () => {
    const t = terminal(['3']);
    expect(await askApproval(t.prompter, bash)).toEqual({ answer: true, always: true });
  });

  it('carries the typed reason on a decline-with-feedback, and a plain decline without one', async () => {
    const t = terminal(['4', 'run the unit tests only']);
    expect((await askApproval(t.prompter, bash)).answer).toEqual({
      feedback: 'run the unit tests only',
    });
    const blank = terminal(['4', '']);
    expect((await askApproval(blank.prompter, bash)).answer).toBe(false);
  });

  it('declines on EOF rather than hanging', async () => {
    const t = terminal([]);
    t.input.end();
    expect((await askApproval(t.prompter, bash)).answer).toBe(false);
  });

  it('declines when the turn is aborted at the menu', async () => {
    const controller = new AbortController();
    const t = terminal([], controller.signal);
    const pending = askApproval(t.prompter, bash);
    controller.abort();
    expect((await pending).answer).toBe(false);
  });
});

describe('approvalHeader', () => {
  it('shows the warnings and caps a long preview', () => {
    const preview = Array.from({ length: PREVIEW_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    const header = approvalHeader({ ...bash, preview, warnings: ['Network request'] });
    expect(header).toContain('  ▲ Network request');
    expect(header.at(-1)).toBe('  │ … 5 more lines');
  });
});

describe('askQuestion', () => {
  const req = {
    question: 'Flag it or drop it?',
    options: [{ label: 'Flag it' }, { label: 'Drop it', recommended: true }],
  };

  it('picks a row by number, defaulting to the recommended one', async () => {
    expect(await askQuestion(terminal(['1']).prompter, req)).toEqual({ text: 'Flag it', index: 0 });
    expect(await askQuestion(terminal(['']).prompter, req)).toEqual({ text: 'Drop it', index: 1 });
  });

  it('takes a typed answer from the last row, with no index', async () => {
    const t = terminal(['3', 'neither — rename it']);
    expect(await askQuestion(t.prompter, req)).toEqual({ text: 'neither — rename it' });
  });
});

describe('askConfirm', () => {
  const spec = skillConfirmSpec({
    skill: { name: 'verify', description: 'verify a change' },
    matched: ['verify the change'],
  } as Parameters<typeof skillConfirmSpec>[0]);

  it('sends as typed by default and applies on row 2', async () => {
    expect(await askConfirm(terminal(['']).prompter, spec)).toBe(false);
    expect(await askConfirm(terminal(['2']).prompter, spec)).toBe(true);
  });
});

describe('createPrompter', () => {
  it('asks one menu at a time, so two approvals in a round do not share a line', async () => {
    const t = terminal(['1', '2']);
    const [a, b] = await Promise.all([
      askApproval(t.prompter, bash),
      askApproval(t.prompter, bash),
    ]);
    expect([a.answer, b.answer]).toEqual([true, false]);
  });
});
