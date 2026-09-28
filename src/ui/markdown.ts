import chalk from 'chalk';
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { supportsHyperlink } from 'supports-hyperlinks';
import wrapAnsi from 'wrap-ansi';
import { theme, themeChalk } from './theme.js';
import { highlightCode } from './highlight.js';
import { sanitizeTerminalText } from './termtext.js';
import { contentWidth } from './layout.js';

// marked only parses here: the terminal rendering is ours, a walk over its token tree. Each block
// renders at the width it actually has — `width` shrinks by a list's tab and marker or a quote's
// bar on the way down — so prose wraps where it will be drawn and Ink never re-wraps a line whose
// last word then lands on a row of its own (#431). A marked-terminal renderer did this through
// module-level counters bumped around each nested parse, and fought its own reflow to do it.
type Ctx = {
  width: number;
  listDepth: number;
  // Set for a reasoning render, whose styling is stripped afterwards: a clickable link would then
  // be its text alone, and in flat grey the URL is the only cue that it was a link at all.
  plainLinks: boolean;
};

// Left indent of a top-level list.
const TAB_WIDTH = 2;

// Narrowest a nested block wraps at, however deep it sits: below this a line holds a word or two.
const MIN_PROSE_WIDTH = 20;

function proseWidth(ctx: Ctx): number {
  return Math.max(MIN_PROSE_WIDTH, ctx.width);
}

// `hard` splits a bare URL longer than the line instead of letting it overflow.
function wrapProse(text: string, ctx: Ctx): string {
  return wrapAnsi(text, proseWidth(ctx), { hard: true });
}

function renderBlocks(tokens: Token[], ctx: Ctx): string {
  return tokens
    .map(token => renderBlock(token as MarkedToken, ctx))
    .filter(chunk => chunk.length > 0)
    .join('\n\n');
}

function renderBlock(token: MarkedToken, ctx: Ctx): string {
  switch (token.type) {
    case 'paragraph':
      return wrapProse(renderInline(token.tokens, ctx), ctx);
    // A tight list item's body: a paragraph in all but name.
    case 'text':
      return wrapProse(token.tokens ? renderInline(token.tokens, ctx) : decode(token.text), ctx);
    case 'heading':
      return wrapProse(chalk.bold(renderInline(token.tokens, ctx)), ctx);
    // Flush with the prose, no fence lines. The info string's first word is the language: a
    // ```ts title="x" fence is TypeScript, not an unknown language.
    case 'code':
      return highlightCode(token.text, token.lang?.split(/\s/)[0] ?? '');
    case 'hr':
      return chalk.dim('─'.repeat(Math.min(40, proseWidth(ctx))));
    case 'blockquote':
      return renderBlockquote(token, ctx);
    case 'list':
      return renderList(token, ctx);
    case 'table':
      return renderTable(token, ctx);
    case 'html':
      return chalk.dim(token.text.trim());
    default:
      return '';
  }
}

// Only outermost list takes the block tab, so a child bullet sits at its parent's text column
// rather than a further tab in. Continuation lines hang under the item text. A tight item's `text`
// renders as a paragraph so it reflows: a model that hard-wraps its own prose at ~120 columns
// otherwise had those breaks kept and then pushed right by the marker, the last word of each line
// spilling onto its own row on a pane near that width.
function renderList(list: Tokens.List, ctx: Ctx): string {
  const start = typeof list.start === 'number' ? list.start : 1;
  const tab = ' '.repeat(ctx.listDepth === 0 ? TAB_WIDTH : 0);
  const out: string[] = [];
  list.items.forEach((item, i) => {
    const marker =
      (list.ordered ? `${start + i}. ` : '• ') +
      (item.task ? (item.checked ? '[x] ' : '[ ] ') : '');
    const hang = ' '.repeat(marker.length);
    const inner = {
      ...ctx,
      width: ctx.width - tab.length - marker.length,
      listDepth: ctx.listDepth + 1,
    };
    const body = item.tokens
      .map(token => renderBlock(token as MarkedToken, inner))
      .filter(chunk => chunk.length > 0)
      .join(item.loose ? '\n\n' : '\n');
    body.split('\n').forEach((line, j) => {
      if (j === 0) out.push(tab + marker + line);
      else out.push(line.length > 0 ? tab + hang + line : '');
    });
  });
  return out.join('\n');
}

