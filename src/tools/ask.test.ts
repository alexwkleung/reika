import { describe, expect, it } from 'vitest';
import { askUserTool, normalizeOptions, MAX_OPTIONS } from './ask.js';
import type { QuestionAnswer, QuestionRequest, ToolContext } from '../types.js';

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: '/tmp',
  askedQuestions: [],
  ...over,
});

// Answers the question with whatever `answer` says, and records what it was shown.
const asker = (answer: QuestionAnswer | null) => {
  const seen: QuestionRequest[] = [];
  return {
    seen,
    requestQuestion: async (req: QuestionRequest): Promise<QuestionAnswer | null> => {
      seen.push(req);
      return answer;
    },
  };
};

describe('normalizeOptions', () => {
  it('accepts bare strings', () => {
    expect(normalizeOptions(['Flag it', 'Leave it alone'])).toEqual([
      { label: 'Flag it' },
      { label: 'Leave it alone' },
    ]);
  });

  it('accepts label aliases and description aliases', () => {
    expect(normalizeOptions([{ text: 'Flag it', detail: 'Everything prompts' }])).toEqual([
      { label: 'Flag it', description: 'Everything prompts' },
    ]);
    expect(normalizeOptions([{ title: 'A' }, { name: 'B' }, { value: 'C' }])).toEqual([
      { label: 'A' },
      { label: 'B' },
      { label: 'C' },
    ]);
  });

  it('splits a newline-separated string and strips list scaffolding', () => {
    expect(normalizeOptions('1. Flag it\n2. Leave it\n- Ask later')).toEqual([
      { label: 'Flag it' },
      { label: 'Leave it' },
      { label: 'Ask later' },
    ]);
  });

  it('drops duplicate labels', () => {
    expect(normalizeOptions(['Flag it', 'flag it', 'Leave it'])).toEqual([
      { label: 'Flag it' },
      { label: 'Leave it' },
    ]);
  });

  it(`caps at ${MAX_OPTIONS} options`, () => {
    expect(normalizeOptions(['a', 'b', 'c', 'd', 'e', 'f'])).toHaveLength(MAX_OPTIONS);
  });

  it('keeps only the first recommendation', () => {
    const out = normalizeOptions([
      { label: 'a', recommended: true },
      { label: 'b', recommended: true },
    ]);
    expect(out[0].recommended).toBe(true);
    expect(out[1].recommended).toBeUndefined();
  });

  it('accepts string-typed booleans for recommended', () => {
    expect(normalizeOptions([{ label: 'a', recommended: 'true' }])[0].recommended).toBe(true);
  });

  it('ignores entries with no usable label', () => {
    expect(normalizeOptions([{ label: '' }, { nope: 'x' }, 'ok', 'ok2'])).toEqual([
      { label: 'ok' },
      { label: 'ok2' },
    ]);
  });
});

describe('ask_user', () => {
  it('shows the question and returns the chosen label', async () => {
    const { seen, requestQuestion } = asker({ text: 'Flag it', index: 0 });
    const res = await askUserTool.run(
      { question: 'Flag interpreters?', options: ['Flag it', 'Leave it'] },
      ctx({ requestQuestion }),
    );
    expect(seen[0].question).toBe('Flag interpreters?');
    expect(seen[0].options).toHaveLength(2);
    expect(res.payload).toContain('The user answered: Flag it');
    expect(res.summary).toContain('Flag it');
  });

  // #526: a session switched unattended mid-way still has the tool, but nobody will answer.
  it('does not ask while the session is unattended', async () => {
    const { seen, requestQuestion } = asker({ text: 'Flag it', index: 0 });
    const res = await askUserTool.run(
      { question: 'Flag interpreters?', options: ['Flag it', 'Leave it'] },
      ctx({ requestQuestion, unattended: true }),
    );
    expect(seen).toHaveLength(0);
    expect(res.summary).toBe('ask_user: no user available to answer');
  });

  it('carries a note added on top of a chosen option', async () => {
    const { requestQuestion } = asker({ text: 'Flag it', index: 0, notes: 'only inline bodies' });
    const res = await askUserTool.run(
      { question: 'q?', options: ['Flag it', 'Leave it'] },
      ctx({ requestQuestion }),
    );
    expect(res.payload).toContain('The user added: only inline bodies');
  });

  it('tells the model the answer is settled', async () => {
    const { requestQuestion } = asker({ text: 'Flag it' });
    const res = await askUserTool.run(
      { question: 'q?', options: ['a', 'b'] },
      ctx({ requestQuestion }),
    );
    expect(res.payload).toMatch(/settled/i);
    expect(res.payload).toMatch(/do not .*ask again/i);
  });

  // The cap is the whole reason this tool doesn't become a new loop surface — a model stuck on a
  // decision must not be able to keep asking its way around deciding.
  it('refuses a second question in the same turn', async () => {
    const { seen, requestQuestion } = asker({ text: 'Flag it' });
    const shared = ctx({ requestQuestion });
    await askUserTool.run({ question: 'first?', options: ['a', 'b'] }, shared);
    const res = await askUserTool.run({ question: 'second?', options: ['a', 'b'] }, shared);
    expect(seen).toHaveLength(1);
    expect(res.payload).toContain('first?');
    expect(res.payload).toMatch(/only one question per turn/i);
  });

  it('records the question it asked', async () => {
    const { requestQuestion } = asker({ text: 'a' });
    const c = ctx({ requestQuestion });
    await askUserTool.run({ question: 'which one?', options: ['a', 'b'] }, c);
    expect(c.askedQuestions).toEqual(['which one?']);
  });

  // Malformed calls come back as a result, never a throw: a thrown error reads to the model as a
  // broken harness, while a result naming the right shape is something it can retry against.
  it('reports a malformed call without throwing, and does not consume the turn', async () => {
    const { seen, requestQuestion } = asker({ text: 'a' });
    const c = ctx({ requestQuestion });
    const res = await askUserTool.run({ question: 'q?', options: ['only one'] }, c);
    expect(seen).toHaveLength(0);
    expect(c.askedQuestions).toEqual([]);
    expect(res.payload).toContain('"label"');
    expect(res.summary).toContain('ask_user');
  });

  it('reports a missing question', async () => {
    const res = await askUserTool.run({ options: ['a', 'b'] }, ctx());
    expect(res.summary).toMatch(/no question text/);
  });

  it('degrades to a directive when there is nobody to ask', async () => {
    const res = await askUserTool.run({ question: 'q?', options: ['a', 'b'] }, ctx());
    expect(res.payload).toMatch(/no interactive user/i);
    expect(res.payload).toMatch(/decide from the code/i);
  });

  it('tells the model to proceed when the question is dismissed', async () => {
    const { requestQuestion } = asker(null);
    const res = await askUserTool.run(
      { question: 'q?', options: ['a', 'b'] },
      ctx({ requestQuestion }),
    );
    expect(res.summary).toContain('dismissed');
    expect(res.payload).toMatch(/own best reading/i);
  });
});
