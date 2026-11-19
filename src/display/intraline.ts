import { diffWordsWithSpace } from 'diff';

// Which paired diff lines get word-level highlighting, and what language a path is drawn in. Ink-
// and chalk-free, so the browser client (src/web/client/DiffView.tsx) pairs lines by the TUI's rule.

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

export function detectLanguage(path: string): string {
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
