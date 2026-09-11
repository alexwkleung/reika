import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Message, Mode, ToolCall } from '../types.js';
import { scrubDisplay } from '../ui/scrub.js';
import { contextFill, formatDurationMs, kFormat } from '../ui/format.js';

// Bump when the on-disk shape changes incompatibly. The meta record carries this so a future
// persistent-sessions loader (which will append message records the same way) can migrate old
// files instead of choking on them. Start at 1; never reuse a number.
export const TRANSCRIPT_VERSION = 1;

// The status line's numbers at the moment of the save (issue #199): what the session sent and
// received, how full the context window was, how much of the last prompt the provider served from
// cache, and how many model turns it took. Recorded so a saved transcript answers "how big did
// this get?" on its own, instead of needing the status line pasted alongside it.
//
// Optional as a whole, and optional field-by-field within: a transcript saved before the first
// call has counts of zero and no context size, and a provider that never reports cache hits leaves
// the cache fields undefined rather than reporting a false 0%.
export type TranscriptUsage = {
  // Model turns — the status line's `turn N`, counted the same way (assistant messages).
  turns: number;
  // Session totals across every call, the status line's `↑`/`↓` pair.
  promptTokens: number;
  completionTokens: number;
  // Session total of prompt tokens served from the provider's cache.
  cachedTokens?: number;
  // Current context size: the last call's prompt tokens, or the pre-send estimate when no call has
  // landed yet. `contextEstimated` says which, because the difference matters when the file is
  // being read as debugging evidence.
  contextTokens?: number | null;
  contextEstimated?: boolean;
  contextWindow?: number;
  // The shed ceiling the status line measured its percent against (absent in older files, where
  // the percent was of the raw window).
  contextUsable?: number;
  // The last call's cached prompt tokens — the numerator behind the status line's `cache N%`.
  lastCachedTokens?: number;
};

export type TranscriptMeta = {
  version: number;
  // ISO-8601. Stamped by the caller (Date.now() is unavailable here in some contexts and keeps
  // this module pure/testable), not derived internally.
  savedAt: string;
  model: string;
  baseURL: string;
  cwd: string;
  messageCount: number;
  // Mode the session was in when it was saved. The per-turn history is derived, not passed:
  // `modes` below is computed from the messages themselves so the two can never disagree.
  mode: Mode;
  // Token/context/cache/turn accounting at save time. Absent from transcripts written before #199
  // and from callers that don't track usage.
  usage?: TranscriptUsage;
};

// One unbroken run of turns in the same mode. `from`/`to` are inclusive 1-based turn numbers over
// the transcript's model turns and shell commands (the things that count as a turn), so a reader
// can say "turns 4–6 were plan turns" without walking the messages.
export type ModeRun = { mode: Mode; from: number; to: number };

// What the serializers write alongside the caller's meta: the mode timeline, derived here so the
// .jsonl header and the .txt header are the same record.
type FullMeta = TranscriptMeta & { modes: ModeRun[] };

// Collapse the per-turn modes into consecutive runs, in order. A user message carries the mode its
// turn ran in (stamped by the UI; command echoes are skipped — they sit between turns and would
// otherwise attribute a mode switch to the turn before it), and every shell command is a shell
// turn by definition. Untagged turns — from a transcript saved before turns were stamped, or a
// nested subagent's — are skipped rather than guessed at.
export function summarizeModes(messages: Message[]): ModeRun[] {
  const runs: ModeRun[] = [];
  let turn = 0;
  for (const msg of messages) {
    let mode: Mode | undefined;
    if (msg.role === 'user' && !msg.meta) {
      turn += 1;
      mode = msg.mode;
    } else if (msg.role === 'shell') {
      turn += 1;
      mode = 'shell';
    } else continue;
    if (mode === undefined) continue;
    const last = runs[runs.length - 1];
    if (last && last.mode === mode && last.to === turn - 1) last.to = turn;
    else runs.push({ mode, from: turn, to: turn });
  }
  return runs;
}

// The usage block as .txt header lines, in the status line's own order: turns, sent/received,
// context, cache. Only what's actually known is emitted — a session with no call yet gets the
// counts and nothing else, and a provider that reports no cache hits gets no cache line, so an
// absent number reads as "not reported" rather than as zero.
export function formatUsageHeader(usage: TranscriptUsage): string[] {
  const lines = [`# turns:    ${usage.turns}`];
  const cachedTotal =
    usage.cachedTokens != null ? `, ${kFormat(usage.cachedTokens)} from cache` : '';
  lines.push(
    `# tokens:   ${kFormat(usage.promptTokens)}↑ ${kFormat(usage.completionTokens)}↓ (session total${cachedTotal})`,
  );
  const ctx = usage.contextTokens;
  if (ctx != null && ctx > 0) {
    const fill = contextFill(ctx, usage.contextUsable ?? usage.contextWindow);
    const pct = fill != null ? `${Math.round(fill * 100)}%` : null;
    const notes = [
      ...(pct != null
        ? [usage.contextUsable ? `${pct} of ${kFormat(usage.contextUsable)}` : pct]
        : []),
      ...(usage.contextEstimated ? ['estimated'] : []),
    ];
    const size = fill != null ? `${kFormat(ctx)}/${kFormat(usage.contextWindow!)}` : kFormat(ctx);
    lines.push(`# ctx:      ${size}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`);
    if (usage.lastCachedTokens != null) {
      const pct = Math.round((usage.lastCachedTokens / ctx) * 100);
      lines.push(`# cache:    ${pct}% of the last prompt (${kFormat(usage.lastCachedTokens)})`);
    }
  }
  return lines;
}

