import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../types.js';
import {
  TRANSCRIPT_VERSION,
  renderTxt,
  saveTranscript,
  serializeJsonl,
  type TranscriptMeta,
} from './transcript.js';

const META: TranscriptMeta = {
  version: TRANSCRIPT_VERSION,
  savedAt: '2026-06-28T14:03:12.000Z',
  model: 'qwen2.5-coder',
  baseURL: 'http://localhost:11434/v1',
  cwd: '/Users/alex/Git/reika',
  messageCount: 0,
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

describe('renderTxt', () => {
  it('renders every role without throwing and labels the turns', () => {
    const txt = renderTxt(ALL_ROLES, META);
    expect(txt).toContain('# reika transcript');
    expect(txt).toContain('You:');
    expect(txt).toContain('Reika:');
    expect(txt).toContain('Thinking:');
    expect(txt).toContain('• Read(path="a.ts")');
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
