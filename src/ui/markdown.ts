import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stripAnsi from 'strip-ansi';
import { supportsHyperlink } from 'supports-hyperlinks';
import wrapAnsi from 'wrap-ansi';
import { theme } from './theme.js';
import { codeTheme, resolveLanguage } from './highlight.js';
import { sanitizeTerminalText } from './termtext.js';
import { contentWidth } from './layout.js';

// marked-terminal swaps `:` for this sentinel inside codespans (COLON_REPLACER
// in its source) and restores it in a final pass. See renderInlineMarkdown.
const COLON_SENTINEL = /\*#COLON\|\*/g;

// Left indent marked-terminal applies to block elements (code, blockquotes,
// lists). We keep it for those but strip it back off code blocks below.
const TAB_WIDTH = 2;

// Columns already spoken for to the left of the block being rendered: a list's tab plus
// marker, a blockquote's bar. The list and blockquote renderers bump it around their body
// parse so the paragraph renderer wraps prose to the width that is actually left, nested
// blocks compounding naturally. A module-level counter is safe because marked.parse is
// synchronous. Before this, marked-terminal reflowed every paragraph at the full width
// and the list then indented it by tab + `7. `, so each full line ran five columns over
// and Ink hard-wrapped the last word onto a line of its own.
let blockIndent = 0;

// The width of the block the render lands in, set per call by renderMarkdown. Read per render,
// not at import, so a pane resized after launch keeps wrapping to its real width. The default is
// the top-level scrollback width; a nested row (a subagent's reply, a compaction note) is four
// columns narrower, and wrapping to the top-level width there left every full line four columns
// over for Ink to re-wrap — the last word of each line on a row of its own, flush left (#431).
let renderWidth = contentWidth();

// Set for a reasoning render, whose styling is stripped afterwards: a clickable link would then be
// its text alone, and in flat grey the URL is the only cue that it was a link at all.
let plainLinks = false;

// OSC 8 as ansi-escapes writes it, optionally inside tmux's DCS passthrough.
const HYPERLINK =
  /(?:\x1bPtmux;\x1b)?\x1b\]8;;([^\x07]*)\x07(?:\x1b\\)?([\s\S]*?)(?:\x1bPtmux;\x1b)?\x1b\]8;;\x07(?:\x1b\\)?/g;

export function unwrapHyperlink(composed: string): string {
  return composed.replace(HYPERLINK, (_, url: string, text: string) => {
    const shown = stripAnsi(text);
    return shown === url ? url : `${shown} (${url})`;
  });
}

function proseWidth(): number {
  return Math.max(20, renderWidth - blockIndent);
}

// marked-terminal's `width` option. Set far past any terminal so its own reflow never
// breaks a line: it still collapses soft newlines and applies its entity/emoji transform,
// and the paragraph override below does the actual wrapping at proseWidth(). Not
// MAX_SAFE_INTEGER: the stock hr renderer allocates an array this long.
const NEVER_REFLOW = 1 << 20;

