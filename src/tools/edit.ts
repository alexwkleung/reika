import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import {
  escapesProject,
  gitMetadataWarning,
  OUTSIDE_PROJECT_WARNING,
  resolveUserPath,
} from './_paths.js';
import type { Tool, EditFailure, ToolContext, ToolResult } from '../types.js';
import { gutterLine, lineHash, parseLineRef } from './_lineref.js';
import { buildEditDiff, editDiffStartLine } from './_diff.js';
import { surfaceImportedDeps } from './_deps.js';
import { groundUrls } from './_urls.js';
import { declineSummary } from '../approval.js';

const EDIT_PARAMETERS = {
  path: { type: 'string', description: 'File path, relative to cwd.' },
  old_string: {
    type: 'string',
    description: 'Exact text to replace. Include enough context to be unique in the file.',
  },
  new_string: { type: 'string', description: 'Replacement text.' },
};

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace one exact-match occurrence of old_string with new_string in a file. Fails if old_string is missing or appears more than once — add surrounding context to make it unique.',
  parameters: {
    type: 'object',
    properties: EDIT_PARAMETERS,
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const target = resolveEditTarget(String(args.path), ctx);
    const refused = refuseUnconfirmable(target, ctx);
    if (refused) return refused;
    const { display } = target;

    if (oldStr === '') {
      return { summary: `Edit failed: old_string is empty` };
    }
    if (oldStr === newStr) {
      return { summary: `Edit failed: old_string and new_string are identical` };
    }

    // Consent BEFORE the read, not just before the write. Every failure branch below returns
    // ahead of the diff approval, and they are built from file contents: `fuzzy.hint` names lines,
    // and `editFailure.excerpt` carries up to EXCERPT_MAX_LINES verbatim. Gating only the write
    // left `edit` usable as a read primitive for any path on disk under `safe` — point it at a
    // credentials file with an old_string that cannot match and the contents come back with no
    // modal. Scrubbing those messages was the alternative and is the wrong one: gate earlier
    // rather than launder what the model gets to see.
    //
    // The preview is built from the model's own arguments, so it needs nothing off disk and still
    // shows the user the actual proposed change. The real contextual diff comes to the approval
    // below, which no longer re-raises the warning — the boundary was consented to here, so under
    // `safe` that second one auto-approves and this stays a single modal.
    const consent = await consentBeforeRead(target, ctx, intentDiff(oldStr, newStr));
    if (consent === 'declined') return { summary: declineSummary('Edit', ` for ${display}`, ctx) };

    const text = await readFile(target.full, 'utf8');

    // Resolve the match. Exact byte-match is the fast, precise path. If it
    // misses — almost always because the model's leading whitespace is off by a
    // few spaces — fall back to a whitespace-insensitive line-block match and
    // re-indent new_string to the file's real indentation. This collapses the
    // read→guess→retry loop that weaker models otherwise burn on every edit.
    let start: number;
    let matchLen: number;
    let effectiveNew: string;

    const first = text.indexOf(oldStr);
    if (first !== -1) {
      const second = text.indexOf(oldStr, first + oldStr.length);
      if (second !== -1) {
        const a = lineOf(text, first);
        const b = lineOf(text, second);
        return {
          summary: `Edit failed: old_string appears multiple times in ${display} (lines ${a}, ${b}); add surrounding context to make it unique`,
        };
      }
      start = first;
      matchLen = oldStr.length;
      effectiveNew = newStr;
    } else {
      const fuzzy = fuzzyLineMatch(text, oldStr, newStr);
      if (fuzzy.status === 'multiple') {
        return {
          summary: `Edit failed: old_string appears multiple times in ${display} (lines ${fuzzy.lines.join(', ')}); add surrounding context to make it unique`,
        };
      }
      if (fuzzy.status === 'mixed') {
        return {
          summary: `Edit failed: new_string mixes indentation in ${display}; line "${fuzzy.line.trim()}" doesn't match the block's base indent — re-indent it consistently and retry`,
        };
      }
      if (fuzzy.status === 'none') {
        return {
          summary: `Edit failed: old_string not found in ${display}.${fuzzy.hint}`,
          // Surface the structured divergence the hint was built from, so the agent loop can ground a
          // recovery round on it (see agent/loop.ts buildEditRecoveryLedger) instead of re-parsing the
          // summary string. `absent` here means re-reading won't help — the target isn't in the file.
          editFailure: withPath(fuzzy.failure, display),
        };
      }
      start = fuzzy.start;
      matchLen = fuzzy.len;
      effectiveNew = fuzzy.newStr;
    }

    return commitEdit(ctx, target, text, { start, len: matchLen, newStr: effectiveNew }, consent);
  },
};

