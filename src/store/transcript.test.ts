import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../types.js';
import {
  TRANSCRIPT_VERSION,
  formatModeRuns,
  formatUsageHeader,
  renderTxt,
  saveTranscript,
  serializeJsonl,
  summarizeModes,
  type TranscriptMeta,
  type TranscriptUsage,
} from './transcript.js';

const META: TranscriptMeta = {
  version: TRANSCRIPT_VERSION,
  savedAt: '2026-06-28T14:03:12.000Z',
  model: 'qwen2.5-coder',
  baseURL: 'http://localhost:11434/v1',
  cwd: '/repo',
  messageCount: 0,
  mode: 'agent',
};

// One of every variant, so a renderer change that forgets a role is caught.
const ALL_ROLES: Message[] = [
  { role: 'header', model: 'qwen', cwd: '/repo' },
  { role: 'user', content: 'hi', display: 'hi' },
  {
    role: 'assistant',
    content: 'done',
    reasoning: 'let me think',
    toolCalls: [{ id: 't1', name: 'read', args: { path: 'a.ts' } }],
    sources: ['https://example.com'],
    durationMs: 12000,
  },
  {
    role: 'tool',
    callId: 't1',
    summary: 'Read a.ts (40 lines)',
    payload: 'the full file contents',
    payloadId: 'abc123',
    command: { text: 'ls', outputTail: 'a.ts', outputTruncated: false },
  },
  { role: 'shell', command: 'pwd', output: '/repo' },
  { role: 'system', content: 'cwd is now /repo', tone: 'info' },
  { role: 'error', content: 'boom' },
  { role: 'compaction', content: 'recap of earlier turns' },
];

describe('serializeJsonl', () => {
  it('writes a meta header line then one JSON object per message', () => {
    const lines = serializeJsonl(ALL_ROLES, META).trimEnd().split('\n');
    expect(lines.length).toBe(ALL_ROLES.length + 1);
    const meta = JSON.parse(lines[0]) as TranscriptMeta;
    expect(meta.version).toBe(TRANSCRIPT_VERSION);
    expect(meta.model).toBe('qwen2.5-coder');
  });

  it('round-trips every message line back to a parseable object', () => {
    const lines = serializeJsonl(ALL_ROLES, META).trimEnd().split('\n').slice(1);
    const parsed = lines.map(l => JSON.parse(l) as Message);
    expect(parsed.map(m => m.role)).toEqual(ALL_ROLES.map(m => m.role));
  });

  it('keeps full tool payloads (losslessness vs the TUI summary)', () => {
    const tool = serializeJsonl([ALL_ROLES[3]], META).trimEnd().split('\n')[1];
    expect(JSON.parse(tool).payload).toBe('the full file contents');
  });

  it('redacts secrets by default', () => {
    const msg: Message = {
      role: 'tool',
      callId: 't1',
      summary: 'ran',
      command: {
        text: 'notarytool --apple-id me@x.com',
        outputTail: 'appleId=me@x.com',
        outputTruncated: false,
      },
    };
    const out = serializeJsonl([msg], META);
    expect(out).not.toContain('me@x.com');
    expect(out).toContain('<redacted>');
  });

  it('preserves secrets verbatim when redact:false', () => {
    const msg: Message = { role: 'user', content: 'appleId=me@x.com' };
    expect(serializeJsonl([msg], META, { redact: false })).toContain('me@x.com');
  });
});

// A saved transcript is the artifact that actually gets shared, so it must scrub paths at least
// as hard as the scrollback does.
describe('transcript path scrubbing', () => {
  const HOME = homedir();

  it('collapses the cwd prefix in message bodies', () => {
    const msg: Message = { role: 'system', content: 'wrote /repo/src/a.ts' };
    expect(renderTxt([msg], META)).toContain('wrote src/a.ts');
  });

  it('collapses the home prefix in message bodies', () => {
    const msg: Message = { role: 'error', content: `ENOENT: ${HOME}/notes/x.md` };
    const txt = renderTxt([msg], META);
    expect(txt).toContain('~/notes/x.md');
    expect(txt).not.toContain(HOME);
  });

  it('scrubs shell commands and output', () => {
    const msg: Message = { role: 'shell', command: `ls ${HOME}/x`, output: `${HOME}/x/y.ts` };
    const out = serializeJsonl([msg], META);
    expect(out).not.toContain(HOME);
    expect(out).toContain('~/x');
  });

  it('scrubs tool-call args and payloads', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', args: { path: '/repo/src/deep.ts' } }],
    };
    expect(serializeJsonl([msg], META)).toContain('src/deep.ts');
    expect(serializeJsonl([msg], META)).not.toContain('/repo/src/deep.ts');
  });

  it('collapses the header cwd to a home-relative form', () => {
    const msg: Message = { role: 'header', model: 'qwen', cwd: `${HOME}/Git/proj` };
    const out = serializeJsonl([msg], META);
    expect(out).not.toContain(HOME);
    expect(out).toContain('~/Git/proj');
  });

  it('collapses the meta cwd in both formats without emptying it', () => {
    const meta = { ...META, cwd: `${HOME}/Git/proj` };
    expect(renderTxt([], meta)).toContain('# cwd:      ~/Git/proj');
    expect(JSON.parse(serializeJsonl([], meta).split('\n')[0]).cwd).toBe('~/Git/proj');
  });

  it('leaves paths verbatim when redact:false', () => {
    const msg: Message = { role: 'system', content: '/repo/src/a.ts' };
    const meta = { ...META, cwd: `${HOME}/Git/proj` };
    expect(renderTxt([msg], meta, { redact: false })).toContain('/repo/src/a.ts');
    expect(renderTxt([msg], meta, { redact: false })).toContain(`# cwd:      ${HOME}/Git/proj`);
  });

  it('still redacts secrets when a path sits alongside one', () => {
    const msg: Message = { role: 'system', content: '/repo/build: appleId=me@x.com' };
    const txt = renderTxt([msg], META);
    expect(txt).toContain('build: appleId=<redacted>');
    expect(txt).not.toContain('/repo/build');
  });
});

