import { describe, expect, it } from 'vitest';
import { changeLabel, formatElapsed, formatDurationMs, toolLabel } from './format.js';

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
