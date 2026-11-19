import type { LiveTurn } from '../controller.js';
import type { Message } from '../types.js';
import { HIDDEN_TOOL_ARGS } from '../display/format.js';
import { isAnon, scrubIdentity } from '../ui/identity.js';
import { scrubPaths } from '../ui/paths.js';
import { displayCwd, scrubDisplay, scrubOutput } from '../ui/scrub.js';
import type { SuggestionState } from '../ui/suggest.js';
import {
  wireMessage,
  type WireDialog,
  type WireMessage,
  type WireSessionList,
  type WireState,
} from './protocol.js';

// What reaches a browser tab, scrubbed the way the TUI scrubs what it draws (#990): `~/…` for
// $HOME, cwd-relative paths, secrets masked, and under `/anon` the account's name, handle and
// email replaced. Server side, because the page is not sent the identity it would need to hide.
// More than the TUI covers (assistant prose, reasoning, diffs, dialogs), since a page is the front
// end most likely to be screenshotted. Display only: model history and the saved files are never
// touched. Not in protocol.ts, which the page bundles; this needs Node.

// String leaves left raw on purpose: ids and enum values, never text a row draws as prose.
export const UNSCRUBBED_KEYS = [
  'role',
  'callId',
  'id',
  'name',
  'mode',
  'skill',
  'tone',
  'emphasis',
  'discarded',
  'harnessStop',
  'kind',
] as const;

const UNSCRUBBED = new Set<string>(UNSCRUBBED_KEYS);

type Scrub = (s: string) => string;

// Every string under `value`, but for the keys above. A field added to Message later is scrubbed
// by this default rather than sent raw. `keep` is empty for data whose keys are not ours: a tool's
// arguments, where an MCP server may call a path `name` or `id`.
function scrubLeaves(
  value: unknown,
  scrub: Scrub,
  keep: ReadonlySet<string> = UNSCRUBBED,
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(v => scrubLeaves(v, scrub, keep));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = keep.has(k) ? v : scrubLeaves(v, scrub, keep);
  }
  return out;
}

const KEEP_NONE: ReadonlySet<string> = new Set();

// Per line, so a diff's row count and line numbers cannot move.
function perLine(s: string, scrub: Scrub): string {
  return s
    .split('\n')
    .map(line => scrub(line))
    .join('\n');
}

export function scrubMessage(msg: Message, cwd: string): WireMessage {
  const display: Scrub = s => scrubDisplay(s, cwd);
  const output: Scrub = s => scrubOutput(s, cwd);
  const wire = wireMessage(msg) as Record<string, unknown>;
  // Fields taken out here get their own rule; the rest go through the default.
  const own: Record<string, unknown> = {};
  switch (msg.role) {
    case 'user':
      // The expanded content (pastes, `<file>` blocks) is undrawn, and the largest thing here.
      own.content = output(msg.display ?? msg.content);
      delete wire.display;
      break;
    case 'assistant':
      if (msg.planChecks) {
        // `at` indexes the content, and the note after it is never drawn: send the scrubbed prose
        // alone, with `at` at its end.
        const prose = display(msg.content.slice(0, msg.planChecks.at));
        own.content = prose;
        own.planChecks = scrubLeaves({ ...msg.planChecks, at: prose.length }, display);
      }
      if (msg.toolCalls) {
        own.toolCalls = msg.toolCalls.map(tc => {
          const hidden = HIDDEN_TOOL_ARGS[tc.name];
          const args = Object.fromEntries(Object.entries(tc.args).filter(([k]) => !hidden?.has(k)));
          return { id: tc.id, name: tc.name, args: scrubLeaves(args, display, KEEP_NONE) };
        });
      }
      break;
    case 'tool':
      own.summary = output(msg.summary);
      if (msg.command) {
        own.command = {
          ...msg.command,
          text: output(msg.command.text),
          outputTail: output(msg.command.outputTail),
        };
      }
      if (msg.diff) {
        own.diff = {
          ...msg.diff,
          path: display(msg.diff.path),
          text: perLine(msg.diff.text, display),
        };
      }
      if (msg.changes) {
        own.changes = {
          ...msg.changes,
          files: msg.changes.files.map(f => ({
            ...f,
            path: display(f.path),
            hunks: f.hunks.map(h => ({ ...h, text: perLine(h.text, display) })),
          })),
        };
      }
      break;
    case 'shell':
      own.command = output(msg.command);
      own.output = output(msg.output);
      break;
  }
  for (const key of Object.keys(own)) delete wire[key];
  return { ...(scrubLeaves(wire, display) as object), ...own } as WireMessage;
}

export function scrubState(state: WireState): WireState {
  const cwd = state.cwd ?? undefined;
  const display: Scrub = s => scrubDisplay(s, cwd);
  return {
    ...state,
    error: state.error === null ? null : display(state.error),
    cwd: state.cwd === null ? null : displayCwd(state.cwd),
    queue: state.queue.map(q => ({ ...q, content: scrubOutput(q.content, cwd) })),
    // The link carries the owner's handle, and a scrubbed href is a broken one.
    pr: state.pr && isAnon() ? { number: state.pr.number, state: state.pr.state } : state.pr,
  };
}