// marked-terminal calls renderer callbacks with multiple args (text, ordered, etc.).
// Passing chalk methods directly causes the extra args to be string-joined onto
// the output (e.g., "item false"). Always wrap callbacks so only `text` is used.
//
// cli-table3 defaults its header cells to red, which is hard to read and reads like an
// error. Bold white keeps the table itself monochrome so the only color inside it comes
// from inline code (pastel pink); grey border. `colWidths`/`wordWrap` are filled in per
// render by the table override below — cli-table3 mutates the array it is handed, so it is
// replaced (never edited in place) and removed again once the table is drawn.
const tableOptions: {
  style: { head: string[]; border: string[] };
  colWidths?: number[];
  wordWrap?: boolean;
} = { style: { head: ['white', 'bold'], border: ['grey'] } };
const terminalExtension = markedTerminal(
  {
    codespan: (code: string) => chalk.hex(theme.inlineCode)(code),
    heading: (text: string) => chalk.bold(text),
    firstHeading: (text: string) => chalk.bold(text),
    strong: (text: string) => chalk.bold(text),
    em: (text: string) => chalk.italic(text),
    del: (text: string) => chalk.dim(text),
    paragraph: (text: string) => text,
    // marked-terminal composes the whole link first — `text (href)`, or an OSC 8 hyperlink
    // where the terminal supports one — and hands that single string to `link`. A
    // (href, title, text) signature here read the third argument and printed `undefined`.
    link: (composed: string) => (plainLinks ? unwrapHyperlink(composed) : composed),
    // Both a bare URL (GFM autolink) and a `[text](href)` land here; see theme.link. Underlined
    // only where marked-terminal is also wrapping it in an OSC 8 hyperlink — the same check it
    // makes (`supportsHyperlinks.stdout`) — so the underline promises a click exactly when the
    // terminal can deliver one. On such a terminal a `[text](href)` shows only `text`, so this
    // is also the one cue that the word is a link and not a colored word. The function form
    // rather than the cached `.stdout`: it re-reads the env, which is how the tests reach this
    // branch (marked-terminal's own copy is fixed at import, so the tests can't see its OSC 8).
    href: (href: string) => {
      const painted = chalk.hex(theme.link);
      return supportsHyperlink(process.stdout) ? painted.underline(href) : painted(href);
    },
    reflowText: true,
    showSectionPrefix: false,
    tab: TAB_WIDTH,
    tableOptions,
    // See NEVER_REFLOW: line breaking happens in the paragraph override at proseWidth().
    width: NEVER_REFLOW,
    // marked-terminal does its own fenced-code highlighting via cli-highlight and
    // ignores any `code` renderer override; the theme must be supplied through
    // this second `highlightOptions` argument instead.
  },
  // @types/marked-terminal types this arg for the old `cardinal` highlighter,
  // but at runtime marked-terminal forwards it straight to cli-highlight's
  // `highlight()`, which is what actually renders fenced code. Cast past the
  // stale types.
  { theme: codeTheme, ignoreIllegals: true } as unknown as Parameters<typeof markedTerminal>[1],
) as unknown as {
  renderer: Record<string, (...args: unknown[]) => string>;
  useNewRenderer: boolean;
};

// marked-terminal hardcodes a left indent (`this.tab`) on fenced code blocks
// inside its internal `code` renderer, which the options object can't reach.
// Wrap the produced renderer to strip that injected indent back off each line so
// code blocks align flush with paragraphs instead of sitting `TAB_WIDTH` spaces in.
// Also rewrite fence languages highlight.js doesn't know (```astro, ```svelte) to
// plaintext here: highlight.js console.error()s a warning before throwing, which
// Ink folds into the frame as chat spam, and marked-terminal's catch falls back
// to chalk.yellow for the whole block.
const renderCode = terminalExtension.renderer.code;
const stripTabIndent = new RegExp(`^ {${TAB_WIDTH}}`, 'gm');
terminalExtension.renderer.code = function (this: unknown, ...args: unknown[]): string {
  const [token, lang] = args;
  if (token && typeof token === 'object') {
    const t = token as { lang?: string };
    t.lang = resolveLanguage(t.lang);
  } else if (typeof lang === 'string' || lang === undefined) {
    args[1] = resolveLanguage(lang);
  }
  return renderCode.apply(this, args).replace(stripTabIndent, '');
};

// The stock paragraph has already run marked-terminal's transform (entity unescape, emoji,
// colon sentinel) and its reflow, which at NEVER_REFLOW only collapses soft newlines and
// turns hard breaks into real ones. Break lines here, at the width left after enclosing
// blocks. `hard` splits a bare URL longer than the line instead of letting it overflow.
const renderParagraph = terminalExtension.renderer.paragraph;
terminalExtension.renderer.paragraph = function (this: unknown, ...args: unknown[]): string {
  const body = renderParagraph.apply(this, args).replace(/\n+$/, '');
  return wrapAnsi(body, proseWidth(), { hard: true }) + '\n\n';
};

// A renderer override rather than the `hr` option: the stock renderer builds a `width`-long
// string before handing it to that option, which at NEVER_REFLOW is a megabyte per rule.
terminalExtension.renderer.hr = () => chalk.dim('─'.repeat(40)) + '\n\n';

type ListItemToken = {
  task?: boolean;
  checked?: boolean;
  loose?: boolean;
  tokens: { type: string }[];
};
type ListToken = { ordered: boolean; start: number | ''; items: ListItemToken[] };

