import { describe, expect, it } from 'vitest';
import { windowStart } from './ResumeSelect.js';

describe('windowStart', () => {
  it('does not scroll a list that fits', () => {
    expect(windowStart(5, 4, 8)).toBe(0);
  });

  it('keeps the cursor inside the window and stops at either end', () => {
    expect(windowStart(20, 0, 8)).toBe(0);
    expect(windowStart(20, 10, 8)).toBe(6);
    expect(windowStart(20, 19, 8)).toBe(12);
    for (let sel = 0; sel < 20; sel++) {
      const start = windowStart(20, sel, 8);
      expect(sel).toBeGreaterThanOrEqual(start);
      expect(sel).toBeLessThan(start + 8);
    }
  });
});
