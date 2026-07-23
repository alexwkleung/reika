import { readFile, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { resolveUserPath } from './_paths.js';
import type { Tool, EditFailure } from '../types.js';
import { buildEditDiff, editDiffStartLine } from './_diff.js';
import { surfaceImportedDeps } from './_deps.js';
import { groundUrls } from './_urls.js';

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace one exact-match occurrence of old_string with new_string in a file. Fails if old_string is missing or appears more than once — add surrounding context to make it unique.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd.' },
      old_string: {
        type: 'string',
        description: 'Exact text to replace. Include enough context to be unique in the file.',
      },
      new_string: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const path = String(args.path);
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    const full = resolveUserPath(ctx.cwd, path);
    const rel = relative(ctx.cwd, full) || path;

    if (oldStr === '') {
      return { summary: `Edit failed: old_string is empty` };
    }
    if (oldStr === newStr) {
      return { summary: `Edit failed: old_string and new_string are identical` };
    }

    const text = await readFile(full, 'utf8');

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
          summary: `Edit failed: old_string appears multiple times in ${rel} (lines ${a}, ${b}); add surrounding context to make it unique`,
        };
      }
      start = first;
      matchLen = oldStr.length;
      effectiveNew = newStr;
    } else {
      const fuzzy = fuzzyLineMatch(text, oldStr, newStr);
      if (fuzzy.status === 'multiple') {
        return {
          summary: `Edit failed: old_string appears multiple times in ${rel} (lines ${fuzzy.lines.join(', ')}); add surrounding context to make it unique`,
        };
      }
      if (fuzzy.status === 'mixed') {
        return {
          summary: `Edit failed: new_string mixes indentation in ${rel}; line "${fuzzy.line.trim()}" doesn't match the block's base indent — re-indent it consistently and retry`,
        };
      }
      if (fuzzy.status === 'none') {
        return {
          summary: `Edit failed: old_string not found in ${rel}.${fuzzy.hint}`,
          // Surface the structured divergence the hint was built from, so the agent loop can ground a
          // recovery round on it (see agent/loop.ts buildEditRecoveryLedger) instead of re-parsing the
          // summary string. `absent` here means re-reading won't help — the target isn't in the file.
          editFailure: withPath(fuzzy.failure, rel),
        };
      }
      start = fuzzy.start;
      matchLen = fuzzy.len;
      effectiveNew = fuzzy.newStr;
    }

    const matchedOld = text.slice(start, start + matchLen);
    const beforeText = text.slice(0, start);
    const diffText = buildEditDiff(
      matchedOld,
      effectiveNew,
      beforeText,
      text.slice(start + matchLen),
    );
    const startLine = editDiffStartLine(beforeText);

    if (ctx.requestApproval) {
      const ok = await ctx.requestApproval({
        tool: 'edit',
        subject: rel,
        preview: diffText,
        startLine,
      });
      if (!ok) return { summary: `Edit declined by user for ${rel}` };
    }

    const next = text.slice(0, start) + effectiveNew + text.slice(start + matchLen);
    await writeFile(full, next, 'utf8');
    const line = text.slice(0, start).split('\n').length;
    const added = countPrefixed(diffText, '+ ');
    const removed = countPrefixed(diffText, '- ');
    // Scan only the replacement text: these fire when the model introduces an import or a URL,
    // grounding the dep on its real API and the URL on its real (or non-existent) content rather
    // than an assumed shape. Independent, so fetch them concurrently.
    const [depPayload, url] = await Promise.all([
      surfaceImportedDeps(ctx, effectiveNew),
      groundUrls(ctx, effectiveNew),
    ]);
    // Hand back the post-edit file (small files only) so a follow-up edit to the same file is built
    // from current bytes instead of a now-stale read — collapsing the re-read-after-edit loop. The
    // size cap keeps the cost trivial and is where multi-site edits actually cluster; large files
    // fall back to the diff region (model re-reads only if it needs a distant block).
    const refreshed = refreshedFile(rel, next);
    const payload = [depPayload, url.note, refreshed].filter(Boolean).join('\n\n') || undefined;
    return {
      summary: `Edited ${rel} at line ${line} (+${added} -${removed})`,
      diff: { text: diffText, path: rel, added, removed, startLine },
      ...(payload ? { payload } : {}),
      ...(url.notice ? { notice: url.notice } : {}),
    };
  },
};

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
    .map((l, i) => `${String(i + 1).padStart(5, ' ')}│${l}`)
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
  | { kind: 'absent' }
  | { kind: 'diverged'; divergentLine: number; expected: string; actual: string; excerpt: string };

function withPath(core: EditFailureCore, path: string): EditFailure {
  return core.kind === 'absent' ? { kind: 'absent', path } : { ...core, path };
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

// Point the model at the likely spot when even the tolerant match fails, so it can correct in one
// retry instead of probing with cat/sed — the costly thing for a weak model to discover on its own.
function formatNotFoundHint(closest: Closest, oldLines: string[], oldTrim: string[]): string {
  const i0 = oldTrim.findIndex(t => t !== '');
  if (i0 === -1) return '';
  if (!closest.found) return ' No line matches it even ignoring whitespace; re-read the file.';
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
  if (!closest.found) return { kind: 'absent' };
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
    .map((l, idx) => `${String(from + idx + 1).padStart(5, ' ')}│${l}`)
    .join('\n');
}