type EditTarget = {
  full: string;
  // See write.ts for why these are two names. `rel` stays project-relative because it rides
  // `diff.path`, which App.tsx hands to addFileToIndex -> ignore (a RangeError on an absolute
  // path); `display` is what the user and the model see.
  rel: string;
  display: string;
  outside: boolean;
  gated: boolean;
  warnings: string[];
};

function resolveEditTarget(path: string, ctx: ToolContext): EditTarget {
  const full = resolveUserPath(ctx.cwd, path);
  const outside = escapesProject(ctx.cwd, full);
  // Git config and hooks name programs something else runs, so they carry a warning the same way
  // an out-of-project path does (#719). Combined into one `warnings` list so a path that is both
  // (an outside repo's `.git/config`) raises each flag once, in one modal.
  const gitMeta = gitMetadataWarning(ctx.cwd, full);
  const warnings = [...(outside ? [OUTSIDE_PROJECT_WARNING] : []), ...(gitMeta ? [gitMeta] : [])];
  const rel = relative(ctx.cwd, full) || path;
  return {
    full,
    rel,
    display: outside ? full : rel,
    outside,
    gated: outside || gitMeta !== undefined,
    warnings,
  };
}

// See write.ts — the same gap, the same gate. Checked before the file is read so the boundary is
// reported instead of an incidental read error on a path we would refuse anyway.
function refuseUnconfirmable(t: EditTarget, ctx: ToolContext): ToolResult | null {
  if (!t.gated || ctx.requestApproval) return null;
  if (t.outside) {
    return {
      summary:
        `Edit refused: ${t.full} is outside the project directory (${ctx.cwd}), and approvals ` +
        'are bypassed so it cannot be confirmed with the user. Edit inside the project instead.',
    };
  }
  return {
    summary:
      `Edit refused: ${t.display} is git config or a hook, which runs code at the user's next ` +
      'git command. Approvals are bypassed so it cannot be confirmed with the user; edit a ' +
      'project file instead, or leave the change for the user.',
  };
}

// 'approved' means the boundary was consented to and the diff approval need not ask again.
async function consentBeforeRead(
  t: EditTarget,
  ctx: ToolContext,
  preview: string,
): Promise<'approved' | 'declined' | 'not-gated'> {
  if (!t.gated || !ctx.requestApproval) return 'not-gated';
  const ok = await ctx.requestApproval({
    tool: 'edit',
    subject: t.display,
    preview,
    warnings: t.warnings,
  });
  return ok ? 'approved' : 'declined';
}

// A resolved change: replace `len` chars at `start` with `newStr`. `line` overrides the line the
// summary names (an insert names where its lines land, not the anchor), and `removed` is shown to
// the model in the result (a range replace, #1132).
type ResolvedEdit = { start: number; len: number; newStr: string; line?: number; removed?: string };

