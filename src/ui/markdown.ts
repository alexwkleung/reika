import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { theme } from './theme.js';
import { codeTheme, resolveLanguage } from './highlight.js';

// marked-terminal swaps `:` for this sentinel inside codespans (COLON_REPLACER
// in its source) and restores it in a final pass. See the listitem override.
const COLON_SENTINEL = /\*#COLON\|\*/g;

// Left indent marked-terminal applies to block elements (code, blockquotes,
// lists). We keep it for those but strip it back off code blocks below.
const TAB_WIDTH = 2;

// marked-terminal calls renderer callbacks with multiple args (text, ordered, etc.).
// Passing chalk methods directly causes the extra args to be string-joined onto
// the output (e.g., "item false"). Always wrap callbacks so only `text` is used.
const terminalExtension = markedTerminal(
  {
    codespan: (code: string) => chalk.hex(theme.inlineCode).bold(code),
    heading: (text: string) => chalk.bold(text),
    firstHeading: (text: string) => chalk.bold(text),
    strong: (text: string) => chalk.bold(text),
    em: (text: string) => chalk.italic(text),
    blockquote: (text: string) => chalk.dim(text),
    hr: () => chalk.dim('─'.repeat(40)),
    del: (text: string) => chalk.dim(text),
    // marked-terminal v7 passes raw markdown to listitem without parsing inline
    // tokens (strong, codespan, em, etc.). Re-parse the text so our inline
    // renderers actually run.
    listitem: (text: string) => {
      try {
        const inline = marked.parseInline(text, { async: false });
        const rendered = typeof inline === 'string' ? inline : text;
        // marked-terminal escapes colons inside codespans to a sentinel and
        // unescapes them in a final pass that already ran before this override.
        // Our nested parseInline re-introduces the sentinel, so undo it here or
        // inline-code colons leak as `*#COLON|*`.
        return rendered.replace(COLON_SENTINEL, ':');
      } catch {
        return text;
      }
    },
    // marked-terminal builds every list item with a hardcoded '* ' bullet and
    // relies on its default `list` to renumber/re-bullet and trim. Overriding
    // `list` (to dodge the multi-arg chalk bug) skips all of that, which is why
    // bullets render as a literal '*' and a stray leading blank line creeps in.
    // Replicate the needed bits: trim, number ordered items, and use a real '•'.
    list: (body: string, ordered?: boolean) => {
      const lines = body
        .trim()
        .split('\n')
        .filter(line => line.length > 0);
      if (!ordered) {
        return lines.map(line => line.replace(/^(\s*)\* /, '$1• ')).join('\n');
      }
      let n = 0;
      return lines
        .map(line => (/^\s*\* /.test(line) ? line.replace('* ', `${++n}. `) : line))
        .join('\n');
    },
    paragraph: (text: string) => text,
    // marked-terminal passes (href, title, text) at runtime, but @types/marked-terminal
    // only allows (text) => string. Cast through unknown so we can render the link text.
    link: ((_href: string, _title: string | null, text: string) => chalk.bold(text)) as unknown as (
      s: string,
    ) => string,
    href: (href: string) => chalk.dim(href),
    reflowText: true,
    showSectionPrefix: false,
    tab: TAB_WIDTH,
    // cli-table3 defaults its header cells to red, which is hard to read and
    // reads like an error. Override to a calmer cyan (no bold — bold renders as
    // harsh bright-cyan that clashes with the magenta inline code); grey border.
    tableOptions: { style: { head: ['cyan'], border: ['grey'] } },
    // Wrap at terminal width minus the App's paddingX gutter on both sides.
    // marked-terminal then breaks on word boundaries instead of Ink character-wrapping.
    width: Math.max(40, (process.stdout.columns || 80) - 2),
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

marked.use(terminalExtension as unknown as Parameters<typeof marked.use>[0]);

export function renderMarkdown(content: string): string {
  try {
    const parsed = marked.parse(content, { async: false });
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

// Strip the most common markdown markers without applying any styling. Used for
// reasoning text so it stays in flat muted color (no syntax-highlight escape from
// code blocks). Edge cases like links/tables/fences degrade to the prior literal-text
// behavior — strict improvement, never worse.
export function stripReasoningMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(.+?)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}
