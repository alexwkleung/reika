import { describe, expect, it } from 'vitest';
import { MAX_STEP_ROWS, planWindow } from './planwindow.js';

const steps = (done: number, total: number) =>
  Array.from({ length: total }, (_, i) => ({ n: i + 1, done: i < done }));

describe('planWindow', () => {
  it('shows a short plan whole', () => {
    expect(planWindow(steps(3, MAX_STEP_ROWS))).toEqual({
      collapsedDone: 0,
      visible: steps(3, MAX_STEP_ROWS),
      hiddenTail: 0,
    });
  });

  it('folds leading done steps and caps the tail, inside the row budget', () => {
    const w = planWindow(steps(3, 12));
    expect(w.collapsedDone).toBe(3);
    expect(w.visible.map(s => s.n)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(w.hiddenTail).toBe(3);
    // Summary row + visible + tail row is the TUI's 8.
    expect(1 + w.visible.length + 1).toBe(MAX_STEP_ROWS);
  });

  it('caps the tail with nothing done yet', () => {
    const w = planWindow(steps(0, 10));
    expect(w.collapsedDone).toBe(0);
    expect(w.visible).toHaveLength(MAX_STEP_ROWS - 1);
    expect(w.hiddenTail).toBe(3);
  });
});
