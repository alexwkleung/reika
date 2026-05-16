import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const MENTION_RE = /(?:^|\s)@(\S+)/g;
const MAX_MENTION_BYTES = 50_000;

export type MentionExpansion = {
  augmented: string;
  display: string;
  found: string[];
};

export async function expandMentions(input: string, cwd: string): Promise<MentionExpansion> {
  const mentions = collectMentions(input);
  if (mentions.length === 0) return { augmented: input, display: input, found: [] };

  const blocks: string[] = [];
  const found: string[] = [];
  for (const mention of mentions) {
    const expanded = expandHome(mention);
    const full = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    try {
      const raw = await readFile(full, 'utf8');
      const truncated =
        raw.length > MAX_MENTION_BYTES
          ? raw.slice(0, MAX_MENTION_BYTES) + `\n…(truncated, ${raw.length - MAX_MENTION_BYTES} more bytes)`
          : raw;
      blocks.push(`<file path="${mention}">\n${truncated}\n</file>`);
      found.push(mention);
    } catch {
      // unreadable mention — silently skip; user can correct or notice missing context
    }
  }

  if (blocks.length === 0) return { augmented: input, display: input, found: [] };
  const augmented = `${blocks.join('\n\n')}\n\n${input}`;
  return { augmented, display: input, found };
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function collectMentions(input: string): string[] {
  const out: string[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(input)) !== null) {
    out.push(m[1]);
  }
  return out;
}