describe('renderTxt', () => {
  it('renders every role without throwing and labels the turns', () => {
    const txt = renderTxt(ALL_ROLES, META);
    expect(txt).toContain('# reika transcript');
    expect(txt).toContain('You:');
    expect(txt).toContain('Reika:');
    expect(txt).toContain('Thinking:');
    expect(txt).toContain('⏺︎ Read(path="a.ts")');
    expect(txt).toContain('↳ Read a.ts');
    expect(txt).toContain('System:');
    expect(txt).toContain('Error:');
    expect(txt).toContain('Sources: https://example.com');
  });

  it('redacts secrets by default and honors redact:false', () => {
    const msg: Message = { role: 'system', content: 'appleId=me@x.com' };
    expect(renderTxt([msg], META)).not.toContain('me@x.com');
    expect(renderTxt([msg], META, { redact: false })).toContain('me@x.com');
  });
});

// A session that starts in agent mode, drops to shell, plans, then implements — the arc the mode
// timeline exists to record.
const MIXED_MODES: Message[] = [
  { role: 'user', content: 'fix the parser', mode: 'agent' },
  { role: 'assistant', content: 'on it' },
  { role: 'user', content: 'and the tests', mode: 'agent' },
  { role: 'shell', command: 'npm test', output: '2 failed' },
  { role: 'user', content: '/plan', meta: true },
  { role: 'user', content: 'plan the rewrite', mode: 'plan' },
  { role: 'user', content: 'do it', mode: 'agent' },
];

describe('summarizeModes', () => {
  it('collapses consecutive turns in the same mode into runs, in order', () => {
    expect(summarizeModes(MIXED_MODES)).toEqual([
      { mode: 'agent', from: 1, to: 2 },
      { mode: 'shell', from: 3, to: 3 },
      { mode: 'plan', from: 4, to: 4 },
      { mode: 'agent', from: 5, to: 5 },
    ]);
  });

  it('does not count command echoes as turns', () => {
    // The `/plan` echo sits between turns 3 and 4; counting it would push every later turn
    // number out by one and attribute plan mode to the wrong prompt.
    const runs = summarizeModes(MIXED_MODES);
    expect(runs.find(r => r.mode === 'plan')).toEqual({ mode: 'plan', from: 4, to: 4 });
  });

  it('skips untagged turns instead of guessing, and does not merge across the gap', () => {
    const runs = summarizeModes([
      { role: 'user', content: 'a', mode: 'agent' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c', mode: 'agent' },
    ]);
    expect(runs).toEqual([
      { mode: 'agent', from: 1, to: 1 },
      { mode: 'agent', from: 3, to: 3 },
    ]);
  });

  it('records nothing for a conversation with no turns', () => {
    expect(summarizeModes([{ role: 'system', content: 'New session' }])).toEqual([]);
  });
});

describe('formatModeRuns', () => {
  it('renders the arc with singular and ranged turn numbers', () => {
    expect(formatModeRuns(summarizeModes(MIXED_MODES))).toBe(
      'agent (turns 1-2) → shell (turn 3) → plan (turn 4) → agent (turn 5)',
    );
  });

  it('says so when nothing was recorded', () => {
    expect(formatModeRuns([])).toBe('(none recorded)');
  });
});

describe('mode in the saved record', () => {
  it('puts the save-time mode and the derived timeline in the jsonl meta line', () => {
    const meta = JSON.parse(serializeJsonl(MIXED_MODES, { ...META, mode: 'plan' }).split('\n')[0]);
    expect(meta.mode).toBe('plan');
    expect(meta.modes).toEqual(summarizeModes(MIXED_MODES));
  });

  it('keeps each turn tagged in the jsonl so a reader never has to count', () => {
    const lines = serializeJsonl(MIXED_MODES, META).trimEnd().split('\n').slice(1);
    const parsed = lines.map(l => JSON.parse(l) as Message);
    expect(parsed.filter(m => m.role === 'user').map(m => (m as { mode?: string }).mode)).toEqual([
      'agent',
      'agent',
      undefined,
      'plan',
      'agent',
    ]);
  });

  it('headers the txt with the save-time mode and the arc', () => {
    const txt = renderTxt(MIXED_MODES, { ...META, mode: 'plan' });
    expect(txt).toContain('# mode:     plan (at save)');
    expect(txt).toContain(`# modes:    ${formatModeRuns(summarizeModes(MIXED_MODES))}`);
  });

  it('labels each txt turn with its own mode, and leaves untagged ones bare', () => {
    const txt = renderTxt(MIXED_MODES, META);
    expect(txt).toContain('You [agent]:');
    expect(txt).toContain('You [plan]:');
    // The `/plan` echo ran between turns — it has no mode of its own to claim.
    expect(txt).toContain('You:\n  /plan');
  });
});

describe('saveTranscript', () => {
  it('writes a .jsonl and a .txt with the same base name and returns both paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reika-transcript-'));
    const { jsonlPath, txtPath } = await saveTranscript(dir, ALL_ROLES, META);
    expect(jsonlPath.endsWith('.jsonl')).toBe(true);
    expect(txtPath.endsWith('.txt')).toBe(true);
    expect(jsonlPath.slice(0, -6)).toBe(txtPath.slice(0, -4));
    const files = await readdir(dir);
    expect(files.length).toBe(2);
    const jsonl = await readFile(jsonlPath, 'utf8');
    expect(JSON.parse(jsonl.split('\n')[0]).version).toBe(TRANSCRIPT_VERSION);
    expect(await readFile(txtPath, 'utf8')).toContain('# reika transcript');
  });

  it('creates the history directory if it does not exist', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'reika-transcript-')), 'nested', 'history');
    const { jsonlPath } = await saveTranscript(dir, ALL_ROLES, META);
    expect(await readFile(jsonlPath, 'utf8')).toContain('"role"');
  });
});

