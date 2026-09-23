import { createHash, randomBytes } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { Message } from '../types.js';
import { deriveTitle, serializeJsonl, type TranscriptMeta } from './transcript.js';

// Session persistence and /resume (#1). An auto-save is the same canonical .jsonl /save writes
// (meta line, one message per line), written unredacted — it is a local resume source, and a
// resumed session reading `~/…` where it once read an absolute path would send the model hunting
// for files that don't exist — with no .txt beside it (that is the shareable artifact, and /save
// still makes one on request).

// Manual /save output. /resume root lists it; /resume falls back to it when a project has none.
export const ROOT_HISTORY_DIR = join(homedir(), '.config', 'reika', 'history');

// One directory per project, keyed on the cwd: the basename keeps it readable in a listing, the
// hash keeps two checkouts both called `app` apart. Under the root rather than inside the repo, so
// an auto-save never shows up in anybody's `git status`.
export function projectHistoryDir(cwd: string, root = ROOT_HISTORY_DIR): string {
  const slug = basename(cwd).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  return join(root, 'projects', `${slug}-${hash}`);
}

// Fixed for the life of the session: every auto-save rewrites this one file, so a session is one
// entry in the /resume list rather than one per save.
export function newSessionPath(dir: string, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return join(dir, `${stamp}-${randomBytes(3).toString('hex')}.jsonl`);
}

// Chat mode keeps its own history (see the mode table in AGENTS.md), so a file carries both sides:
// the agent side's messages, then this marker, then the chat side's. Absent when chat was never
// used, which leaves the file readable as an ordinary transcript.
const CHAT_SEGMENT = { segment: 'chat' };

export type SessionSides = { agent: Message[]; chat: Message[] };

export function serializeSession(sides: SessionSides, meta: TranscriptMeta): string {
  const count = { ...meta, messageCount: sides.agent.length + sides.chat.length };
  const body = serializeJsonl(sides.agent, count, { redact: false });
  if (sides.chat.length === 0) return body;
  // The header's title is derived from the agent side; a session spent in chat takes the chat's.
  const nl = body.indexOf('\n');
  const header = JSON.parse(body.slice(0, nl)) as { title?: string };
  const chatTitle = header.title === undefined ? deriveTitle(sides.chat) : undefined;
  const head =
    chatTitle === undefined ? body.slice(0, nl) : JSON.stringify({ ...header, title: chatTitle });
  const chat = sides.chat.map(m => JSON.stringify(m)).join('\n');
  return `${head}${body.slice(nl)}${JSON.stringify(CHAT_SEGMENT)}\n${chat}\n`;
}

// Written whole each time rather than appended: `messages` is not append-only (a chat round trip
// swaps it, /new replaces it), and a session is small next to the cost of getting an append log's
// replay rules right. The rename makes each write atomic, so a kill mid-write leaves the previous
// save rather than half a file.
export async function writeSession(
  path: string,
  sides: SessionSides,
  meta: TranscriptMeta,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, serializeSession(sides, meta), 'utf8');
  await rename(tmp, path);
}

export type SessionEntry = {
  path: string;
  title?: string;
  savedAt: string;
  messageCount: number;
  model?: string;
};

// Newest first. Only the header line is read — a session with its tool payloads can run to
// megabytes, and the list needs a title and a date. Unreadable or foreign files are skipped: a
// listing is never an error.
export async function listSessions(dir: string): Promise<SessionEntry[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(n => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const entries: SessionEntry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const meta = await readHeader(path);
    if (!meta || typeof meta.savedAt !== 'string') continue;
    entries.push({
      path,
      ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
      savedAt: meta.savedAt,
      messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : 0,
      ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
    });
  }
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

const HEADER_READ_BYTES = 64 * 1024;

async function readHeader(path: string): Promise<Record<string, unknown> | null> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(HEADER_READ_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const nl = text.indexOf('\n');
      const parsed: unknown = JSON.parse(nl === -1 ? text : text.slice(0, nl));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export async function loadSession(path: string): Promise<SessionSides> {
  const lines = (await readFile(path, 'utf8')).split('\n').filter(l => l.trim().length > 0);
  const sides: SessionSides = { agent: [], chat: [] };
  let side: Message[] = sides.agent;
  // Line 0 is the meta header.
  for (const line of lines.slice(1)) {
    const rec = JSON.parse(line) as Message | typeof CHAT_SEGMENT;
    if ('segment' in rec) {
      side = sides.chat;
      continue;
    }
    side.push(rec);
  }
  return sides;
}

// The model-facing history a resumed session continues from, rebuilt from its scrollback: what
// the loop pushes to history, minus what only the UI sees (command echoes, notices, subagent
// rows, compaction notes, shell-mode output). Folds are not restored — the scrollback keeps every
// message a fold removed — so a long session re-compacts on its first turn, which costs one fold
// against a cache that is cold on resume anyway.
export function modelHistoryFromScrollback(messages: Message[]): Message[] {
  return messages.filter(m => {
    switch (m.role) {
      case 'user':
        return !m.meta;
      case 'assistant':
        return !m.nested && !m.compactionNote;
      case 'tool':
        return !m.nested;
      default:
        return false;
    }
  });
}

// Real prompts and shell commands — what makes a scrollback worth a file, as opposed to the
// splash notices or a /resume that was opened and left.
export function countRealTurns(messages: Message[]): number {
  return messages.filter(m => (m.role === 'user' && !m.meta) || m.role === 'shell').length;
}

export function forAutosave(messages: Message[]): Message[] {
  return messages.filter(m => !(m.role === 'system' && m.skipAutosave));
}
