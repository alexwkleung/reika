import { describe, expect, it } from 'vitest';
import {
  PRESSURE_MIN_FILES,
  PRESSURE_READ_HORIZON,
  READ_COST_TOKENS,
  buildSubagentAffordance,
  filesInResult,
  underPressure,
} from './subagentpressure.js';

describe('filesInResult', () => {
  it('counts distinct files in a grep result, ignoring context lines, separators and footers', () => {
    const payload = [
      'src/a.ts:10: const x = requestApproval;',
      'src/a.ts:11- next line',
      '--',
      'src/b.ts:3: requestApproval(',
      'src/ui/App.tsx:701: const requestApproval = (',
      'src/ui/App.tsx:1549: requestApproval: config.autoApprove',
      '--',
      'src/agent/loop.ts:2449: requestApproval: opts.requestApproval,',
      '',
      '[reika: 120 more matches saved to /tmp/x/grep-1.txt — read it to see the rest]',
    ].join('\n');
    expect(filesInResult('grep', payload)).toBe(4);
  });

  it('counts glob lines as files and skips the footer', () => {
    expect(filesInResult('glob', 'src/a.ts\nsrc/b.ts\nsrc/c.ts\n(3 more saved to …)')).toBe(3);
  });

  it('is zero for other tools and empty payloads', () => {
    expect(filesInResult('read', 'src/a.ts:1: x')).toBe(0);
    expect(filesInResult('grep', undefined)).toBe(0);
    expect(filesInResult('grep', '')).toBe(0);
  });
});

describe('underPressure', () => {
  const threshold = 16070; // 24k window, 6144 reserve, 0.9 safety
  it('never fires under the file minimum, whatever the pressure', () => {
    expect(
      underPressure({
        files: PRESSURE_MIN_FILES - 1,
        estimateTokens: 15000,
        thresholdTokens: threshold,
      }),
    ).toBe(false);
  });

  it('fires when the next reads would cross the threshold, and not before', () => {
    const reads = PRESSURE_READ_HORIZON * READ_COST_TOKENS;
    expect(
      underPressure({
        files: 9,
        estimateTokens: threshold - reads - 1,
        thresholdTokens: threshold,
      }),
    ).toBe(false);
    expect(
      underPressure({
        files: 9,
        estimateTokens: threshold - reads + 1,
        thresholdTokens: threshold,
      }),
    ).toBe(true);
  });

  it('forecasts only the horizon, not every file found', () => {
    // 40 files, but the forecast is capped at PRESSURE_READ_HORIZON reads.
    const reads = PRESSURE_READ_HORIZON * READ_COST_TOKENS;
    expect(
      underPressure({
        files: 40,
        estimateTokens: threshold - reads - 1,
        thresholdTokens: threshold,
      }),
    ).toBe(false);
  });
});

describe('buildSubagentAffordance', () => {
  it('names the count, the shrink, and the way out', () => {
    const a = buildSubagentAffordance(7);
    expect(a).toContain('7 files match');
    expect(a).toContain('force a shrink');
    expect(a).toContain('Hand the list to subagent');
    expect(a).toContain('report comes back bounded');
  });
});