// The status line's numbers, carried into the file so a shared transcript doesn't need the footer
// pasted next to it (#199).
describe('usage in the saved record', () => {
  const USAGE: TranscriptUsage = {
    turns: 7,
    promptTokens: 1_250_900,
    completionTokens: 34_100,
    cachedTokens: 900_000,
    contextTokens: 45_000,
    contextWindow: 128_000,
    lastCachedTokens: 40_000,
  };

  it('renders turns, sent/received, ctx and cache in the .txt header', () => {
    const txt = renderTxt([], { ...META, usage: USAGE });
    expect(txt).toContain('# turns:    7');
    expect(txt).toContain('# tokens:   1.3M↑ 34k↓ (session total, 900k from cache)');
    expect(txt).toContain('# ctx:      45k/128k (35%)');
    expect(txt).toContain('# cache:    89% of the last prompt (40k)');
  });

  it('carries the raw counts in the JSONL meta line', () => {
    const meta = JSON.parse(serializeJsonl([], { ...META, usage: USAGE }).split('\n')[0]);
    expect(meta.usage).toEqual(USAGE);
  });

  it('omits the whole block when the caller tracked no usage', () => {
    const txt = renderTxt([], META);
    expect(txt).not.toContain('# turns:');
    expect(txt).not.toContain('# tokens:');
    expect(txt).not.toContain('# ctx:');
    expect(JSON.parse(serializeJsonl([], META).split('\n')[0]).usage).toBeUndefined();
  });

  it('drops the ctx and cache lines before the first call, keeping the counts', () => {
    const lines = formatUsageHeader({ turns: 0, promptTokens: 0, completionTokens: 0 });
    expect(lines).toEqual(['# turns:    0', '# tokens:   0↑ 0↓ (session total)']);
  });

  // A provider that reports no cache hits must leave the fields undefined rather than report 0%,
  // so "cache 0%" always means a real cold prompt.
  it('omits the cache figures when the provider reported none', () => {
    const lines = formatUsageHeader({
      turns: 2,
      promptTokens: 8000,
      completionTokens: 400,
      contextTokens: 8000,
      contextWindow: 32_000,
    });
    expect(lines.join('\n')).not.toContain('cache');
    expect(lines).toContain('# ctx:      8.0k/32k (25%)');
  });

  it('shows the bare context size when the window is unknown, and flags an estimate', () => {
    const lines = formatUsageHeader({
      turns: 1,
      promptTokens: 0,
      completionTokens: 0,
      contextTokens: 12_000,
      contextEstimated: true,
    });
    expect(lines).toContain('# ctx:      12k (estimated)');
  });

  it('flags an estimate alongside the fill when the window is known', () => {
    const lines = formatUsageHeader({
      turns: 1,
      promptTokens: 0,
      completionTokens: 0,
      contextTokens: 16_000,
      contextWindow: 32_000,
      contextEstimated: true,
    });
    expect(lines).toContain('# ctx:      16k/32k (50%, estimated)');
  });
});
