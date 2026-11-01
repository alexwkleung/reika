import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, Mode } from '../types.js';
import { serializeJsonl, TRANSCRIPT_VERSION, type TranscriptMeta } from './transcript.js';
import {
  countRealTurns,
  forAutosave,
  listSessions,
  loadSession,
  modelHistoryFromScrollback,
  newSessionPath,
  projectHistoryDir,
  saveHeader,
  writeSession,
} from './sessions.js';

const meta = (savedAt: string, messageCount = 0, mode: Mode = 'agent'): TranscriptMeta => ({
  version: TRANSCRIPT_VERSION,
  savedAt,
  model: 'test-model',
  baseURL: 'http://127.0.0.1:1/v1',
  cwd: '/repo/app',
  messageCount,
  mode,
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
    expect(await listSessions(dir)).toMatchObject([
      { title: 'what is a monad', messageCount: 1, chatTurns: 1 },
    ]);
  });

  it('counts the chat side in the header, since the mode timeline covers the agent side only', async () => {
    const path = join(dir, 'mixed.jsonl');
    await writeSession(
      path,
      {
        agent: [{ role: 'user', content: 'fix the bug', mode: 'agent' }],
        chat: [
          { role: 'user', content: '/model kimi', meta: true },
          { role: 'user', content: 'what is a monad', mode: 'chat' },
          { role: 'assistant', content: 'a monoid in…' },
          { role: 'user', content: 'and a functor', mode: 'chat' },
        ],
      },
      meta('2026-09-22T10:00:00Z'),
    );
    const header = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!) as {
      title?: string;
      chatTurns?: number;
      modes?: unknown[];
    };
    expect(header).toMatchObject({
      title: 'fix the bug',
      chatTurns: 2,
      modes: [{ mode: 'agent', from: 1, to: 1 }],
    });
    expect(await listSessions(dir)).toMatchObject([{ chatTurns: 2 }]);
  });

  it('leaves the count out of a session with no chat side', async () => {
    const path = join(dir, 'agent.jsonl');
    await writeSession(
      path,
      { agent: [{ role: 'user', content: 'fix the bug' }], chat: [] },
      meta('2026-09-22T10:00:00Z'),
    );
    expect((await readFile(path, 'utf8')).split('\n')[0]).not.toContain('chatTurns');
    const [entry] = await listSessions(dir);
    expect(entry).not.toHaveProperty('chatTurns');
  });

  it('reads a /save transcript as the agent side', async () => {
    const path = join(dir, 'manual.jsonl');
    const msgs: Message[] = [{ role: 'user', content: 'hi' }];
    await writeFile(path, serializeJsonl(msgs, meta('2026-09-22T10:00:00Z', 1)));
    expect(await loadSession(path)).toEqual({ agent: msgs, chat: [] });
  });

  it('reads a /save made in chat mode as the chat side, marker or not (#880)', async () => {
    // What /save writes in chat mode before and after the fix: the chat scrollback through the
    // plain transcript serializer, no segment marker, the header's mode the only clue.
    const msgs: Message[] = [
      { role: 'user', content: 'what is a monad', mode: 'chat' },
      { role: 'assistant', content: 'a monoid in…' },
    ];
    const path = join(dir, 'chat-save.jsonl');
    await writeFile(path, serializeJsonl(msgs, meta('2026-09-22T10:00:00Z', 2, 'chat')));
    expect(await loadSession(path)).toEqual({ agent: [], chat: msgs });
  });

  it('keeps an unmarked agent-only auto-save on the agent side when its header says chat', async () => {
    // Shift+Tab into chat adds nothing to the chat side, so the auto-save it triggers has no
    // marker, the agent session's messages, and `mode: "chat"` from the save-time mode.
    const agent: Message[] = [
      { role: 'user', content: 'fix the bug', mode: 'agent' },
      { role: 'assistant', content: 'done' },
    ];
    const path = join(dir, 'shift-tab.jsonl');
    await writeSession(path, { agent, chat: [] }, meta('2026-09-22T10:00:00Z', 2, 'chat'));
    expect(await loadSession(path)).toEqual({ agent, chat: [] });
  });

  it('keeps an unmarked file whose prompts carry no mode on the agent side', async () => {
    const msgs: Message[] = [{ role: 'user', content: 'fix the bug' }];
    const path = join(dir, 'old.jsonl');
    await writeFile(path, serializeJsonl(msgs, meta('2026-09-22T10:00:00Z', 1, 'chat')));
    expect(await loadSession(path)).toEqual({ agent: msgs, chat: [] });
  });

  it('splits on the marker even when the header says chat, since that is just the save-time mode', async () => {
    const agent: Message[] = [{ role: 'user', content: 'fix the bug' }];
    const chat: Message[] = [{ role: 'user', content: 'what is a monad' }];
    const path = join(dir, 'mixed.jsonl');
    await writeSession(path, { agent, chat }, meta('2026-09-22T10:00:00Z', 2, 'chat'));
    expect(await loadSession(path)).toEqual({ agent, chat });
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

  it('reads a header saying chat as a chat in the root only (#882)', async () => {
    // A /save made in chat mode before /save wrote the count: the header's mode is the only clue.
    const msgs: Message[] = [{ role: 'user', content: 'what is a monad', mode: 'chat' }];
    await writeFile(
      join(dir, 'c.jsonl'),
      serializeJsonl(msgs, meta('2026-09-22T10:00:00Z', 1, 'chat')),
    );
    const [root] = await listSessions(dir, true);
    expect(root).toMatchObject({ chat: true });
    expect(root).not.toHaveProperty('chatTurns');
    // In a project dir the same header is an agent-only auto-save taken after Shift+Tab (#880).
    expect(await listSessions(dir)).toEqual([expect.not.objectContaining({ chat: true })]);
  });

  it('marks a counted chat as a chat in any dir', async () => {
    await writeSession(
      join(dir, 'c.jsonl'),
      { agent: [], chat: [{ role: 'user', content: 'what is a monad' }] },
      meta('2026-09-22T10:00:00Z'),
    );
    expect(await listSessions(dir)).toMatchObject([{ chatTurns: 1, chat: true }]);
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

describe('saveHeader', () => {
  const chat: Message[] = [
    { role: 'user', content: 'what is a monad', mode: 'chat' },
    { role: 'assistant', content: 'a monoid in…' },
    { role: 'system', content: 'a notice' },
  ];

  it('counts the chat turns of a chat-mode /save (#882)', () => {
    expect(saveHeader(meta('2026-09-22T10:00:00Z', 3, 'chat'), chat)).toMatchObject({
      chatTurns: 1,
    });
  });

  it('leaves the count out outside chat mode and when nothing was asked', () => {
    expect(saveHeader(meta('2026-09-22T10:00:00Z', 3, 'agent'), chat)).not.toHaveProperty(
      'chatTurns',
    );
    const notices: Message[] = [{ role: 'system', content: 'a notice' }];
    expect(saveHeader(meta('2026-09-22T10:00:00Z', 1, 'chat'), notices)).not.toHaveProperty(
      'chatTurns',
    );
  });
});

describe('countRealTurns', () => {
  it('counts prompts and shell commands, not notices or command echoes', () => {
    expect(
      countRealTurns([
        { role: 'system', content: 'x' },
        { role: 'user', content: '/help', meta: true },
      ]),
    ).toBe(0);
    expect(
      countRealTurns([
        { role: 'user', content: 'hello' },
        { role: 'shell', command: 'ls', output: '' },
      ]),
    ).toBe(2);
  });
});

describe('forAutosave', () => {
  it('drops launch notices and keeps the conversation', () => {
    const kept: Message[] = [
      { role: 'system', content: 'Resumed "x"' },
      { role: 'user', content: 'hello' },
    ];
    const launch: Message = { role: 'system', content: 'Session summary', skipAutosave: true };
    expect(forAutosave([launch, ...kept])).toEqual(kept);
  });
});