async function commitEdit(
  ctx: ToolContext,
  t: EditTarget,
  text: string,
  r: ResolvedEdit,
  consent: 'approved' | 'not-gated',
): Promise<ToolResult> {
  const { display, rel } = t;
  const { start, len: matchLen, newStr: effectiveNew } = r;
  const matchedOld = text.slice(start, start + matchLen);
  const beforeText = text.slice(0, start);
  const diffText = buildEditDiff(
    matchedOld,
    effectiveNew,
    beforeText,
    text.slice(start + matchLen),
  );
  const startLine = editDiffStartLine(beforeText);

  if (ctx.requestApproval && consent !== 'approved') {
    const ok = await ctx.requestApproval({
      tool: 'edit',
      subject: display,
      preview: diffText,
      startLine,
    });
    if (!ok) return { summary: declineSummary('Edit', ` for ${display}`, ctx) };
  }

  // `next` is built from the bytes read above, and the approval may have waited minutes. Anything
  // written in between — another session in this cwd, the user's editor — would be silently lost,
  // even a change far from this span, since the whole file is rewritten (#487).
  const current = await readFile(t.full, 'utf8').catch(() => null);
  if (current !== text) {
    return {
      summary: `Edit failed: ${display} changed on disk while the edit was being prepared; nothing was written. Re-read it and retry the edit against its current contents`,
    };
  }
  const next = text.slice(0, start) + effectiveNew + text.slice(start + matchLen);
  await writeFile(t.full, next, 'utf8');
  const line = r.line ?? text.slice(0, start).split('\n').length;
  const added = countPrefixed(diffText, '+ ');
  const removed = countPrefixed(diffText, '- ');
  // Scan only the replacement text: these fire when the model introduces an import or a URL,
  // grounding the dep on its real API and the URL on its real (or non-existent) content rather
  // than an assumed shape. Independent, so fetch them concurrently.
  const [depPayload, url] = await Promise.all([
    surfaceImportedDeps(ctx, effectiveNew),
    groundUrls(ctx, effectiveNew, rel),
  ]);
  // Hand back the post-edit file (small files only) so a follow-up edit to the same file is built
  // from current bytes instead of a now-stale read — collapsing the re-read-after-edit loop. The
  // size cap keeps the cost trivial and is where multi-site edits actually cluster; large files
  // fall back to the diff region (model re-reads only if it needs a distant block).
  const refreshed = refreshedFile(display, next);
  const payload =
    [r.removed, depPayload, url.note, refreshed].filter(Boolean).join('\n\n') || undefined;
  // startLine rides along for the UI (Message['diff'] carries it) beyond ToolResult's own type.
  const diff = { text: diffText, path: rel, added, removed, startLine };
  return {
    summary: `Edited ${display} at line ${line} (+${added} -${removed})`,
    diff,
    ...(payload ? { payload } : {}),
    ...(url.notice ? { notice: url.notice } : {}),
  };
}

// EXPERIMENT (#1132, REIKA_EDIT_POSITION=1, default off — tools/_lineref.ts). The same tool with a
// position in place of old_string: insert beside an anchor line, or replace a hash-checked line
// range. Registered instead of `editTool` only when the flag is on, so with it off the schema every
// request carries is byte-identical. old_string keeps its matching and recovery unchanged; a call
// with no position is handed to `editTool.run` as is.
const POSITION_KEYS = ['insert_after', 'insert_before', 'start_line', 'end_line'] as const;

export const positionalEditTool: Tool = {
  ...editTool,
  description:
    'Change a file. Either replace one exact-match old_string with new_string (fails if missing or not unique), or give a position instead of old_string: insert_after/insert_before the one line containing a short string, or replace lines start_line..end_line, each written "N:hash" as copied from the read gutter.',
  parameters: {
    type: 'object',
    properties: {
      ...EDIT_PARAMETERS,
      old_string: {
        type: 'string',
        description: 'Exact text to replace. Omit it when giving a position.',
      },
      new_string: { type: 'string', description: 'Replacement or inserted text.' },
      insert_after: {
        type: 'string',
        description: 'Insert new_string after the one line containing this text.',
      },
      insert_before: {
        type: 'string',
        description: 'Insert new_string before the one line containing this text.',
      },
      start_line: {
        type: 'string',
        description: 'First line to replace, "N:hash" from the read gutter (e.g. "120:a3f").',
      },
      end_line: {
        type: 'string',
        description: 'Last line to replace, "N:hash". Defaults to start_line.',
      },
    },
    required: ['path', 'new_string'],
  },
  async run(args, ctx) {
    if (!hasPositionArgs(args)) return editTool.run(args, ctx);
    if (String(args.old_string ?? '') !== '') {
      return {
        summary:
          'Edit failed: give either old_string or a position (insert_after, insert_before, start_line/end_line), not both',
      };
    }
    const target = resolveEditTarget(String(args.path), ctx);
    const refused = refuseUnconfirmable(target, ctx);
    if (refused) return refused;
    const newStr = String(args.new_string ?? '');
    const consent = await consentBeforeRead(
      target,
      ctx,
      newStr
        .split('\n')
        .map(l => `+ ${l}`)
        .join('\n'),
    );
    if (consent === 'declined') {
      return { summary: declineSummary('Edit', ` for ${target.display}`, ctx) };
    }
    const text = await readFile(target.full, 'utf8');
    const r = resolvePosition(text, args, target.display);
    if ('summary' in r) return r;
    return commitEdit(ctx, target, text, r, consent);
  },
};

