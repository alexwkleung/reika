import chalk from 'chalk';
import { highlight } from 'cli-highlight';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

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
    codespan: chalk.bold,
    heading: chalk.bold,
    firstHeading: chalk.bold,
    strong: chalk.bold,
    em: chalk.italic,
    blockquote: chalk.dim,
    hr: chalk.dim,
    listitem: chalk.reset,
    list: chalk.reset,
    paragraph: chalk.reset,
    del: chalk.dim,
    link: chalk.bold,
    href: chalk.dim,
    reflowText: false,
    showSectionPrefix: false,
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
