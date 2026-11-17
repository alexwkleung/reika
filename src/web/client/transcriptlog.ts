import type { Message } from '../../types.js';
import { groupedReads, hasBlockUnderSummary, type LogItem } from '../../ui/scrollbackrules.js';
import type { WireMessage } from '../protocol.js';

// What the transcript draws, in order: every message plus the "Worked for" line a top-level turn
// ends with, and for each message the neighbour facts its row's spacing and wording depend on. The
// rules are Scrollback.tsx's (useScrollbackLog, MessageView), computed over the whole array rather
// than appended once, since a tab redraws the conversation it is handed.

export type RowContext = {
  // A top-level row after a subagent's block, a row after a notice, or a tool row next to one that
  // carries a block: each takes a gap the tight tool-row stack otherwise lacks.
  gap: boolean;
  // A read row stacked under a sibling keeps its `Read` verb (#627).
  groupedReads: boolean;
};

export type TranscriptItem =
  | { kind: 'message'; key: string; message: WireMessage; ctx: RowContext }
  | { kind: 'worked'; key: string; durationMs: number; interrupted?: boolean };

export type TranscriptLog = {
  items: TranscriptItem[];
  // The last turn's line, drawn only once the session is idle: while busy the busy line holds that
  // place, as the TUI holds it out of the log until the next prompt.
  held: { ms: number; interrupted?: boolean } | null;
};

function endsTurn(m: WireMessage): m is Extract<WireMessage, { role: 'assistant' }> {
  return m.role === 'assistant' && m.durationMs !== undefined && !m.nested;
}

function isNested(m: WireMessage | undefined): boolean {
  return !!m && 'nested' in m && !!m.nested;
}

export function buildTranscriptLog(messages: readonly WireMessage[]): TranscriptLog {
  // A wire message is a Message less its model-only fields, which the rules never read.
  const log: LogItem[] = [];
  const items: TranscriptItem[] = [];
  let held: TranscriptLog['held'] = null;
  messages.forEach((message, i) => {
    if (held !== null && (message.role === 'user' || endsTurn(message))) {
      log.push({ workedMs: held.ms, interrupted: held.interrupted });
      items.push({
        kind: 'worked',
        key: `w${i}`,
        durationMs: held.ms,
        interrupted: held.interrupted,
      });
      held = null;
    }
    const at = log.length;
    const before = log[at - 1];
    const prev = before && !('workedMs' in before) ? (before as WireMessage) : undefined;
    log.push(message as Message);
    const nested = isNested(message);
    const afterNested = !nested && isNested(prev);
    const afterNotice = prev?.role === 'system';
    const afterToolBlock =
      message.role === 'tool' &&
      prev?.role === 'tool' &&
      (hasBlockUnderSummary(prev as Message) || hasBlockUnderSummary(message as Message));
    items.push({
      kind: 'message',
      key: `m${i}`,
      message,
      ctx: {
        gap: afterNested || afterNotice || afterToolBlock,
        groupedReads:
          message.role === 'tool' &&
          groupedReads(message as Message, prev as Message | undefined, log, at),
      },
    });
    if (endsTurn(message)) held = { ms: message.durationMs!, interrupted: message.interrupted };
  });
  return { items, held };
}