export function hasPositionArgs(args: Record<string, unknown>): boolean {
  return POSITION_KEYS.some(k => args[k] !== undefined && args[k] !== null && args[k] !== '');
}

// Would this positional edit apply to these bytes? For the read-first gate: an anchor that names
// one line, or a range whose hashes match, is not a guess (agent/readfirst.ts editProvesBytes).
export function positionLands(text: string, args: Record<string, unknown>): boolean {
  return !('summary' in resolvePosition(text, args, ''));
}

type PositionFailure = { summary: string; payload?: string };

function resolvePosition(
  text: string,
  args: Record<string, unknown>,
  display: string,
): ResolvedEdit | PositionFailure {
  const given = POSITION_KEYS.filter(
    k => args[k] !== undefined && args[k] !== null && args[k] !== '',
  );
  const inserts = given.filter(k => k === 'insert_after' || k === 'insert_before');
  const ranged = given.length > inserts.length;
  if (inserts.length > 1 || (inserts.length === 1 && ranged)) {
    return {
      summary:
        'Edit failed: give one position — insert_after, insert_before, or start_line/end_line',
    };
  }
  const newStr = String(args.new_string ?? '');
  const lines = text.split('\n');
  const total =
    lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (inserts.length === 1) {
    return resolveInsert(lines, total, inserts[0], String(args[inserts[0]]), newStr, display);
  }
  if (args.start_line === undefined || args.start_line === null || args.start_line === '') {
    return { summary: 'Edit failed: end_line needs a start_line' };
  }
  return resolveRange(
    lines,
    total,
    args.start_line,
    args.end_line ?? args.start_line,
    newStr,
    display,
  );
}

// Shown on a failed position, so the next call has current numbers and hashes. Capped like the
// old_string excerpt.
const POSITION_EXCERPT_MAX_LINES = 40;
const ANCHOR_HITS_SHOWN = 8;
// The lines a range replace removed, returned so a wrong range shows on the next round (#1132's
// second bound). Capped so a large range does not double its own cost.
const REMOVED_SHOWN_MAX_LINES = 80;

function hashedWindow(lines: string[], from: number, to: number): string {
  return lines
    .slice(from, to)
    .map((l, i) => gutterLine(from + i + 1, l, true))
    .join('\n');
}

function offsetOfLine(lines: string[], index: number): number {
  let n = 0;
  for (let k = 0; k < index; k++) n += lines[k].length + 1;
  return n;
}

function stripOneTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function resolveInsert(
  lines: string[],
  total: number,
  kind: 'insert_after' | 'insert_before',
  anchor: string,
  newStr: string,
  display: string,
): ResolvedEdit | PositionFailure {
  const needle = anchor.trim();
  if (needle === '' || needle.includes('\n')) {
    return { summary: `Edit failed: ${kind} must be text from a single line of ${display}` };
  }
  if (newStr === '') return { summary: 'Edit failed: new_string is empty; nothing to insert' };
  const hits: number[] = [];
  for (let i = 0; i < total; i++) if (lines[i].includes(needle)) hits.push(i);
  if (hits.length === 0) {
    return {
      summary: `Edit failed: no line of ${display} contains "${needle}"; nothing was written. Use text copied from a line of the file`,
    };
  }
  if (hits.length > 1) {
    return {
      summary:
        `Edit failed: "${needle}" is on ${hits.length} lines of ${display} ` +
        `(lines ${hits.map(h => h + 1).join(', ')}); nothing was written. Use text only one line ` +
        'contains, or start_line/end_line',
      payload: hits
        .slice(0, ANCHOR_HITS_SHOWN)
        .map(h => gutterLine(h + 1, lines[h], true))
        .join('\n'),
    };
  }
  // The anchor line itself is the replaced span, so the diff draws it as context beside the new
  // lines rather than as a zero-width change.
  const i = hits[0];
  const body = stripOneTrailingNewline(newStr);
  const after = kind === 'insert_after';
  return {
    start: offsetOfLine(lines, i),
    len: lines[i].length,
    newStr: after ? `${lines[i]}\n${body}` : `${body}\n${lines[i]}`,
    line: after ? i + 2 : i + 1,
  };
}