export function scrubDialog(dialog: WireDialog, cwd: string): WireDialog {
  const display: Scrub = s => scrubDisplay(s, cwd);
  switch (dialog.kind) {
    case 'approval':
      return {
        ...dialog,
        subject: display(dialog.subject),
        // The user must see exactly what they approve, so no secret is masked here.
        preview: perLine(dialog.preview, s => scrubIdentity(scrubPaths(s, cwd))),
        ...(dialog.warnings ? { warnings: dialog.warnings.map(display) } : {}),
      };
    case 'question':
    case 'confirm':
      return scrubLeaves(dialog, display) as WireDialog;
    case 'model':
      // Model names and base URLs, as the TUI's picker shows them.
      return dialog;
    case 'session':
      return { ...dialog, entries: dialog.entries.map(e => scrubLeaves(e, display)) } as WireDialog;
  }
}

export function scrubSessionList(list: WireSessionList, cwd: string): WireSessionList {
  return {
    ...list,
    entries: list.entries.map(e =>
      e.title === undefined ? e : { ...e, title: scrubDisplay(e.title, cwd) },
    ),
  };
}

// The inserted value stays raw: it goes back into the box and is sent again.
export function scrubCompletion(
  completion: SuggestionState | null,
  cwd: string,
): SuggestionState | null {
  if (!completion) return null;
  return {
    ...completion,
    items: completion.items.map(i => ({ ...i, display: scrubDisplay(i.display, cwd) })),
  };
}

export function scrubError(error: string, cwd: string): string {
  return scrubDisplay(error, cwd);
}

// Above this a line with no break is cut at its last space, so one long line cannot make every
// delta rescan it. A path has no space, so the cut cannot split one.
const MAX_PARTIAL_LINE = 4096;

// A streamed channel, scrubbed as it arrives. A delta can end inside a path the scrubber would
// have matched whole, so lines are final only at a break, the line still arriving is rescrubbed
// each time, and its trailing word is held until a space or break ends it: `/Users/al` never
// paints, in a delta or a `live` event, and the last word arrives with the committed message. A
// match that completes changes text already shown, which the delta's `drop` takes back.
// Rules that span a line break (none but a certificate phrase) are an accepted miss.
export type StreamScrubber = {
  readonly raw: string;
  // What every tab shows: the scrubbed text pushed so far, but for a word still held.
  text(): string;
  // What to send for `chunk`, or null when nothing shown changes.
  push(chunk: string): { drop: number; text: string } | null;
  reset(raw?: string): void;
};

export function createStreamScrubber(scrub: Scrub): StreamScrubber {
  let raw = '';
  let finalRawLen = 0;
  let finalText = '';
  // What the tab shows past `finalText`.
  let shownTail = '';

  const boundary = (): number => {
    const nl = raw.lastIndexOf('\n');
    let at = nl >= finalRawLen ? nl + 1 : finalRawLen;
    if (raw.length - at > MAX_PARTIAL_LINE) {
      const space = raw.slice(at).search(/\s\S*$/);
      if (space > 0) at += space + 1;
    }
    return at;
  };

  const partialText = (): string => scrub(raw.slice(finalRawLen).replace(/\S+$/, ''));

  return {
    get raw() {
      return raw;
    },
    text: () => finalText + shownTail,
    push: chunk => {
      raw += chunk;
      const at = boundary();
      const oldFinalLen = finalText.length;
      if (at > finalRawLen) {
        finalText += scrub(raw.slice(finalRawLen, at));
        finalRawLen = at;
      }
      const tail = partialText();
      const target = finalText.slice(oldFinalLen) + tail;
      let common = 0;
      const max = Math.min(target.length, shownTail.length);
      while (common < max && target.charCodeAt(common) === shownTail.charCodeAt(common)) common++;
      const drop = shownTail.length - common;
      const text = target.slice(common);
      shownTail = tail;
      return drop === 0 && text === '' ? null : { drop, text };
    },
    reset: (next = '') => {
      raw = '';
      finalRawLen = 0;
      finalText = '';
      shownTail = '';
      if (next) {
        raw = next;
        const at = boundary();
        finalText = scrub(raw.slice(0, at));
        finalRawLen = at;
        shownTail = partialText();
      }
    },
  };
}

export type LiveChannel = 'content' | 'reasoning' | 'tool';

export function liveChannelText(live: LiveTurn, channel: LiveChannel): string {
  if (channel === 'tool') return live.tool?.output ?? '';
  return live[channel];
}

// The live turn with its streamed text taken from the scrubbers, so a snapshot never rescans a
// multi-megabyte tool output; the rest is small and scrubbed whole.
export function scrubLive(
  live: LiveTurn,
  streamed: Record<LiveChannel, string>,
  cwd: string,
): LiveTurn {
  const display: Scrub = s => scrubDisplay(s, cwd);
  return {
    ...live,
    content: streamed.content,
    reasoning: streamed.reasoning,
    tool: live.tool ? { name: live.tool.name, output: streamed.tool } : null,
    plan: live.plan ? (scrubLeaves(live.plan, display) as LiveTurn['plan']) : null,
  };
}