// Lay lists out here rather than through marked-terminal's list/listitem pair. Its tight
// items go through `text`, which never reflows, so a model that hard-wraps its own prose
// at ~120 columns had those breaks kept verbatim and then pushed two columns right by the
// list tab; on a pane near that width the last word of each line spilled onto its own row.
// Its loose items were reflowed at the full width and then indented (see blockIndent). And
// its nested-list fixup looks for the `*` bullet the old `list` option had already rewritten
// to `•`, so nested bullets glued onto the parent's last line. Each item's `text` tokens are
// parsed as paragraphs, which is what runs the inline renderers (marked-terminal's `text`
// hands the raw markdown through) and the wrapping above; other blocks (nested lists, code,
// quotes) parse as themselves. Continuation lines hang under the item text, and so does a
// nested list: only the outermost list takes the block tab, so a child bullet sits at its
// parent's text column rather than a further tab in.
let listDepth = 0;
const renderList = terminalExtension.renderer.list;
terminalExtension.renderer.list = function (
  this: { parser: { parse(tokens: unknown[]): string } },
  ...args: unknown[]
): string {
  const [token] = args;
  if (!token || typeof token !== 'object' || !('items' in token)) {
    return renderList.apply(this, args);
  }
  const list = token as ListToken;
  const start = typeof list.start === 'number' ? list.start : 1;
  const tab = ' '.repeat(listDepth === 0 ? TAB_WIDTH : 0);
  const out: string[] = [];
  list.items.forEach((item, i) => {
    const marker =
      (list.ordered ? `${start + i}. ` : '• ') +
      (item.task ? (item.checked ? '[x] ' : '[ ] ') : '');
    const hang = ' '.repeat(marker.length);
    const taken = tab.length + marker.length;
    blockIndent += taken;
    listDepth += 1;
    let body: string;
    try {
      body = item.tokens
        .map(t =>
          this.parser
            .parse([t.type === 'text' ? { ...t, type: 'paragraph' } : t])
            .replace(/\n+$/, ''),
        )
        .filter(chunk => chunk.length > 0)
        .join(item.loose ? '\n\n' : '\n');
    } finally {
      blockIndent -= taken;
      listDepth -= 1;
    }
    body.split('\n').forEach((line, j) => {
      if (j === 0) out.push(tab + marker + line);
      else out.push(line.length > 0 ? tab + hang + line : '');
    });
  });
  return out.join('\n') + '\n\n';
};

// marked-terminal renders a blockquote as a dim paragraph sitting `tab` columns in, which
// reads as an indent accident rather than a quote (#353). Draw a left border instead. `│`,
// not the `▎` the chat bubbles use: that glyph is a legend (its color says who is speaking),
// and a quote inside the model's prose makes no such claim. Replacing the renderer rather
// than the `blockquote` option because the stock one `trim()`s the body before indenting,
// which eats the first line's own indent: a list inside a quote came out with its first
// bullet two columns left of the rest. Nested quotes stack: the inner render is `│ text`
// and the outer prefixes it again, landing `│ │ text`. Blank lines between quoted
// paragraphs carry a bare bar so the border is continuous.
const renderBlockquote = terminalExtension.renderer.blockquote;
terminalExtension.renderer.blockquote = function (
  this: { parser: { parse(tokens: unknown): string } },
  ...args: unknown[]
): string {
  const [token] = args;
  let body: string;
  if (token && typeof token === 'object' && 'tokens' in token) {
    blockIndent += 2; // the `│ ` bar
    try {
      body = this.parser.parse((token as { tokens: unknown }).tokens);
    } finally {
      blockIndent -= 2;
    }
  } else if (typeof token === 'string') {
    body = token;
  } else {
    return renderBlockquote.apply(this, args);
  }
  // Styled per call, not at module load: chalk.level is decided after import in tests.
  const bar = chalk.dim('│');
  const lines = body.replace(/^\n+|\n+$/g, '').split('\n');
  return (
    lines.map(line => (line.length > 0 ? `${bar} ${chalk.dim(line)}` : bar)).join('\n') + '\n\n'
  );
};

// marked-terminal hands cli-table3 no width, so a table lays itself out at its natural
// content width and any line past the pane is left for Ink to wrap — which tears the
// borders mid-glyph and leaves the rows ragged (#439). Draw it at the width the block
// actually has instead, wrapping the long prose column inside its own cell.
const renderTable = terminalExtension.renderer.table;
terminalExtension.renderer.table = function (this: unknown, ...args: unknown[]): string {
  const natural = renderTable.apply(this, args);
  const widths = tableColumnWidths(natural);
  const fitted = widths ? fitTableWidths(widths, proseWidth()) : null;
  if (!fitted) return natural;
  tableOptions.colWidths = fitted;
  tableOptions.wordWrap = true;
  try {
    return renderTable.apply(this, args);
  } finally {
    delete tableOptions.colWidths;
    delete tableOptions.wordWrap;
  }
};