function resolveRange(
  lines: string[],
  total: number,
  startRaw: unknown,
  endRaw: unknown,
  newStr: string,
  display: string,
): ResolvedEdit | PositionFailure {
  const s = parseLineRef(startRaw);
  const e = parseLineRef(endRaw);
  if (!s || !e) {
    return {
      summary:
        'Edit failed: start_line and end_line are "N:hash" as shown in the read gutter (e.g. "120:a3f")',
    };
  }
  if (s.line < 1 || e.line > total || s.line > e.line) {
    return {
      summary: `Edit failed: lines ${s.line}-${e.line} are not a range in ${display}, which has ${total} lines`,
    };
  }
  const window = () => {
    const from = Math.max(0, s.line - 2);
    return hashedWindow(
      lines,
      from,
      Math.min(total, e.line + 1, from + POSITION_EXCERPT_MAX_LINES),
    );
  };
  if (!s.hash || !e.hash) {
    return {
      summary:
        `Edit failed: start_line and end_line need the hash from the read gutter ("${s.line}:${lineHash(lines[s.line - 1])}"); ` +
        `nothing was written. The current lines of ${display} are below`,
      payload: window(),
    };
  }
  const staleAt =
    lineHash(lines[s.line - 1]) !== s.hash
      ? s.line
      : lineHash(lines[e.line - 1]) !== e.hash
        ? e.line
        : undefined;
  if (staleAt !== undefined) {
    const moved = relocateRange(lines, total, s.hash, e.hash, e.line - s.line);
    return {
      summary:
        `Edit failed: line ${staleAt} of ${display} is not the line you read (its hash changed); ` +
        'nothing was written.' +
        (moved ? ` The lines you read appear to be at ${moved.from}-${moved.to} now.` : '') +
        ' The current lines are below — re-issue with their N:hash',
      payload: window(),
    };
  }
  const body = stripOneTrailingNewline(newStr);
  const old = lines.slice(s.line - 1, e.line).join('\n');
  if (body === old) {
    return { summary: 'Edit failed: new_string is identical to the lines it replaces' };
  }
  const removedLines = lines.slice(s.line - 1, e.line);
  const shown = removedLines
    .slice(0, REMOVED_SHOWN_MAX_LINES)
    .map((l, k) => gutterLine(s.line + k, l, false));
  const more = removedLines.length - shown.length;
  const removed =
    `(reika: lines ${s.line}-${e.line} of ${display} were replaced; they were:)\n` +
    shown.join('\n') +
    (more > 0 ? `\n…(${more} more removed line${more === 1 ? '' : 's'})` : '');
  if (body !== '') {
    return {
      start: offsetOfLine(lines, s.line - 1),
      len: old.length,
      newStr: body,
      line: s.line,
      removed,
    };
  }
  // A deletion takes a neighbouring line into the span, so its newline goes with the removed lines
  // instead of leaving a blank one behind.
  if (e.line < total) {
    const span = lines.slice(s.line - 1, e.line + 1).join('\n');
    return {
      start: offsetOfLine(lines, s.line - 1),
      len: span.length,
      newStr: lines[e.line],
      line: s.line,
      removed,
    };
  }
  if (s.line > 1) {
    const span = lines.slice(s.line - 2, e.line).join('\n');
    return {
      start: offsetOfLine(lines, s.line - 2),
      len: span.length,
      newStr: lines[s.line - 2],
      line: s.line - 1,
      removed,
    };
  }
  return { start: 0, len: old.length, newStr: '', line: 1, removed };
}

// Where a range the model read has moved to, when an earlier edit shifted it: the one place both
// edge hashes occur the same distance apart. A hint only — the edit is still refused, since two
// three-char hashes are not proof enough to rewrite lines the model has not seen at that number.
function relocateRange(
  lines: string[],
  total: number,
  startHash: string,
  endHash: string,
  span: number,
): { from: number; to: number } | null {
  let found: number | null = null;
  for (let i = 0; i + span < total; i++) {
    if (lineHash(lines[i]) !== startHash || lineHash(lines[i + span]) !== endHash) continue;
    if (found !== null) return null;
    found = i;
  }
  return found === null ? null : { from: found + 1, to: found + span + 1 };
}