// A left border rather than an indent, which read as a layout accident (#353). `│`, not the `▎`
// the chat bubbles use: that glyph is a legend (its color says who is speaking), and a quote
// inside the model's prose makes no such claim. Nested quotes stack (`│ │ text`), and blank lines
// between quoted paragraphs carry a bare bar so the border is continuous.
function renderBlockquote(quote: Tokens.Blockquote, ctx: Ctx): string {
  const body = renderBlocks(quote.tokens, { ...ctx, width: ctx.width - 2 });
  const bar = chalk.dim('│');
  return body
    .split('\n')
    .map(line => (line.length > 0 ? `${bar} ${chalk.dim(line)}` : bar))
    .join('\n');
}

// Drawn at the width the block has, wrapping the long prose column inside its own cell: a table
// left at its natural width past the pane was wrapped by Ink, which tore the borders mid-glyph and
// left the rows ragged (#439). Header bold, never colored, so the only color inside a table is
// inline code; muted borders; a rule between every row, since a wrapped cell otherwise runs into
// the next row's.
function renderTable(table: Tokens.Table, ctx: Ctx): string {
  const cells = (row: Tokens.TableCell[]) => row.map(cell => renderInline(cell.tokens, ctx));
  const header = cells(table.header);
  const rows = table.rows.map(cells);
  const natural = header.map(
    (_, col) => Math.max(...[header, ...rows].map(row => maxLineWidth(row[col] ?? ''))) + 2, // padding
  );
  const widths = fitTableWidths(natural, proseWidth(ctx)) ?? natural;
  const border = themeChalk(theme.muted);
  const rule = (left: string, mid: string, right: string) =>
    border(left + widths.map(w => '─'.repeat(w)).join(mid) + right);
  const drawRow = (row: string[], paint: (s: string) => string) => {
    const wrapped = widths.map((w, col) =>
      wrapAnsi(row[col] ?? '', Math.max(1, w - 2), { hard: true }).split('\n'),
    );
    const height = Math.max(...wrapped.map(lines => lines.length));
    const lines: string[] = [];
    for (let r = 0; r < height; r++) {
      const line = widths.map((w, col) => {
        const text = wrapped[col][r] ?? '';
        return ' ' + paint(align(text, w - 2, table.align[col])) + ' ';
      });
      lines.push(border('│') + line.join(border('│')) + border('│'));
    }
    return lines.join('\n');
  };
  const head = (s: string) => chalk.bold.white(s);
  const body = rows.map(row => drawRow(row, s => s));
  return [
    rule('┌', '┬', '┐'),
    drawRow(header, head),
    ...body.flatMap(row => [rule('├', '┼', '┤'), row]),
    rule('└', '┴', '┘'),
  ].join('\n');
}

function maxLineWidth(text: string): number {
  return Math.max(0, ...text.split('\n').map(line => stringWidth(line)));
}