// The top border of a drawn table (`┌───┬───┐`) carries cli-table3's resolved column
// widths — one run of `─` per column, each as wide as the column itself — so measuring
// the segments is how the override learns the natural layout without measuring the cells.
function tableColumnWidths(rendered: string): number[] | null {
  const nl = rendered.indexOf('\n');
  const top = stripAnsi(nl === -1 ? rendered : rendered.slice(0, nl));
  if (!top.startsWith('┌') || !top.endsWith('┐')) return null;
  return top
    .slice(1, -1)
    .split('┬')
    .map(segment => segment.length);
}

// Shrink `widths` until the whole table — the cells plus the `n + 1` border columns —
// fits in `avail`, or null when it already does. Water-filling: shave the widest column,
// so a long prose column absorbs the wrap while a narrow key column keeps its natural
// width. cli-table3 wraps on word boundaries and ellipsizes a word longer than its cell.
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

marked.use(terminalExtension as unknown as Parameters<typeof marked.use>[0]);

// `width` is the columns the rendered block has — `contentWidth(indent)` for a scrollback row.
export function renderMarkdown(content: string, width = contentWidth()): string {
  renderWidth = width;
  try {
    // Sanitize the SOURCE, never the output (which carries the highlighter's own escape codes).
    // A model answering about Go or a Makefile emits tab-indented code fences, and marked-terminal
    // passes those tabs straight through. Ink measures a tab as zero columns, so the live block's
    // row budget — the guard that keeps the dynamic frame under the viewport — undercounts every
    // one of those lines, and the terminal expands them to eight columns anyway. Same defect as
    // the bash chip (issue #154), on the path where miscounting rows costs the most.
    const parsed = marked.parse(sanitizeTerminalText(content), { async: false });
    return typeof parsed === 'string' ? parsed.trimEnd() : content;
  } catch {
    return content;
  }
}

// Inline-only rendering for single-line UI rows (the plan checklist): codespans/bold/italic get
// their terminal styling but no block layout runs — no reflow, no wrapping newlines, so the row
// stays one line and Ink's truncation owns the width. Same sentinel caveat as the listitem
// override above. Chalk rewrites inner close codes when nested, so the styled spans return to the
// wrapping Ink <Text> color afterwards instead of resetting to the terminal default.
export function renderInlineMarkdown(text: string): string {
  try {
    const inline = marked.parseInline(text, { async: false });
    return (typeof inline === 'string' ? inline : text).replace(COLON_SENTINEL, ':');
  } catch {
    return text;
  }
}

// Reasoning renders like the reply, then drops the styling: the Thinking block stays flat muted
// text (no highlighter colors from a code fence) but gets the reply's structure — bullets, link
// text, no fence lines. Links keep their URL — see plainLinks.
export function renderReasoningMarkdown(text: string, width: number): string {
  plainLinks = true;
  try {
    return stripAnsi(renderMarkdown(text, width));
  } finally {
    plainLinks = false;
  }
}

// A live stream's last line ends mid-span often: `**the loo` renders as literal asterisks until
// the closer arrives, then they vanish, which reads as the markup parsing in front of the user.
// Holding back an unmatched opener on that line lets the text gain its styling in place instead.
// Live tails only — committed text renders the whole string. Inside an open fence nothing is
// markup, so it is left alone.
export function hideDanglingMarkers(text: string): string {
  const fences = text.match(/^ {0,3}(```|~~~)/gm);
  if (fences && fences.length % 2 === 1) return text;
  const start = text.lastIndexOf('\n') + 1;
  const line = text.slice(start);
  const drop: [number, number][] = [];

  // Past an unclosed backtick is a code span still streaming, so its stars are not markup.
  const ticks = [...line.matchAll(/`/g)].map(m => m.index);
  const openTick = ticks.length % 2 === 1 ? ticks.pop()! : Infinity;
  if (openTick !== Infinity) drop.push([openTick, 1]);
  const inCode = (i: number): boolean => {
    for (let k = 0; k < ticks.length; k += 2) if (i > ticks[k] && i < ticks[k + 1]) return true;
    return i > openTick;
  };

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