// A diff-shaped preview of the change the model is asking for, built only from its arguments. Used
// to gate the read on an out-of-project path, where the file has deliberately not been opened yet
// and the real contextual diff therefore does not exist.
function intentDiff(oldStr: string, newStr: string): string {
  const minus = oldStr.split('\n').map(l => `- ${l}`);
  const plus = newStr.split('\n').map(l => `+ ${l}`);
  return [...minus, ...plus].join('\n');
}

// A small edited file is cheap to echo back and is exactly where the re-read-after-edit loop bites
// (config/index/test modules with edits scattered across the file). Above the cap, the per-edit
// context cost stops being trivial and could feed compaction, so we don't — the diff region already
// covers near-edits. Lines numbered with the same `│` gutter as the read tool so the model consumes
// it identically (copy the text after `│` for the next old_string).
const REFRESH_MAX_LINES = 120;
const REFRESH_MAX_CHARS = 8000;

function refreshedFile(rel: string, content: string): string | undefined {
  if (content.length > REFRESH_MAX_CHARS) return undefined;
  const lines = content.split('\n');
  // A trailing newline yields a phantom empty final element; don't number it.
  const total =
    lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (total > REFRESH_MAX_LINES) return undefined;
  const numbered = lines
    .slice(0, total)
    .map((l, i) => gutterLine(i + 1, l))
    .join('\n');
  return (
    `(reika: ${rel} after your edit — current contents below. Build any further edits to this ` +
    `file from this exact text; you do not need to re-read it.)\n${numbered}`
  );
}

function countPrefixed(text: string, prefix: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.startsWith(prefix)) n++;
  return n;
}

type FuzzyResult =
  | { status: 'unique'; start: number; len: number; newStr: string }
  | { status: 'multiple'; lines: number[] }
  | { status: 'mixed'; line: string }
  | { status: 'none'; hint: string; failure: EditFailureCore };

// EditFailure minus the path (the tool attaches that in `run`). See types.ts EditFailure.
type EditFailureCore =
  | { kind: 'absent'; at?: number; excerpt?: string }
  | { kind: 'diverged'; divergentLine: number; expected: string; actual: string; excerpt: string };

// How `run` would resolve old_string against these bytes, without applying anything. Shares the
// matcher rather than restating it, so the read-first gate's would-land probe (agent/readfirst.ts)
// cannot drift from what the edit would actually have done.
export type EditMatchKind = 'exact' | 'fuzzy' | 'multiple' | 'mixed' | 'absent' | 'diverged';

export function classifyEditMatch(text: string, oldStr: string, newStr: string): EditMatchKind {
  const first = text.indexOf(oldStr);
  if (first !== -1) {
    return text.indexOf(oldStr, first + oldStr.length) === -1 ? 'exact' : 'multiple';
  }
  const fuzzy = fuzzyLineMatch(text, oldStr, newStr);
  if (fuzzy.status === 'unique') return 'fuzzy';
  if (fuzzy.status === 'none') return fuzzy.failure.kind;
  return fuzzy.status;
}

function withPath(core: EditFailureCore, path: string): EditFailure {
  return { ...core, path };
}

