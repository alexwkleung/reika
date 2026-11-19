import { describe, expect, it } from 'vitest';
import { frameBatched, frameOrTimer } from './framebatch.js';

describe('frameOrTimer', () => {
  it('runs once, on whichever fires first', () => {
    const frames: (() => void)[] = [];
    const timers: (() => void)[] = [];
    const schedule = frameOrTimer(
      cb => frames.push(cb),
      cb => timers.push(cb),
    );
    let runs = 0;
    schedule(() => runs++);
    frames[0]!();
    timers[0]!();
    expect(runs).toBe(1);
  });

  it('draws a hidden tab from the timer when no frame comes', () => {
    const timers: (() => void)[] = [];
    const schedule = frameOrTimer(
      () => {},
      cb => timers.push(cb),
    );
    let runs = 0;
    const notify = frameBatched(() => runs++, schedule);
    notify();
    notify();
    timers[0]!();
    expect(runs).toBe(1);
    notify();
    expect(timers).toHaveLength(2);
  });
});
