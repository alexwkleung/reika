import { describe, expect, it } from 'vitest';
import { buildQuestionLedger } from './loop.js';

describe('buildQuestionLedger', () => {
  // Inert until a question is actually answered — this is what keeps round 0 byte-identical to the
  // warm path's buildRoundZeroPrefix, since no answer can exist before the first round runs.
  it('is empty when nothing has been answered', () => {
    expect(buildQuestionLedger([])).toBe('');
  });

  it('pins the question and the answer', () => {
    const out = buildQuestionLedger([
      { question: 'Flag every interpreter, or only inline bodies?', answer: 'Only inline bodies' },
    ]);
    expect(out).toContain('Q: Flag every interpreter, or only inline bodies?');
    expect(out).toContain('A: Only inline bodies');
  });

  it('forecloses re-opening the decision', () => {
    const out = buildQuestionLedger([{ question: 'q?', answer: 'a' }]);
    expect(out).toMatch(/do not re-open it/i);
    expect(out).toMatch(/do not ask about it a second time/i);
  });

  // The answer resolves one fork, not the whole task: a ledger that read "Build exactly what that
  // answer says" was taken by a model mid-design-discussion as a go-ahead to implement.
  it('scopes the answer to the point asked, never as a go-ahead to build', () => {
    const out = buildQuestionLedger([{ question: 'q?', answer: 'a' }]);
    expect(out).toMatch(/settles this one point/i);
    expect(out).toMatch(/continue what you were doing/i);
    expect(out).not.toMatch(/\bbuild\b/i);
  });

  it('marks itself as harness-generated, not user input', () => {
    expect(buildQuestionLedger([{ question: 'q?', answer: 'a' }])).toContain(
      'auto-generated — not user input',
    );
  });

  // The tool caps at one per turn, but the ledger is the durable record and must not silently drop
  // an entry if that cap ever moves.
  it('lists every answer it is given', () => {
    const out = buildQuestionLedger([
      { question: 'first?', answer: 'one' },
      { question: 'second?', answer: 'two' },
    ]);
    expect(out).toContain('Q: first?');
    expect(out).toContain('Q: second?');
  });
});
