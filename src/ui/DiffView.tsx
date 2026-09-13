import { Box, Text } from 'ink';
import { diffWordsWithSpace } from 'diff';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import chalk from 'chalk';
import { theme } from './theme.js';
import { highlightCode } from './highlight.js';
import { sanitizeTerminalText } from './termtext.js';

export function DiffView({
  diff,
  path,
  maxWidth,
  startLine,
  oldStartLine,
}: {
  diff: string;
  path: string;
  // Available cols for diff rendering. Used to pad changed-line backgrounds to
  // full width without overflowing. Caller knows its own container offset.
  maxWidth: number;
  // 1-based file line number of the first line in the diff. When provided, a
  // line-number gutter is rendered (old number for removed lines, new number for
  // added/context). Omit to render without a gutter.
  startLine?: number;
  // Where the same first line sits in the OLD file, when the two drifted apart — the second hunk
  // of a multi-hunk diff, after an earlier hunk added or removed lines. Defaults to `startLine`,
  // which is exact for an edit's single block.
  oldStartLine?: number;
}) {
  const lang = detectLanguage(path);
  const blocks = parseDiffBlocks(sanitizeDiffLines(diff));
  const rows = assignLineNumbers(blocks, startLine, oldStartLine);
  const showGutter = startLine !== undefined;
  // Width of the number column, sized to the largest line number in view.
  const gutterWidth = showGutter ? String(rows.maxLineNo).length : 0;
  // Gutter eats columns the content background must not pad over: digits + one space.
  const contentWidth = showGutter ? Math.max(0, maxWidth - gutterWidth - 1) : maxWidth;

  return (
    <>
      {rows.lines.map((row, i) => {
        const gutter = showGutter ? String(row.lineNo).padStart(gutterWidth) : '';
        if (row.kind === 'context') {
          return (
            <ContextLine
              key={i}
              line={row.text}
              gutter={gutter}
              language={lang}
              maxWidth={contentWidth}
            />
          );
        }
        if (row.kind === 'paired') {
          return (
            <PairedLine
              key={i}
              line={row.text}
              other={row.other}
              side={row.side}
              language={lang}
              maxWidth={contentWidth}
              gutter={gutter}
            />
          );
        }
        return (
          <PlainChangeLine
            key={i}
            line={row.text}
            side={row.side}
            language={lang}
            maxWidth={contentWidth}
            gutter={gutter}
          />
        );
      })}
    </>
  );
}

// File content reaches Ink here, and a tab in it is measured as zero columns while the terminal
// draws it eight wide (issue #154). Every changed line is painted with a background padded to
// `maxWidth`, so in a tab-indented file (Go, a Makefile) the block ran seven-plus columns past
// where every other row ended — ragged at best, and off the right edge for the terminal to wrap
// into a stray colored stub at worst. Flatten the tabs before anything measures the line.
//
// Sanitize each line's CONTENT, never its `+ `/`- `/`  ` marker: that prefix is this view's own
// framing, not file content. Running the whole composed line through let the sanitizer's
// trailing-blank trim — free on program output, where a run of spaces is invisible — eat the space
// off an otherwise empty `+ ` line. The marker stopped matching, the row parsed as CONTEXT, and a
// blank added line rendered two columns in and untinted in the middle of a green block (#165).
// Keeping the prefix out of it also puts tab stops where an editor puts them, measured from the
// start of the line rather than two columns into our own gutter.
// Exported for unit tests.
export function sanitizeDiffLines(diff: string): string[] {
  return diff.split('\n').map(line => {
    const marker = line.slice(0, 2);
    return marker === '+ ' || marker === '- ' || marker === '  '
      ? marker + sanitizeTerminalText(line.slice(2))
      : sanitizeTerminalText(line);
  });
}

type DiffBlock =
  | { kind: 'context'; line: string }
  | { kind: 'change'; removed: string[]; added: string[] };

// Group consecutive `-` and `+` lines into change blocks; everything else is context.
// Exported for unit tests.
export function parseDiffBlocks(lines: string[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('- ') || lines[i].startsWith('+ ')) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        removed.push(lines[i].slice(2));
        i++;
      }
      while (i < lines.length && lines[i].startsWith('+ ')) {
        added.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: 'change', removed, added });
    } else {
      blocks.push({ kind: 'context', line: lines[i] });
      i++;
    }
  }
  return blocks;
}