function align(text: string, width: number, how: 'center' | 'left' | 'right' | null): string {
  const gap = Math.max(0, width - stringWidth(text));
  if (how === 'right') return ' '.repeat(gap) + text;
  if (how === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

// Shrink `widths` until the whole table — the cells plus the `n + 1` border columns —
// fits in `avail`, or null when it already does. Water-filling: shave the widest column,
// so a long prose column absorbs the wrap while a narrow key column keeps its natural
// width.
function fitTableWidths(widths: number[], avail: number): number[] | null {
  const n = widths.length;
  if (widths.reduce((a, b) => a + b, 0) + n + 1 <= avail) return null;
  const budget = avail - (n + 1);
  // A column needs its two padding columns plus one content column; below that, take the
  // widest floor the budget still allows so a pathologically wide table still fits.
  const floor = Math.max(1, Math.min(3, Math.floor(budget / n)));
  const fitted = widths.slice();
  let sum = fitted.reduce((a, b) => a + b, 0);
  while (sum > budget) {
    let widest = 0;
    for (let i = 1; i < n; i++) if (fitted[i] > fitted[widest]) widest = i;
    if (fitted[widest] <= floor) break;
    fitted[widest] -= 1;
    sum -= 1;
  }
  return fitted;
}

function renderInline(tokens: Token[], ctx: Ctx): string {
  return tokens.map(token => renderSpan(token as MarkedToken, ctx)).join('');
}

function renderSpan(token: MarkedToken, ctx: Ctx): string {
  switch (token.type) {
    // A soft line break is a space: prose reflows at the block's width, not the model's.
    case 'text':
      return token.tokens
        ? renderInline(token.tokens, ctx)
        : decode(token.text).replace(/[ \t\n]+/g, ' ');
    case 'escape':
      return token.text;
    case 'strong':
      return chalk.bold(renderInline(token.tokens, ctx));
    case 'em':
      return chalk.italic(renderInline(token.tokens, ctx));
    case 'del':
      return chalk.dim(renderInline(token.tokens, ctx));
    case 'codespan':
      return themeChalk(theme.inlineCode)(token.text.replace(/\n/g, ' '));
    case 'br':
      return '\n';
    case 'link':
      return renderLink(token.href, renderInline(token.tokens, ctx), ctx);
    case 'image':
      return renderLink(token.href, decode(token.text), ctx);
    case 'html':
      return chalk.dim(token.text);
    default:
      return 'raw' in token ? token.raw : '';
  }
}

// Both a bare URL (GFM autolink) and a `[text](href)` land here; see theme.link. Where the
// terminal takes OSC 8 hyperlinks a `[text](href)` shows only `text`, underlined — the underline
// promises a click exactly when the terminal can deliver one, and is the one cue that the word is
// a link and not a colored word. Elsewhere the URL follows in parentheses. The function form of
// the check rather than the cached `.stdout`: it re-reads the env, so FORCE_HYPERLINK reaches it.
function renderLink(href: string, text: string, ctx: Ctx): string {
  const paint = themeChalk(theme.link);
  if (!ctx.plainLinks && supportsHyperlink(process.stdout)) {
    return `\x1b]8;;${href}\x07${paint.underline(text || href)}\x1b]8;;\x07`;
  }
  const shown = stripAnsi(text);
  return shown && shown !== href ? `${text} (${paint(href)})` : paint(href);
}

// marked leaves entities in text as written; `&amp;` in markdown source means `&`.
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]);
}

// `width` is the columns the rendered block has — `contentWidth(indent)` for a scrollback row.
// Read per call, not at import, so a pane resized after launch keeps wrapping to its real width.
export function renderMarkdown(content: string, width = contentWidth()): string {
  return renderDocument(content, { width, listDepth: 0, plainLinks: false });
}

function renderDocument(content: string, ctx: Ctx): string {
  try {
    // Sanitize the SOURCE, never the output (which carries the highlighter's own escape codes).
    // A model answering about Go or a Makefile emits tab-indented code fences; Ink measures a tab
    // as zero columns, so the live block's row budget — the guard that keeps the dynamic frame
    // under the viewport — undercounts every one of those lines, and the terminal expands them to
    // eight columns anyway. Same defect as the bash chip (issue #154).
    return renderBlocks(Lexer.lex(sanitizeMarkdownSource(content)), ctx).trimEnd();
  } catch {
    return content;
  }
}

// sanitizeTerminalText drops trailing spaces, which carry width and show nothing — and are also
// markdown's two-space hard line break. Put the marker back on the lines that had one. The two
// line lists pair up: sanitizing splits on the same `\n` after the same `\r\n` fold.
function sanitizeMarkdownSource(content: string): string {
  const source = content.replace(/\r\n/g, '\n').split('\n');
  return sanitizeTerminalText(content)
    .split('\n')
    .map((line, i) => (line.length > 0 && /\S {2,}$/.test(source[i] ?? '') ? `${line}  ` : line))
    .join('\n');
}

// Inline-only rendering for single-line UI rows (the plan checklist): codespans/bold/italic get
// their terminal styling but no block layout runs — no wrapping, so the row stays one line and
// Ink's truncation owns the width. Chalk rewrites inner close codes when nested, so the styled
// spans return to the wrapping Ink <Text> color afterwards instead of resetting to the default.
export function renderInlineMarkdown(text: string): string {
  try {
    return renderInline(Lexer.lexInline(text), {
      width: Infinity,
      listDepth: 0,
      plainLinks: false,
    });
  } catch {
    return text;
  }
}

