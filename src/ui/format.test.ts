import { describe, expect, it } from 'vitest';
import { formatElapsed, formatDurationMs } from './format.js';

describe('formatElapsed', () => {
  it('renders bare seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59)).toBe('59s');
  });

  it('pads seconds once minutes appear', () => {
    expect(formatElapsed(60)).toBe('1m 00s');
    expect(formatElapsed(303)).toBe('5m 03s');
    expect(formatElapsed(3599)).toBe('59m 59s');
  });

  it('rolls minutes into hours at 60m (issue #74)', () => {
    expect(formatElapsed(3600)).toBe('1h 00m 00s');
    expect(formatElapsed(4212)).toBe('1h 10m 12s');
    expect(formatElapsed(7325)).toBe('2h 02m 05s');
  });
});

describe('formatDurationMs', () => {
  it('rounds milliseconds to the nearest second', () => {
    expect(formatDurationMs(12000)).toBe('12s');
    expect(formatDurationMs(12499)).toBe('12s');
    expect(formatDurationMs(12500)).toBe('13s');
  });

  it('matches the status-bar format above an hour', () => {
    expect(formatDurationMs(4_212_000)).toBe('1h 10m 12s');
  });
});
