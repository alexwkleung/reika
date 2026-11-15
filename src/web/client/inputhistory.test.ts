import { describe, expect, it } from 'vitest';
import { notRecalling, recallStep } from './inputhistory.js';

describe('recallStep', () => {
  const history = ['one', 'two', 'three'];

  it('steps back from the newest, keeping the draft, and stops at the oldest', () => {
    let step = recallStep(history, notRecalling, 'my draft', 'older')!;
    expect(step).toEqual({ recall: { index: 2, draft: 'my draft' }, text: 'three' });
    step = recallStep(history, step.recall, step.text, 'older')!;
    step = recallStep(history, step.recall, step.text, 'older')!;
    expect(step.text).toBe('one');
    expect(recallStep(history, step.recall, step.text, 'older')).toBeNull();
  });

  it('steps forward and gives the draft back past the newest', () => {
    const at = { index: 1, draft: 'my draft' };
    const next = recallStep(history, at, 'two', 'newer')!;
    expect(next.text).toBe('three');
    expect(recallStep(history, next.recall, next.text, 'newer')).toEqual({
      recall: notRecalling,
      text: 'my draft',
    });
  });

  it('does nothing with no history, or forward when not recalling', () => {
    expect(recallStep([], notRecalling, 'x', 'older')).toBeNull();
    expect(recallStep(history, notRecalling, 'x', 'newer')).toBeNull();
  });
});