type RenderRow =
  | { kind: 'context'; text: string; lineNo: number }
  | { kind: 'plain'; text: string; side: 'removed' | 'added'; lineNo: number }
  | { kind: 'paired'; text: string; other: string; side: 'removed' | 'added'; lineNo: number };

// Flatten blocks into rows in display order, assigning each a file line number.
// Removed lines advance the old-file counter, added lines the new-file counter,
// context lines both — so the gutter reads like an editor would number the file.
// Exported for unit tests.
export function assignLineNumbers(
  blocks: DiffBlock[],
  startLine: number | undefined,
  oldStartLine: number = startLine ?? 1,
): { lines: RenderRow[]; maxLineNo: number } {
  const lines: RenderRow[] = [];
  let oldNo = oldStartLine;
  let newNo = startLine ?? 1;
  let maxLineNo = 0;
  const note = (n: number) => {
    if (n > maxLineNo) maxLineNo = n;
  };

  for (const block of blocks) {
    if (block.kind === 'context') {
      const text = block.line.startsWith('  ') ? block.line.slice(2) : block.line;
      lines.push({ kind: 'context', text, lineNo: newNo });
      note(newNo);
      oldNo++;
      newNo++;
      continue;
    }
    const pairedCount = Math.min(block.removed.length, block.added.length);
    // Removed lines (paired then leftover) keyed off the old-file counter.
    for (let i = 0; i < block.removed.length; i++) {
      const lineNo = oldNo + i;
      note(lineNo);
      if (i < pairedCount) {
        lines.push({
          kind: 'paired',
          text: block.removed[i],
          other: block.added[i],
          side: 'removed',
          lineNo,
        });
      } else {
        lines.push({ kind: 'plain', text: block.removed[i], side: 'removed', lineNo });
      }
    }
    // Added lines keyed off the new-file counter.
    for (let i = 0; i < block.added.length; i++) {
      const lineNo = newNo + i;
      note(lineNo);
      if (i < pairedCount) {
        lines.push({
          kind: 'paired',
          text: block.added[i],
          other: block.removed[i],
          side: 'added',
          lineNo,
        });
      } else {
        lines.push({ kind: 'plain', text: block.added[i], side: 'added', lineNo });
      }
    }
    oldNo += block.removed.length;
    newNo += block.added.length;
  }
  return { lines, maxLineNo };
}

// Muted dim color for the line-number gutter so it recedes behind the code. On a changed row the
// gutter takes the row's tint too: the number and the line it numbers are one unit, and a tinted
// block starting two columns in from where the numbers sit read as a block with a notch cut out
// of its left edge (#331). Continuation rows blank the number but keep the tint, so a wrapped
// line stays one solid block.
function Gutter({ gutter, bg }: { gutter: string; bg?: string }) {
  if (!gutter) return null;
  return (
    <Text color={bg ? TINTED_GUTTER_FG : theme.muted} backgroundColor={bg}>
      {`${gutter} `}
    </Text>
  );
}

// `theme.muted` is tuned to recede against the terminal's own background (~5:1 on black); on the
// green tint it drops to ~2:1 and the digits stop being readable. Lifted a step on tinted rows
// only — ~3.8:1 on green, ~5.4:1 on red — while staying below the code's default foreground, so
// the numbers still sit behind the line rather than competing with it.
const TINTED_GUTTER_FG = '#b0b0b0';

// Continuation rows sit under the code, past where the `+`/`-` prefix ended, so a wrapped line
// reads as one line and the prefix column stays scannable.
const CONTINUATION = '  ';