// Whitespace-insensitive line-block match. Compares old_string against the file
// line-by-line on trimmed content, so leading/trailing indentation differences
// don't block a match. Still requires the block to be UNIQUE — same safety
// contract as the exact path. On success, new_string is re-indented so its
// absolute indentation matches the file even if the model used a wrong base.
function fuzzyLineMatch(text: string, oldStr: string, newStr: string): FuzzyResult {
  const fileLines = text.split('\n');
  let oldLines = oldStr.split('\n');
  let newLines = newStr.split('\n');

  // A trailing newline in old_string yields a trailing '' line; drop it (and the
  // matching one in new_string) so we match whole lines without requiring an
  // extra blank line after the block in the file.
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '') {
    oldLines = oldLines.slice(0, -1);
    if (newLines.length > 0 && newLines[newLines.length - 1] === '') {
      newLines = newLines.slice(0, -1);
    }
  }

  const oldTrim = oldLines.map(l => l.trim());
  const n = oldTrim.length;

  const starts: number[] = [];
  for (let s = 0; s + n <= fileLines.length; s++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (fileLines[s + k].trim() !== oldTrim[k]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(s);
  }

  if (starts.length === 0) {
    const closest = locateClosest(fileLines, oldTrim);
    return {
      status: 'none',
      hint: formatNotFoundHint(closest, oldLines, oldTrim),
      failure: closestToFailure(closest, fileLines, oldTrim),
    };
  }
  if (starts.length > 1) {
    return { status: 'multiple', lines: starts.map(s => s + 1) };
  }

  const s = starts[0];
  const start = fileLines.slice(0, s).reduce((acc, l) => acc + l.length + 1, 0);
  const matchLen = fileLines.slice(s, s + n).join('\n').length;

  // Re-indent new_string by the base-indent delta observed on the first
  // non-blank matched line. Each new line that shares the model's (wrong) base
  // indent gets it swapped for the file's real base; relative indentation within
  // the block is preserved. Blank lines stay blank.
  const i0 = oldTrim.findIndex(t => t !== '');
  let reindented = newLines;
  if (i0 !== -1) {
    const baseOld = leadingWs(oldLines[i0]);
    const baseFile = leadingWs(fileLines[s + i0]);
    if (baseOld !== baseFile) {
      // Guard: every non-blank new line must share the model's base indent so we
      // can rewrite it to the file's. A line that doesn't (mixed tabs/spaces, or
      // a dedent below the block base) can't be re-indented unambiguously —
      // reject loudly rather than emit a silently mis-indented edit.
      const offending = newLines.find(l => l.trim() !== '' && !l.startsWith(baseOld));
      if (offending !== undefined) {
        return { status: 'mixed', line: offending };
      }
      reindented = newLines.map(l => (l.trim() === '' ? '' : baseFile + l.slice(baseOld.length)));
    }
  }

  return { status: 'unique', start, len: matchLen, newStr: reindented.join('\n') };
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

type Closest =
  | { found: false }
  | {
      found: true;
      start: number; // 0-based file line the candidate block begins on
      matched: number; // leading block lines that matched before divergence
      divergentLine: number; // 1-based file line that first differs
      expected: string; // old_string's content on that line (trimmed)
      actual: string; // the file's content there (trimmed)
    };

// Locate the best-aligned candidate block when even the whitespace-tolerant match fails: file lines
// whose content equals old_string's anchor (first non-blank line), aligned so the anchor sits at its
// position within the block, keeping whichever candidate matched the most leading lines — the model's
// likely intended spot. `found:false` means nothing aligns even ignoring whitespace (the target isn't
// in the file). Shared by the model-facing hint and the structured EditFailure.
function locateClosest(fileLines: string[], oldTrim: string[]): Closest {
  const i0 = oldTrim.findIndex(t => t !== '');
  if (i0 === -1) return { found: false };
  const anchor = oldTrim[i0];
  const n = oldTrim.length;

  let best: { start: number; matched: number } | null = null;
  for (let a = 0; a < fileLines.length; a++) {
    if (fileLines[a].trim() !== anchor) continue;
    const s = a - i0;
    if (s < 0) continue;
    let matched = 0;
    while (matched < n && fileLines[s + matched]?.trim() === oldTrim[matched]) matched++;
    if (!best || matched > best.matched) best = { start: s, matched };
  }
  if (!best) return { found: false };

  const k = best.matched;
  return {
    found: true,
    start: best.start,
    matched: k,
    divergentLine: best.start + k + 1,
    expected: oldTrim[k] ?? '',
    actual: fileLines[best.start + k]?.trim() ?? '(end of file)',
  };
}

// Weakest locator, for when locateClosest finds nothing: not one line of old_string equals any line
// of the file, so there is no anchor to align on and nothing to diff. Score every window of the file
// by how many of old_string's distinct identifiers it contains and keep the best — which region was
// the model probably reaching for. Deliberately crude: it runs only once the precise tiers have
// failed, and its output is offered as "nearest similar code", never as a match.
//
// This is the tier that speaks to confabulation. A model writing old_string from memory rather than
// from bytes still tends to get the vocabulary right (the real `useState`/`null`/`overrides` of the
// region) while inventing the exact lines — so token overlap lands in the right neighbourhood
// exactly when line matching cannot.
const OVERLAP_MIN_FRACTION = 0.34;
const OVERLAP_MIN_TOKENS = 2;
// Identifier-ish, and long enough to carry signal: `if`/`i` co-occur with everything.
const TOKEN_RE = /[A-Za-z_$][\w$]*/g;
function distinctTokens(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) for (const t of l.match(TOKEN_RE) ?? []) if (t.length >= 3) out.add(t);
  return out;
}

