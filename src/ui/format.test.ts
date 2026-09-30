import { describe, expect, it } from 'vitest';
import {
  changeLabel,
  formatElapsed,
  formatDurationMs,
  formatTokensPerSecond,
  LIVE_TIMER_AFTER_S,
  mcpStartupLine,
  pendingToolTimer,
  toolLabel,
  toolVerb,
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
    expect(formatTokensPerSecond(8.44)).toBe('8.4 tok/s');
    expect(formatTokensPerSecond(3.16)).toBe('3.2 tok/s');
  });

  // 9.96 rounds to 10, and `10.0 tok/s` next to `10 tok/s` on the next round is the kind of jitter a
  // status bar must not show.
  it('crosses to whole numbers without a trailing .0', () => {
    expect(formatTokensPerSecond(9.96)).toBe('10 tok/s');
    expect(formatTokensPerSecond(20.4)).toBe('20 tok/s');
    expect(formatTokensPerSecond(999.4)).toBe('999 tok/s');
  });

  // Rounded before the four-digit branch is chosen, or 999.6 prints `1000 tok/s` — a width no other
  // rate shows — on its way from `999 tok/s` to `1.0k tok/s`.
  it('rounds before choosing the compact form', () => {
    expect(formatTokensPerSecond(999.6)).toBe('1.0k tok/s');
    expect(formatTokensPerSecond(999.99)).toBe('1.0k tok/s');
  });

  it('compacts a four-digit rate like a token count', () => {
    expect(formatTokensPerSecond(1234)).toBe('1.2k tok/s');
    expect(formatTokensPerSecond(20_000)).toBe('20k tok/s');
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

  // MCP tools (#265) arrive as `mcp__server__tool`; the chip is read by a human, who types
  // `/server:tool` to invoke the same tool.
  it('spells an MCP tool the way its slash command does', () => {
    expect(toolLabel('mcp__fs__read_file')).toBe('Mcp fs:read_file');
    expect(toolLabel('mcp__fs__a__b')).toBe('Mcp fs:a__b');
    expect(toolLabel('mcp__lonely')).toBe('Mcp lonely');
  });

  it('leaves an empty name alone', () => {
    expect(toolLabel('')).toBe('');
  });
});

describe('toolVerb', () => {
  // The two the issue asked for by name, plus the past-tense summary each one's row becomes.
  it('gives bash and edit the verbs of their committed rows', () => {
    expect(toolVerb('bash')).toBe('Running');
    expect(toolVerb('edit')).toBe('Editing');
  });

  it('covers every tool the loop can dispatch', () => {
    expect(toolVerb('read')).toBe('Reading');
    expect(toolVerb('list')).toBe('Listing');
    expect(toolVerb('grep')).toBe('Matching');
    expect(toolVerb('glob')).toBe('Matching');
    expect(toolVerb('write')).toBe('Writing');
    expect(toolVerb('fetch_url')).toBe('Fetching');
    expect(toolVerb('search')).toBe('Searching');
    expect(toolVerb('ask_user')).toBe('Asking');
    expect(toolVerb('subagent')).toBe('Delegating');
  });

  it('gives an MCP call the verb its own summary starts with', () => {
    expect(toolVerb('mcp__fs__read_file')).toBe('Calling');
  });

  // A local regex scan and an outbound query, both committing as "Found …": grep's matches, glob's
  // files matching, web search's results. Only the last is a web lookup, so only it says Searching.
  it('separates the file search pair from web search', () => {
    expect(toolVerb('search')).not.toBe(toolVerb('grep'));
    expect(toolVerb('grep')).toBe(toolVerb('glob'));
  });

  // A tool the table has never heard of still gets a row — the alternative is a call that runs
  // silently, which is the whole complaint.
  it('falls back to Working for an unknown tool', () => {
    expect(toolVerb('some_plugin')).toBe('Working');
    expect(toolVerb('')).toBe('Working');
  });
});

describe('pendingToolTimer', () => {
  // A real build or test suite runs for minutes (#408), and while it prints nothing the row above
  // is the only thing saying the command is still going (#585).
  it('ages a long-running bash call', () => {
    expect(pendingToolTimer('bash', 7)).toBe(' · 7s');
    expect(pendingToolTimer('bash', 303)).toBe(' · 5m 03s');
    expect(pendingToolTimer('bash', 4212)).toBe(' · 1h 10m 12s');
  });

  // Below the threshold the row stays byte-identical to what #509 drew: a number ticking up over
  // every `ls` is a flicker, and the question the timer answers has not been asked yet.
  it('says nothing until the call has been running a while', () => {
    expect(pendingToolTimer('bash', LIVE_TIMER_AFTER_S - 1)).toBe('');
    expect(pendingToolTimer('bash', 0)).toBe('');
    expect(pendingToolTimer('bash', LIVE_TIMER_AFTER_S)).toBe(' · 5s');
  });

  it('times bash only', () => {
    expect(pendingToolTimer('edit', 60)).toBe('');
    expect(pendingToolTimer('read', 60)).toBe('');
    expect(pendingToolTimer('', 60)).toBe('');
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

describe('mcpStartupLine', () => {
  const s = (name: string) => ({ name, command: 'x', args: [] });

  // The common launch: nothing configured, so the pre-session frame stays blank rather than
  // printing a placeholder for work that takes ~100ms.
  it('says nothing when no server is configured', () => {
    expect(mcpStartupLine([])).toBeUndefined();
  });

  it('names the server it is waiting on', () => {
    expect(mcpStartupLine([s('mini')])).toBe('Starting MCP: mini…');
    expect(mcpStartupLine([s('mini'), s('files')])).toBe('Starting MCP: mini, files…');
  });

  // The cap keeps the line a "what am I waiting for" — the full list is /mcp's job — and it is cut
  // from the end so the same launch always prints the same line.
  it('caps the list and counts the rest', () => {
    expect(mcpStartupLine([s('a'), s('b'), s('c')])).toBe('Starting MCP: a, b, c…');
    expect(mcpStartupLine([s('a'), s('b'), s('c'), s('d')])).toBe('Starting MCP: a, b, c +1 more…');
    expect(mcpStartupLine([s('a'), s('b'), s('c'), s('d'), s('e')])).toBe(
      'Starting MCP: a, b, c +2 more…',
    );
  });
});
