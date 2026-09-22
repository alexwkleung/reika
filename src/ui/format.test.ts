import { describe, expect, it } from 'vitest';
import {
  changeLabel,
  formatElapsed,
  formatDurationMs,
  formatTokensPerSecond,
  toolLabel,
} from './format.js';

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

describe('formatTokensPerSecond', () => {
  it('keeps one decimal under 10, where the difference is what the reader is looking at', () => {
    expect(formatTokensPerSecond(8.44)).toBe('8.4 t/s');
    expect(formatTokensPerSecond(3.16)).toBe('3.2 t/s');
  });

  // 9.96 rounds to 10, and `10.0 t/s` next to `10 t/s` on the next round is the kind of jitter a
  // status bar must not show.
  it('crosses to whole numbers without a trailing .0', () => {
    expect(formatTokensPerSecond(9.96)).toBe('10 t/s');
    expect(formatTokensPerSecond(20.4)).toBe('20 t/s');
    expect(formatTokensPerSecond(999.4)).toBe('999 t/s');
  });

  it('compacts a four-digit rate like a token count', () => {
    expect(formatTokensPerSecond(1234)).toBe('1.2k t/s');
    expect(formatTokensPerSecond(20_000)).toBe('20k t/s');
  });

  it('renders nothing when there is no rate', () => {
    expect(formatTokensPerSecond(undefined)).toBe('');
    expect(formatTokensPerSecond(0)).toBe('');
    expect(formatTokensPerSecond(Number.NaN)).toBe('');
  });
});

describe('toolLabel', () => {
  // `ask_user` is named for the model (it says who is being asked); the chip is for the user,
  // where it should read like every other one-word tool name.
  it('renders ask_user as Ask', () => {
    expect(toolLabel('ask_user')).toBe('Ask');
  });

  // Same wart, same fix: the chip showed the raw `fetch_url`. The args already carry the URL, so
  // the label has no work to do beyond naming the verb.
  it('renders fetch_url as Fetch', () => {
    expect(toolLabel('fetch_url')).toBe('Fetch');
  });

  it('capitalizes tools with no override', () => {
    expect(toolLabel('bash')).toBe('Bash');
    expect(toolLabel('edit')).toBe('Edit');
  });

  it('leaves an empty name alone', () => {
    expect(toolLabel('')).toBe('');
  });
});

describe('changeLabel', () => {
  it('reads like the edit tool stat for a modified file, naming the kind only otherwise', () => {
    expect(changeLabel({ kind: 'modified', added: 3, removed: 1 })).toBe('(+3 -1)');
    expect(changeLabel({ kind: 'created', added: 12, removed: 0 })).toBe('(new, +12)');
    expect(changeLabel({ kind: 'deleted', added: 0, removed: 40 })).toBe('(deleted, -40)');
    expect(changeLabel({ kind: 'binary', added: 0, removed: 0 })).toBe('(binary)');
    expect(changeLabel({ kind: 'rewritten', added: 3040, removed: 3000 })).toBe(
      '(rewritten, 3000 → 3040 lines)',
    );
  });
});