function locateByTokenOverlap(fileLines: string[], oldTrim: string[]): number | null {
  const wanted = distinctTokens(oldTrim);
  if (wanted.size < OVERLAP_MIN_TOKENS) return null;
  const need = Math.max(OVERLAP_MIN_TOKENS, Math.ceil(wanted.size * OVERLAP_MIN_FRACTION));
  const win = Math.max(1, Math.min(oldTrim.length, fileLines.length));
  const perLine = fileLines.map(l => distinctTokens([l]));

  let best: { start: number; hits: number } | null = null;
  for (let s = 0; s + win <= fileLines.length; s++) {
    const seen = new Set<string>();
    for (let k = 0; k < win; k++) for (const t of perLine[s + k]) if (wanted.has(t)) seen.add(t);
    if (!best || seen.size > best.hits) best = { start: s, hits: seen.size };
  }
  return best && best.hits >= need ? best.start : null;
}

// Point the model at the likely spot when even the tolerant match fails, so it can correct in one
// retry instead of probing with cat/sed — the costly thing for a weak model to discover on its own.
function formatNotFoundHint(closest: Closest, oldLines: string[], oldTrim: string[]): string {
  const i0 = oldTrim.findIndex(t => t !== '');
  if (i0 === -1) return '';
  if (!closest.found) return ' No line matches it even ignoring whitespace.';
  return (
    ` Closest match starts at line ${closest.start + 1} ("${oldLines[i0].trim()}")` +
    ` but line ${closest.divergentLine} differs: expected "${closest.expected}", file has "${closest.actual}". Re-read there and copy verbatim.`
  );
}

// Same divergence as the hint, as data the agent loop can lift into a non-aging recovery directive.
function closestToFailure(
  closest: Closest,
  fileLines: string[],
  oldTrim: string[],
): EditFailureCore {
  if (!closest.found) {
    // No anchor, so fall to token overlap. The excerpt is carried, not announced: whether the model
    // needs these bytes depends on what its context already holds, which only the loop knows.
    const at = locateByTokenOverlap(fileLines, oldTrim);
    if (at === null) return { kind: 'absent' };
    return {
      kind: 'absent',
      at: at + 1,
      excerpt: blockExcerpt(fileLines, at, oldTrim.length, at + 1),
    };
  }
  return {
    kind: 'diverged',
    divergentLine: closest.divergentLine,
    expected: closest.expected,
    actual: closest.actual,
    excerpt: blockExcerpt(fileLines, closest.start, oldTrim.length, closest.divergentLine),
  };
}

// Verbatim, line-numbered current text around the closest block (same `│` gutter the read tool and
// refreshedFile use, so the model copies it identically). One line of margin; capped, and re-centered
// on the divergent line when the block is large so the line the model must fix is always shown.
const EXCERPT_MAX_LINES = 40;
function blockExcerpt(
  fileLines: string[],
  blockStart: number,
  blockLen: number,
  divergentLine: number,
): string {
  let from = Math.max(0, blockStart - 1);
  let to = Math.min(fileLines.length, blockStart + blockLen + 1);
  if (to - from > EXCERPT_MAX_LINES) {
    from = Math.max(0, divergentLine - 1 - Math.floor(EXCERPT_MAX_LINES / 2));
    to = Math.min(fileLines.length, from + EXCERPT_MAX_LINES);
  }
  return fileLines
    .slice(from, to)
    .map((l, idx) => gutterLine(from + idx + 1, l))
    .join('\n');
}
