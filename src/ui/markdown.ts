import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// marked-terminal calls renderer callbacks with multiple args (text, ordered, etc.).
// Passing chalk methods directly causes the extra args to be string-joined onto
// the output (e.g., "item false"). Always wrap callbacks so only `text` is used.
marked.use(
  markedTerminal({
    code: (code: string, lang?: string) => {
      try {
        return highlight(code, {
          language: lang || 'plaintext',
          ignoreIllegals: true,
        });
      } catch {
        return code;
      }
    },
    codespan: (code: string) => chalk.bold(code),
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
        return typeof inline === 'string' ? inline : text;
      } catch {
        return text;
      }
    },
    list: (body: string) => body,
    paragraph: (text: string) => text,
    // marked-terminal passes (href, title, text) at runtime, but @types/marked-terminal
    // only allows (text) => string. Cast through unknown so we can render the link text.
    link: ((_href: string, _title: string | null, text: string) => chalk.bold(text)) as unknown as (
      s: string,
    ) => string,
    href: (href: string) => chalk.dim(href),
    reflowText: true,
    showSectionPrefix: false,
    tab: 2,
    // Wrap at terminal width minus the App's paddingX gutter on both sides.
    // marked-terminal then breaks on word boundaries instead of Ink character-wrapping.
    width: Math.max(40, (process.stdout.columns || 80) - 2),
  }) as Parameters<typeof marked.use>[0],
);

export function renderMarkdown(content: string): string {
  try {
    const parsed = marked.parse(content, { async: false });
    return typeof parsed === 'string' ? parsed.trimEnd() : content;
  } catch {
    return content;
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