// `agent (turns 1-3) → plan (turn 4)`. One line, for the .txt header.
export function formatModeRuns(runs: ModeRun[]): string {
  if (runs.length === 0) return '(none recorded)';
  return runs
    .map(r => `${r.mode} (${r.from === r.to ? `turn ${r.from}` : `turns ${r.from}-${r.to}`})`)
    .join(' → ');
}

function withModes(messages: Message[], meta: TranscriptMeta): FullMeta {
  return { ...meta, modes: summarizeModes(messages) };
}

type SerializeOptions = {
  // Run string fields through the secret redactor AND the path scrubber before writing. Default
  // true; the /save --raw escape hatch passes false for a verbatim copy. Applies to both formats
  // identically so the JSONL and the .txt never disagree about what was scrubbed.
  //
  // Paths are scrubbed here for the same reason the TUI scrubs them, only more so: a saved
  // transcript is the artifact that actually gets shared, where scrollback is the one that
  // doesn't. Leaving `/Users/<name>/…` in the file while scrubbing it on screen had it backwards.
  redact?: boolean;
};

// Canonical format: a meta header line, then one JSON object per message. One-record-per-line is
// what persistent sessions will append to incrementally (crash-safe, no rewrite), and it
// round-trips back to Message[] via JSON.parse on each line. Full tool payloads are kept here
// (unlike the .txt and the TUI, which only show summaries) so the record is structurally complete.
//
// "Lossless" only under `redact: false` — the default scrubs secrets and rewrites absolute paths,
// so a reloaded session would see `~/…` where it once saw `/Users/<name>/…`. That was already true
// of secret redaction; --raw remains the verbatim path for anything that must round-trip exactly.
export function serializeJsonl(
  messages: Message[],
  meta: TranscriptMeta,
  opts: SerializeOptions = {},
): string {
  const redact = opts.redact !== false;
  const lines = [JSON.stringify(withModes(messages, redact ? scrubMeta(meta) : meta))];
  for (const msg of messages) {
    lines.push(JSON.stringify(redact ? redactMessage(msg, meta.cwd) : msg));
  }
  return lines.join('\n') + '\n';
}

// Human-readable transcript for copy/paste into a doc. Mirrors what the TUI scrollback renders —
// labelled turns, reasoning, tool-call headers, diffs and command output — rather than the full
// payloads (those live in the JSONL). Plain text only: no ANSI, no Ink.
export function renderTxt(
  messages: Message[],
  meta: TranscriptMeta,
  opts: SerializeOptions = {},
): string {
  const redact = opts.redact !== false;
  const shownCwd = redact ? scrubMeta(meta).cwd : meta.cwd;
  const out: string[] = [
    '# reika transcript',
    `# saved:    ${meta.savedAt}`,
    `# model:    ${meta.model}`,
    `# base:     ${meta.baseURL}`,
    `# cwd:      ${shownCwd}`,
    `# messages: ${meta.messageCount}`,
    // The status line's numbers, when the caller tracked them.
    ...(meta.usage ? formatUsageHeader(meta.usage) : []),
    `# mode:     ${meta.mode} (at save)`,
    // The whole arc up front, so a reader knows what kind of session this was before reading it;
    // each turn below repeats its own mode in the `You [mode]:` label.
    `# modes:    ${formatModeRuns(summarizeModes(messages))}`,
    `# version:  ${meta.version}`,
    '='.repeat(72),
  ];
  for (const raw of messages) {
    const msg = redact ? redactMessage(raw, meta.cwd) : raw;
    const block = renderMessageTxt(msg);
    if (block !== null) out.push('', block);
  }
  return out.join('\n') + '\n';
}

export type SavedTranscript = { jsonlPath: string; txtPath: string };

// Write both the canonical .jsonl and the human .txt into `dir`, creating it if absent. Returns
// the two paths so the caller can surface them in scrollback. The base name is the (filesystem-
// safe) save timestamp plus a short random suffix, so two saves in the same second don't collide.
export async function saveTranscript(
  dir: string,
  messages: Message[],
  meta: TranscriptMeta,
  opts: SerializeOptions = {},
): Promise<SavedTranscript> {
  await mkdir(dir, { recursive: true });
  const stamp = meta.savedAt.replace(/[:.]/g, '-');
  const base = `${stamp}-${randomBytes(3).toString('hex')}`;
  const jsonlPath = join(dir, `${base}.jsonl`);
  const txtPath = join(dir, `${base}.txt`);
  await writeFile(jsonlPath, serializeJsonl(messages, meta, opts), 'utf8');
  await writeFile(txtPath, renderTxt(messages, meta, opts), 'utf8');
  return { jsonlPath, txtPath };
}

