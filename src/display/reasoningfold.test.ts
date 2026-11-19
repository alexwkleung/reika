import { describe, expect, it } from 'vitest';
import { foldSpilledReasoning, foldedAssistantFields } from './reasoningfold.js';

describe('foldSpilledReasoning', () => {
  // The sighted shape: the endpoint's reasoning parser ended the thinking channel at a literal tag
  // the model wrote in its own prose, consuming the tag and leaving the inline span open.
  it('carries a content tail that closes an open code span back into the reasoning', () => {
    const reasoning = 'the parser cut the think block at a literal `';
    const content = '` the model wrote inside its own reasoning.';
    expect(foldSpilledReasoning(reasoning, content)).toEqual({
      reasoning: reasoning + content,
      content: '',
    });
  });

  it('folds when the open span sits mid-line rather than on the last character', () => {
    // `…that means the model emitted \`<think>…` + `` ` but the parser split … `` — the span is
    // open even though the reasoning's last character is not a backtick.
    const folded = foldSpilledReasoning('the model emitted `<think>...', '` but the parser split');
    expect(folded.content).toBe('');
    expect(folded.reasoning).toBe('the model emitted `<think>...` but the parser split');
  });

  it('leaves a reply that merely opens with a code span alone', () => {
    // A closed span on the reasoning's last line, then a fresh span in the reply: two backticks,
    // not the same span. The even count is exactly what separates this from a cut span.
    const folded = foldSpilledReasoning('It reads `foo`.', '`bar` is the answer.');
    expect(folded).toEqual({ reasoning: 'It reads `foo`.', content: '`bar` is the answer.' });
  });

  it('folds a quoted run left open — the shape that first slipped through', () => {
    // From a live run: the model wrote the tag in single quotes, so the guard's backtick-only
    // version matched nothing and the thinking sat in the reply.
    const reasoning = "and only extracts them if the model emits a '";
    const content = "' tag\n```\n\nHmm, actually the README says:";
    const folded = foldSpilledReasoning(reasoning, content);
    expect(folded.content).toBe('');
    expect(folded.reasoning).toBe(reasoning + content);
  });

  it('folds a double-quoted run too', () => {
    const folded = foldSpilledReasoning(
      'the help text reads "',
      '"controls whether thought tags are allowed"',
    );
    expect(folded.content).toBe('');
  });

  it('does not treat a contraction’s apostrophe as an open quote', () => {
    // `don't` also ends the line with one `'`, which the odd-count test alone would call open. The
    // letter in front of it is what says apostrophe.
    const folded = foldSpilledReasoning("the flag is called don't", "'s the format string");
    expect(folded.content).toBe("'s the format string");
  });

  it('does not fold when the content does not open with a delimiter', () => {
    expect(foldSpilledReasoning('cut at a literal `', 'the model wrote it')).toEqual({
      reasoning: 'cut at a literal `',
      content: 'the model wrote it',
    });
  });

  it('does not fold when the content opens a different delimiter than the open run', () => {
    const folded = foldSpilledReasoning('the parser matches "', '`x`');
    expect(folded.content).toBe('`x`');
  });

  it('reads only the last line: an open span above a balanced one does not qualify', () => {
    // Inline spans never cross a newline, so an unclosed backtick on an earlier line is not open
    // at the boundary.
    const folded = foldSpilledReasoning('an open `span\nclosed `here`', '`next`');
    expect(folded.content).toBe('`next`');
  });

  it('is a no-op when either channel is empty or absent', () => {
    expect(foldSpilledReasoning(undefined, '`x`')).toEqual({ reasoning: '', content: '`x`' });
    expect(foldSpilledReasoning('cut `', '')).toEqual({ reasoning: 'cut `', content: '' });
    expect(foldSpilledReasoning(undefined, undefined)).toEqual({ reasoning: '', content: '' });
  });

  it('keeps the boundary bytes verbatim, including leading whitespace', () => {
    expect(foldSpilledReasoning('cut `', '  ` rest').reasoning).toBe('cut `  ` rest');
  });
});

describe('foldedAssistantFields', () => {
  it('drops the folded content and keeps the reasoning, ignoring the other fields', () => {
    const out = foldedAssistantFields({
      role: 'assistant',
      reasoning: 'cut `',
      content: '` rest',
      toolCalls: [{ id: 't1', name: 'bash', args: {} }],
    });
    expect(out).toEqual({ reasoning: 'cut `` rest', content: '' });
  });

  it('leaves a normal reply untouched and omits an absent reasoning key', () => {
    expect(foldedAssistantFields({ role: 'assistant', content: 'done' })).toEqual({
      content: 'done',
    });
  });
});