// Reasoning renders like the reply, then drops the styling: the Thinking block stays flat muted
// text (no highlighter colors from a code fence) but gets the reply's structure — bullets, link
// text, no fence lines. Links keep their URL.
export function renderReasoningMarkdown(text: string, width: number): string {
  return stripAnsi(renderDocument(text, { width, listDepth: 0, plainLinks: true }));
}

// A live stream's last line ends mid-span often: `**the loo` renders as literal asterisks until
// the closer arrives, then they vanish, which reads as the markup parsing in front of the user.
// Holding back an unmatched opener on that line lets the text gain its styling in place instead.
// Live tails only — committed text renders the whole string. Inside an open fence nothing is
// markup, so it is left alone.
export function hideDanglingMarkers(text: string): string {
  const start = text.lastIndexOf('\n') + 1;
  const line = text.slice(start);
  // A fence line still arriving — `` ` ``, ` `` `, ```` ```ts ```` — shows as literal backticks
  // (an opener) or an extra code row (a closer) until its newline. Hidden whole until then.
  if (/^ {0,3}(`|`{2,}[^`]*|~{3,}.*)$/.test(line)) return text.slice(0, start);
  const fences = text.slice(0, start).match(/^ {0,3}(```|~~~)/gm);
  if (fences && fences.length % 2 === 1) return text;
  const drop: [number, number][] = [];

  // A code span closes on a backtick run of its opener's length. Past an unclosed opener is a
  // span still streaming, so its stars are not markup.
  const runs = [...line.matchAll(/`+/g)].map(m => ({ i: m.index, n: m[0].length }));
  const spans: [number, number][] = [];
  let openTick = Infinity;
  for (let k = 0; k < runs.length; k++) {
    const close = runs.findIndex((r, j) => j > k && r.n === runs[k].n);
    if (close === -1) {
      openTick = runs[k].i;
      drop.push([openTick, runs[k].n]);
      break;
    }
    spans.push([runs[k].i, runs[close].i]);
    k = close;
  }
  const inCode = (i: number): boolean => spans.some(([a, b]) => i > a && i < b) || i > openTick;

  const strong = [...line.matchAll(/\*\*/g)].map(m => m.index).filter(i => !inCode(i));
  if (strong.length % 2 === 1) drop.push([strong.at(-1)!, 2]);

  // A single `*` counts only with text on at least one side: `2 * 3` is arithmetic and a line
  // opening `* ` is a list marker. Only an opener-shaped last one is held back.
  const em = [...line.matchAll(/(?<!\*)\*(?!\*)/g)]
    .map(m => m.index)
    .filter(i => !inCode(i))
    .filter(i => !(line.slice(0, i).trim() === '' && line[i + 1] === ' '))
    .filter(i => /\S/.test(line[i - 1] ?? ' ') || /\S/.test(line[i + 1] ?? ' '));
  const lastEm = em.at(-1);
  if (em.length % 2 === 1 && lastEm !== undefined && /\S/.test(line[lastEm + 1] ?? ' ')) {
    drop.push([lastEm, 1]);
  }

  // A trailing `*` or `**` after a space is the first half of something not yet streamed.
  const tail = /(^|\s)(\*{1,2})$/.exec(line);
  if (tail) {
    const at = line.length - tail[2].length;
    if (!drop.some(([i]) => i === at || i === at - 1)) drop.push([at, tail[2].length]);
  }

  let out = line;
  for (const [i, len] of drop.sort((a, b) => b[0] - a[0]))
    out = out.slice(0, i) + out.slice(i + len);
  // A link whose URL is still arriving shows as `[text](https://ex` until the `)`; its text alone
  // is what it renders to. After a space only, so `arr[i` stays an index.
  out = out.replace(/(^|\s)\[([^\]]*)(\](\([^)]*)?)?$/, '$1$2');
  return out === line ? text : text.slice(0, start) + out;
}
