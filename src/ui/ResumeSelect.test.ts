import { describe, expect, it } from 'vitest';
import { formatSavedAt, windowStart } from './ResumeSelect.js';

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

describe('formatSavedAt', () => {
  // ICU separates the day period with U+202F on newer versions; normalize so the test isn't pinned to one.
  const fmt = (iso: string, now: Date, locale: string) =>
    formatSavedAt(iso, now, locale).replace(/\s/g, ' ');
  const saved = new Date(2026, 8, 22, 23, 28).toISOString();

  it("follows the locale's clock and omits this year", () => {
    const now = new Date(2026, 11, 1);
    expect(fmt(saved, now, 'en-US')).toBe('Sep 22, 11:28 PM');
    expect(fmt(saved, now, 'en-GB')).toMatch(/^22 Sept?, 23:28$/);
  });

  it('shows the year for an earlier one', () => {
    expect(fmt(saved, new Date(2027, 0, 2), 'en-US')).toBe('Sep 22, 2026, 11:28 PM');
  });

  it('passes an unparseable stamp through', () => {
    expect(formatSavedAt('garbage')).toBe('garbage');
  });
});
