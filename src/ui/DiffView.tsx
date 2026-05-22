import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import { diffWordsWithSpace } from 'diff';
import { theme } from './theme.js';

export function DiffView({
  diff,
  path,
  maxWidth,
}: {
  diff: string;
  path: string;
  // Available cols for diff rendering. Used to pad changed-line backgrounds to
  // full width without overflowing. Caller knows its own container offset.
  maxWidth: number;
}) {
  const lang = detectLanguage(path);
  const blocks = parseDiffBlocks(diff.split('\n'));
  return (
    <>
      {blocks.flatMap((block, bi) => {
        if (block.kind === 'context') {
          return [<ContextLine key={`c${bi}`} line={block.line} />];
        }
        return renderChangeBlock(block.removed, block.added, lang, bi, maxWidth);
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

function renderChangeBlock(
  removed: string[],
  added: string[],
  language: string,
  bi: number,
  maxWidth: number,
): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  const pairedCount = Math.min(removed.length, added.length);
  // Paired lines get word-level intra-line highlighting.
  for (let i = 0; i < pairedCount; i++) {
    out.push(
      <PairedLine
        key={`r${bi}-${i}`}
        line={removed[i]}
        other={added[i]}
        side="removed"
        language={language}
        maxWidth={maxWidth}
      />,
    );
  }
  // Leftover removed lines (no matching added): plain full-line red.
  for (let i = pairedCount; i < removed.length; i++) {
    out.push(
      <PlainChangeLine
        key={`r${bi}-${i}`}
        line={removed[i]}
        side="removed"
        language={language}
        maxWidth={maxWidth}
      />,
    );
  }
  // Paired added lines.
  for (let i = 0; i < pairedCount; i++) {
    out.push(
      <PairedLine
        key={`a${bi}-${i}`}
        line={added[i]}
        other={removed[i]}
        side="added"
        language={language}
        maxWidth={maxWidth}
      />,
    );
  }
  // Leftover added lines (write tool or net new lines).
  for (let i = pairedCount; i < added.length; i++) {
    out.push(
      <PlainChangeLine
        key={`a${bi}-${i}`}
        line={added[i]}
        side="added"
        language={language}
        maxWidth={maxWidth}
      />,
    );
  }
  return out;
}

function ContextLine({ line }: { line: string }) {
  const code = line.startsWith('  ') ? line.slice(2) : line;
  return (
    <Box>
      <Text>{'  '}</Text>
      <Text color={theme.muted}>{code}</Text>
    </Box>
  );
}

// Muted dark backgrounds — readable on dark terminals (default fg over a dim
// red/green tint). Standard ANSI `red`/`green` bgs are too saturated and obscure
// the text. Values tuned similar to GitHub's dark-theme diff line backgrounds.
const REMOVED_BG = '#3a1f1f';
const ADDED_BG = '#1f3a26';
// Slightly brighter variants for the intra-line word-level highlight, so changed
// words stand out from the line's base background.
const REMOVED_HIGHLIGHT_BG = '#6a2828';
const ADDED_HIGHLIGHT_BG = '#2e6a3c';

function PlainChangeLine({
  line,
  side,
  language,
  maxWidth,
}: {
  line: string;
  side: 'removed' | 'added';
  language: string;
  maxWidth: number;
}) {
  const bg = side === 'added' ? ADDED_BG : REMOVED_BG;
  const prefix = side === 'added' ? '+ ' : '- ';
  return (
    <Text backgroundColor={bg}>
      {prefix}
      {safeHighlight(line, language)}
      {padToWidth(prefix.length + line.length, maxWidth)}
    </Text>
  );
}

// Pad with trailing spaces so the line bg spans the full available width even
// for short or empty lines. Returns no padding if content already exceeds width.
function padToWidth(visibleLen: number, maxWidth: number): string {
  return visibleLen < maxWidth ? ' '.repeat(maxWidth - visibleLen) : '';
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
}: {
  line: string;
  other: string;
  side: 'removed' | 'added';
  language: string;
  maxWidth: number;
}) {
  const oldText = side === 'removed' ? line : other;
  const newText = side === 'removed' ? other : line;
  // Coalesce contiguous same-kind segments so adjacent highlights render as
  // one continuous block (no visual gap between ", " and "Pi" pieces).
  const parts = coalesceParts(diffWordsWithSpace(oldText, newText));

  if (!isWorthIntraLine(parts, oldText, newText)) {
    return <PlainChangeLine line={line} side={side} language={language} maxWidth={maxWidth} />;
  }

  const bg = side === 'added' ? ADDED_BG : REMOVED_BG;
  const highlightBg = side === 'added' ? ADDED_HIGHLIGHT_BG : REMOVED_HIGHLIGHT_BG;
  const prefix = side === 'added' ? '+ ' : '- ';

  return (
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
          return <Text key={i}>{safeHighlight(p.value, language)}</Text>;
        })}
      </Text>
      {padToWidth(prefix.length + line.length, maxWidth)}
    </Text>
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

function safeHighlight(code: string, language: string): string {
  if (!code.trim()) return code;
  try {
    return highlight(code, { language, ignoreIllegals: true });
  } catch {
    return code;
  }
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