// One source line, laid out as however many terminal rows it needs.
//
// A diff row is a Box in ROW direction (gutter + content), and Ink lays those out at their
// children's intrinsic width — it never wraps them. Nearly a fifth of the lines in this repo are
// wider than the diff area at 80 columns, and each one used to run off the edge for the TERMINAL
// to break, at column 0, with the background still painting: a ragged colored stub under an
// otherwise aligned block, a broken border when the diff is inside the approval box, and a line
// Ink counts as one row while the screen spends two (the undercount the live-frame budget can't
// afford). So wrap here, where the widths are known.
//
// wrap-ansi does the breaking because the content is already syntax-highlighted: it re-opens the
// active SGR codes on each row instead of leaving the tail unstyled. `hard` breaks tokens with no
// space in them — a long path or a base64 blob — which is the common case in code.
function WrappedRow({
  content,
  prefix,
  gutter,
  maxWidth,
  bg,
}: {
  content: string;
  prefix: string;
  gutter: string;
  maxWidth: number;
  // Omitted for context lines: only `+`/`-` rows are tinted, and an untinted row needs no padding.
  bg?: string;
}) {
  const rows = wrapAnsi(content, Math.max(1, maxWidth - prefix.length), {
    trim: false,
    hard: true,
  }).split('\n');
  return (
    <>
      {rows.map((row, i) => {
        const lead = i === 0 ? prefix : CONTINUATION;
        return (
          <Box key={i}>
            {/* Blanked, not dropped: the gutter still has to hold its columns or the
                continuation slides left and the code column stops lining up. */}
            <Gutter gutter={i === 0 ? gutter : ' '.repeat(gutter.length)} bg={bg} />
            <Text backgroundColor={bg}>
              {lead}
              {row}
              {bg ? padToWidth(lead + row, maxWidth) : ''}
            </Text>
          </Box>
        );
      })}
    </>
  );
}

// Context lines carry the same syntax highlighting as changed lines so the diff
// reads like an editor view — only the `+`/`-` lines get a tinted background.
function ContextLine({
  line,
  gutter,
  language,
  maxWidth,
}: {
  line: string;
  gutter: string;
  language: string;
  maxWidth: number;
}) {
  return (
    <WrappedRow
      content={highlightCode(line, language)}
      prefix={CONTINUATION}
      gutter={gutter}
      maxWidth={maxWidth}
    />
  );
}

// Dark backgrounds — readable on dark terminals (the syntax palette over a red/green tint).
// Saturation is where these read as red and green rather than as a dull tint (#331); luminance is
// what the pastel foreground needs, so it is held where the previous values had it. The floor is
// the GRAY comment color on the green line, at ~2.2:1 — it recedes, but it stays readable; the
// green string and rose variable colors that sit on the same-hue tints stay above 3:1. GitHub's
// dark-theme tints composite duller than the values these replaced, so they were not the reference.
const REMOVED_BG = '#6b1a22';
const ADDED_BG = '#0f5a2c';
// Brighter variants for the intra-line word-level highlight, so changed words stand out from the
// line's base background. The changed word is painted in the default foreground, bold, not in
// syntax colors, so only white-on-tint contrast binds here.
const REMOVED_HIGHLIGHT_BG = '#a3303a';
const ADDED_HIGHLIGHT_BG = '#1f8a48';

function PlainChangeLine({
  line,
  side,
  language,
  maxWidth,
  gutter,
}: {
  line: string;
  side: 'removed' | 'added';
  language: string;
  maxWidth: number;
  gutter: string;
}) {
  const bg = side === 'added' ? ADDED_BG : REMOVED_BG;
  const prefix = side === 'added' ? '+ ' : '- ';
  return (
    <WrappedRow
      content={highlightCode(line, language)}
      prefix={prefix}
      gutter={gutter}
      maxWidth={maxWidth}
      bg={bg}
    />
  );
}

// Pad with trailing spaces so the line bg spans the full available width even
// for short or empty lines. Returns no padding if content already exceeds width.
//
// Measured in COLUMNS, not characters: a CJK glyph or an emoji in a changed line is two columns
// wide, so counting characters overshot the padding and pushed the background past the edge — the
// same misalignment tabs used to cause, from the other direction.
function padToWidth(text: string, maxWidth: number): string {
  const visible = stringWidth(text);
  return visible < maxWidth ? ' '.repeat(maxWidth - visible) : '';
}

// Minimum ratio of shared content for intra-line highlighting to be useful.
// Below this, the two lines are too different — inverse highlights cover most
// of the line and look noisy. Fall back to plain full-line color.
const INTRA_LINE_SIMILARITY_THRESHOLD = 0.3;
// Word edits past which the search stops and the line is drawn plain. The threshold above is the
// same judgement made after the fact, and Myers is O(D²) in that D: a pair of 20KB lines with
// nothing in common (a minified bundle, a data row) cost 1.3s in the word diff, per row, on the
// TUI thread (#244); capped, 3ms. Nothing that many changed words could highlight is readable.
const INTRA_LINE_MAX_EDITS = 200;