function renderMessageTxt(msg: Message): string | null {
  switch (msg.role) {
    case 'header':
      return `── ${msg.model} · ${msg.cwd} ──`;
    case 'user':
      return labelled(msg.mode ? `You [${msg.mode}]` : 'You', msg.display ?? msg.content);
    case 'assistant': {
      const parts: string[] = [];
      if (msg.reasoning?.trim()) parts.push(labelled('Thinking', msg.reasoning.trim()));
      if (msg.content?.trim()) parts.push(labelled('Reika', msg.content.trim()));
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        parts.push(msg.toolCalls.map(formatToolCall).join('\n'));
      }
      if (msg.sources && msg.sources.length > 0) {
        parts.push(`Sources: ${msg.sources.join(', ')}`);
      }
      if (msg.durationMs !== undefined)
        parts.push(`■ Worked for ${formatDurationMs(msg.durationMs)}`);
      // An assistant turn can be reasoning + a tool call with no prose; never collapse to empty.
      return parts.length > 0 ? parts.join('\n\n') : null;
    }
    case 'tool': {
      const lines = [`  ↳ ${msg.summary}`];
      if (msg.diff) lines.push(indent(msg.diff.text, 4));
      if (msg.command) {
        lines.push(`    $ ${msg.command.text}`);
        // Marker first: the tail is the end of the run, so the omission is before it, not after.
        if (msg.command.outputTruncated) lines.push('    …(earlier output omitted)');
        if (msg.command.outputTail) lines.push(indent(msg.command.outputTail, 4));
      }
      return lines.join('\n');
    }
    case 'shell': {
      const lines = [`$ ${msg.command}`];
      if (msg.output) lines.push(msg.output);
      return lines.join('\n');
    }
    case 'system':
      return labelled('System', msg.content);
    case 'error':
      return labelled('Error', msg.content);
    case 'compaction':
      return labelled('Compaction', msg.content);
    default:
      return null;
  }
}

function labelled(label: string, body: string): string {
  return `${label}:\n${indent(body, 2)}`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map(line => (line ? pad + line : line))
    .join('\n');
}

function formatToolCall(tc: ToolCall): string {
  const args = Object.entries(tc.args)
    .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 120)}`)
    .join(', ');
  return `  ⏺︎ ${capitalize(tc.name)}(${args})`;
}

// Deep-copy a message with every human-facing string field run through the scrubbers. Keeps the
// redaction policy in one place so JSONL and .txt scrub identically. `cwd` is the session's
// working directory, threaded in from the caller's meta rather than read off `process.cwd()` —
// this module stays pure, and a transcript saved after a `/cd` scrubs against the cwd it was
// actually recorded under.
function redactMessage(msg: Message, cwd: string): Message {
  const red = (s: string) => scrub(s, cwd);
  switch (msg.role) {
    case 'user':
      return {
        ...msg,
        content: red(msg.content),
        ...(msg.display ? { display: red(msg.display) } : {}),
      };
    case 'assistant':
      return {
        ...msg,
        content: red(msg.content),
        ...(msg.reasoning ? { reasoning: red(msg.reasoning) } : {}),
        ...(msg.toolCalls ? { toolCalls: msg.toolCalls.map(tc => redactToolCall(tc, cwd)) } : {}),
        ...(msg.sources ? { sources: msg.sources.map(red) } : {}),
      };
    case 'tool':
      return {
        ...msg,
        summary: red(msg.summary),
        ...(msg.payload !== undefined ? { payload: red(msg.payload) } : {}),
        ...(msg.diff ? { diff: { ...msg.diff, text: red(msg.diff.text) } } : {}),
        ...(msg.command
          ? {
              command: {
                ...msg.command,
                text: red(msg.command.text),
                outputTail: red(msg.command.outputTail),
              },
            }
          : {}),
      };
    case 'shell':
      return { ...msg, command: red(msg.command), output: red(msg.output) };
    // The header's cwd is an absolute path by construction — it's the one field that leaks the
    // home prefix even in a transcript whose messages never quote a path.
    case 'header':
      return { ...msg, cwd: red(msg.cwd) };
    case 'system':
    case 'error':
    case 'compaction':
      return { ...msg, content: red(msg.content) };
    default:
      return msg;
  }
}

function redactToolCall(tc: ToolCall, cwd: string): ToolCall {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tc.args)) {
    args[k] = typeof v === 'string' ? scrub(v, cwd) : v;
  }
  return { ...tc, args };
}

// One shared entry point with the TUI, so the saved file and the screen can never disagree about
// what got scrubbed. See ui/scrub.ts for why the layer order is load-bearing.
function scrub(s: string, cwd: string): string {
  return scrubDisplay(s, cwd);
}

// The meta header carries the absolute cwd on its own. Scrubbing it against itself would empty
// the field (the cwd-prefix rule needs a trailing separator), so it collapses to `~/…` via the
// home rule and stays readable.
function scrubMeta(meta: TranscriptMeta): TranscriptMeta {
  return { ...meta, cwd: scrub(meta.cwd, meta.cwd) };
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
