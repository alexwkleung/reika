import type { Message } from '../types.js';

type AssistantMessage = Extract<Message, { role: 'assistant' }>;

// The endpoint's reasoning parser ends the thinking channel at the first literal think tag it sees
// in the stream — including one the model wrote *inside* its own reasoning, e.g. while quoting
// `--reasoning-format`, or describing this very bug. The parser consumes the tag, ends
// `reasoning_content` there and routes the rest of the thought to `content`, so scrollback and the
// saved transcript show the tail of the thinking as if it were the reply (sighted 20 times across
// three sessions, every one of them the model writing a tag in prose).
//
// The exact split can't be recovered — the tag bytes are gone — but the BOUNDARY is unambiguous
// when the cut lands inside a run it left open: an inline code span or a quoted string. The
// reasoning's last line then carries an ODD count of that delimiter (runs never cross a newline)
// and the content opens by closing it — `` ` `` then `` ` ``, or `'` then `'`. Checked against
// every saved session: 20 rounds match, all genuine splits, and no legitimate round does. The even
// case the rule excludes is the one it must: a closed run followed by a fresh one (`…reads \`foo\`.`
// then `` \`bar\` is… ``), which is an ordinary reply. A `'` whose predecessor is a letter is an
// apostrophe in a contraction ("don't"), not an open quote, and is skipped for the same reason.
//
// Display/transcript only. The fold changes what scrollback and /save render, never the Message the
// loop keeps, sends back, or writes to the session history (/resume reads that one into context, so
// folding there would edit the request — see store/sessions.ts). The consumed tag is not restored:
// the tail is simply carried back into the thinking block it came from.
const RUN_DELIMITERS = ['`', "'", '"'] as const;

function countChar(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n++;
  return n;
}

export function foldSpilledReasoning(
  reasoning: string | undefined,
  content: string | undefined,
): { reasoning: string; content: string } {
  const r = reasoning ?? '';
  const c = content ?? '';
  const lastLine = r.slice(r.lastIndexOf('\n') + 1);
  const opens = c.trimStart();
  for (const d of RUN_DELIMITERS) {
    if (!opens.startsWith(d) || countChar(lastLine, d) % 2 === 0) continue;
    if (d === "'") {
      const j = lastLine.lastIndexOf("'");
      if (j > 0 && /\p{L}/u.test(lastLine[j - 1])) continue;
    }
    return { reasoning: r + c, content: '' };
  }
  return { reasoning: r, content: c };
}

// The same fold for a whole assistant message, applying to `reasoning`/`content` only. Split out so
// the render sites (Scrollback, store/transcript) fold identically instead of each re-deriving the
// guard. Returns the fields rather than a Message: callers keep their own object identity, which
// Scrollback's append-only <Static> log keys on.
export function foldedAssistantFields(msg: AssistantMessage): {
  reasoning?: string;
  content: string;
} {
  const folded = foldSpilledReasoning(msg.reasoning, msg.content);
  return {
    ...(folded.reasoning ? { reasoning: folded.reasoning } : {}),
    content: folded.content,
  };
}