// The word-level segments to paint a paired line with, or null when the pair is better drawn as
// two plain lines: too different to highlight legibly, or too different to be worth finding out.
// Exported for unit tests.
export function intraLineParts(
  oldText: string,
  newText: string,
): ReturnType<typeof diffWordsWithSpace> | null {
  const raw = diffWordsWithSpace(oldText, newText, { maxEditLength: INTRA_LINE_MAX_EDITS });
  if (raw === undefined) return null;
  // Coalesce contiguous same-kind segments so adjacent highlights render as
  // one continuous block (no visual gap between ", " and "Pi" pieces).
  const parts = coalesceParts(raw);
  return isWorthIntraLine(parts, oldText, newText) ? parts : null;
}

// A line that has a counterpart on the other side — render with intra-line
// word-level diff highlighting via jsdiff, IF the lines are similar enough.
function PairedLine({
  line,
  other,
  side,
  language,
  maxWidth,
  gutter,
}: {
  line: string;
  other: string;
  side: 'removed' | 'added';
  language: string;
  maxWidth: number;
  gutter: string;
}) {
  const oldText = side === 'removed' ? line : other;
  const newText = side === 'removed' ? other : line;
  const parts = intraLineParts(oldText, newText);

  if (parts === null) {
    return (
      <PlainChangeLine
        line={line}
        side={side}
        language={language}
        maxWidth={maxWidth}
        gutter={gutter}
      />
    );
  }

  const bg = side === 'added' ? ADDED_BG : REMOVED_BG;
  const highlightBg = side === 'added' ? ADDED_HIGHLIGHT_BG : REMOVED_HIGHLIGHT_BG;
  const prefix = side === 'added' ? '+ ' : '- ';

  // Painted into one string rather than nested <Text> elements: wrapping needs a single run of
  // text to break, and chalk re-opens the outer style after each nested close, so the line's base
  // background survives every highlighted span the same way Ink's own nesting would.
  const painted = parts
    .map(p => {
      // Skip segments that belong only to the other side.
      if (side === 'removed' && p.added) return '';
      if (side === 'added' && p.removed) return '';
      const isChange = side === 'removed' ? p.removed : p.added;
      // Brighter background + bold for the changed portion — stands out against the line's own.
      return isChange ? chalk.bgHex(highlightBg).bold(p.value) : highlightCode(p.value, language);
    })
    .join('');

  return (
    <WrappedRow content={painted} prefix={prefix} gutter={gutter} maxWidth={maxWidth} bg={bg} />
  );
}

function isWorthIntraLine(
  parts: ReturnType<typeof diffWordsWithSpace>,
  oldText: string,
  newText: string,
): boolean {
  const totalMax = Math.max(oldText.length, newText.length);
  if (totalMax === 0) return false;
  const unchanged = parts
    .filter(p => !p.added && !p.removed)
    .reduce((sum, p) => sum + p.value.length, 0);
  return unchanged / totalMax >= INTRA_LINE_SIMILARITY_THRESHOLD;
}

// Merge consecutive segments with the same added/removed kind. jsdiff often
// splits e.g. ", Pi" into two segments (", " + "Pi"); coalescing them lets the
// inverse highlight render as one contiguous block.
function coalesceParts(
  parts: ReturnType<typeof diffWordsWithSpace>,
): ReturnType<typeof diffWordsWithSpace> {
  const out: typeof parts = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && !!last.added === !!p.added && !!last.removed === !!p.removed) {
      out[out.length - 1] = { ...last, value: last.value + p.value };
    } else {
      out.push(p);
    }
  }
  return out;
}

function detectLanguage(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'rb':
      return 'ruby';
    case 'json':
      return 'json';
    case 'md':
      return 'markdown';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'html':
    case 'htm':
      return 'html';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'toml':
      return 'ini';
    default:
      return 'plaintext';
  }
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+ ')) added++;
    else if (line.startsWith('- ')) removed++;
  }
  return { added, removed };
}
