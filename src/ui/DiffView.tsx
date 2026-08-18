import { Box, Text } from 'ink';
import { diffWordsWithSpace } from 'diff';
import stringWidth from 'string-width';
import { theme } from './theme.js';
import { highlightCode } from './highlight.js';
import { sanitizeTerminalText } from './termtext.js';

export function DiffView({
  diff,
  path,
  maxWidth,
  startLine,
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
}) {
  const lang = detectLanguage(path);
  // File content reaches Ink here, and a tab in it is measured as zero columns while the terminal
  // draws it eight wide (issue #154). Every changed line is painted with a background padded to
  // `maxWidth`, so in a tab-indented file (Go, a Makefile) the block ran seven-plus columns past
  // where every other row ended — ragged at best, and off the right edge for the terminal to wrap
  // into a stray colored stub at worst. Flatten the tabs before anything measures the line.
  const blocks = parseDiffBlocks(sanitizeTerminalText(diff).split('\n'));
  const rows = assignLineNumbers(blocks, startLine);
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
          return <ContextLine key={i} line={row.text} gutter={gutter} language={lang} />;
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
): { lines: RenderRow[]; maxLineNo: number } {
  const lines: RenderRow[] = [];
  let oldNo = startLine ?? 1;
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

// Muted dim color for the line-number gutter so it recedes behind the code.
function Gutter({ gutter }: { gutter: string }) {
  if (!gutter) return null;
  return <Text color={theme.muted}>{`${gutter} `}</Text>;
}

// Context lines carry the same syntax highlighting as changed lines so the diff
// reads like an editor view — only the `+`/`-` lines get a tinted background.
function ContextLine({
  line,
  gutter,
  language,
}: {
  line: string;
  gutter: string;
  language: string;
}) {
  return (
    <Box>
      <Gutter gutter={gutter} />
      <Text>{'  '}</Text>
      <Text>{highlightCode(line, language)}</Text>
    </Box>
  );
}

// Dark backgrounds — readable on dark terminals (default fg over a red/green
// tint). Kept dark enough that the light foreground stays legible, but more
// saturated than a flat muted tint so the green/red reads clearly.
const REMOVED_BG = '#5a1d1d';
const ADDED_BG = '#14532a';
// Brighter variants for the intra-line word-level highlight, so changed words
// stand out from the line's base background.
const REMOVED_HIGHLIGHT_BG = '#8a2a2a';
const ADDED_HIGHLIGHT_BG = '#1f7a42';

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
    <Box>
      <Gutter gutter={gutter} />
      <Text backgroundColor={bg}>
        {prefix}
        {highlightCode(line, language)}
        {padToWidth(prefix + line, maxWidth)}
      </Text>
    </Box>
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
  // Coalesce contiguous same-kind segments so adjacent highlights render as
  // one continuous block (no visual gap between ", " and "Pi" pieces).
  const parts = coalesceParts(diffWordsWithSpace(oldText, newText));

  if (!isWorthIntraLine(parts, oldText, newText)) {
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

  return (
    <Box>
      <Gutter gutter={gutter} />
      <Text backgroundColor={bg}>
        {prefix}
        <Text>
          {parts.map((p, i) => {
            // Skip segments that belong only to the other side.
            if (side === 'removed' && p.added) return null;
            if (side === 'added' && p.removed) return null;
            const isChange = side === 'removed' ? p.removed : p.added;
            if (isChange) {
              // Brighter background + bold for the changed portion — stands out
              // against the line's base background.
              return (
                <Text key={i} bold backgroundColor={highlightBg}>
                  {p.value}
                </Text>
              );
            }
            return <Text key={i}>{highlightCode(p.value, language)}</Text>;
          })}
        </Text>
        {padToWidth(prefix + line, maxWidth)}
      </Text>
    </Box>
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
