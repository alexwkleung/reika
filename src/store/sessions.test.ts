import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../types.js';
import { serializeJsonl, TRANSCRIPT_VERSION, type TranscriptMeta } from './transcript.js';
import {
  hasRealTurn,
  listSessions,
  loadSession,
  modelHistoryFromScrollback,
  newSessionPath,
  projectHistoryDir,
  writeSession,
} from './sessions.js';

const meta = (savedAt: string, messageCount = 0): TranscriptMeta => ({
  version: TRANSCRIPT_VERSION,
  savedAt,
  model: 'test-model',
  baseURL: 'http://127.0.0.1:1/v1',
  cwd: '/repo/app',
  messageCount,
  mode: 'agent',
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reika-sessions-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('projectHistoryDir', () => {
  it('keeps the basename readable and two same-named checkouts apart', () => {
    const a = projectHistoryDir('/repo/one/app', '/h');
    const b = projectHistoryDir('/repo/two/app', '/h');
    expect(a).toMatch(/^\/h\/projects\/app-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(projectHistoryDir('/repo/one/app', '/h')).toBe(a);
  });
});

describe('writeSession / loadSession', () => {
  it('round-trips both sides of the chat boundary, unredacted', async () => {
    const path = newSessionPath(join(dir, 'p'), new Date('2026-09-22T10:00:00Z'));
    const agent: Message[] = [
      { role: 'user', content: 'read /repo/app/src/a.ts' },
      { role: 'assistant', content: 'done' },
    ];
    const chat: Message[] = [{ role: 'user', content: 'what is a monad' }];
    await writeSession(path, { agent, chat }, meta('2026-09-22T10:00:00Z', 2));

    expect(await loadSession(path)).toEqual({ agent, chat });
    // The rename leaves no temp file behind.
    expect(await readdir(join(dir, 'p'))).toEqual([path.split('/').pop()]);
  });

  it('titles a session spent in chat from the chat side, counting both sides', async () => {
    const path = join(dir, 'chat.jsonl');
    await writeSession(
      path,
      { agent: [], chat: [{ role: 'user', content: 'what is a monad' }] },
      meta('2026-09-22T10:00:00Z'),
    );
    expect(await listSessions(dir)).toMatchObject([{ title: 'what is a monad', messageCount: 1 }]);
  });

  it('reads a /save transcript as the agent side', async () => {
    const path = join(dir, 'manual.jsonl');
    const msgs: Message[] = [{ role: 'user', content: 'hi' }];
    await writeFile(path, serializeJsonl(msgs, meta('2026-09-22T10:00:00Z', 1)));
    expect(await loadSession(path)).toEqual({ agent: msgs, chat: [] });
  });
});

describe('listSessions', () => {
  it('lists newest first with the derived title, skipping files it cannot read', async () => {
    const older = join(dir, 'a.jsonl');
    const newer = join(dir, 'b.jsonl');
    await writeSession(
      older,
      { agent: [{ role: 'user', content: 'first' }], chat: [] },
      meta('2026-09-20T00:00:00Z', 1),
    );
    await writeSession(
      newer,
      { agent: [{ role: 'user', content: 'second' }], chat: [] },
      meta('2026-09-21T00:00:00Z', 1),
    );
    await writeFile(join(dir, 'junk.jsonl'), 'not json\n');
    await writeFile(join(dir, 'notes.txt'), 'ignored');

    const entries = await listSessions(dir);
    expect(entries.map(e => e.title)).toEqual(['second', 'first']);
    expect(entries[0]).toMatchObject({ path: newer, messageCount: 1, model: 'test-model' });
  });

  it('is empty for a directory that does not exist', async () => {
    expect(await listSessions(join(dir, 'nope'))).toEqual([]);
  });
});

describe('modelHistoryFromScrollback', () => {
  it('keeps what the loop sends and drops what only the UI shows', () => {
    const user: Message = { role: 'user', content: 'task' };
    const nudge: Message = { role: 'user', content: 'continue', harness: true };
    const reply: Message = { role: 'assistant', content: 'ok', toolCalls: [] };
    const tool: Message = { role: 'tool', callId: 'c1', summary: 'Read a.ts', payload: 'x' };
    const scroll: Message[] = [
      { role: 'user', content: '/plan', meta: true },
      user,
      { role: 'system', content: 'notice' },
      reply,
      tool,
      { role: 'assistant', content: 'sub', nested: true },
      { role: 'tool', callId: 'c2', summary: 'sub read', nested: true },
      { role: 'assistant', content: 'note', compactionNote: true, nested: true },
      nudge,
      { role: 'shell', command: 'ls', output: 'a' },
      { role: 'error', content: 'boom' },
    ];
    expect(modelHistoryFromScrollback(scroll)).toEqual([user, reply, tool, nudge]);
  });
});

describe('hasRealTurn', () => {
  it('ignores notices and command echoes', () => {
    expect(
      hasRealTurn([
        { role: 'system', content: 'x' },
        { role: 'user', content: '/help', meta: true },
      ]),
    ).toBe(false);
    expect(hasRealTurn([{ role: 'user', content: 'hello' }])).toBe(true);
    expect(hasRealTurn([{ role: 'shell', command: 'ls', output: '' }])).toBe(true);
  });
});
