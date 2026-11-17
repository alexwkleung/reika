import { HIDDEN_TOOL_ARGS } from '../../ui/format.js';
import { formatArgs } from '../../ui/scrollbackrules.js';

// How the page draws a tool call and its result: the words in the page's font and the literal they
// act on (a command, a path, a pattern, a URL) as inline code. The TUI prints both in one monospace
// line; here an all-monospace transcript read as a terminal dump. The wording is the TUI's (the
// summary string, the tool label); only which run is code is decided here, and a shape this does
// not know falls back to plain text, never to a guess.

export type Part = { text: string; code?: boolean; muted?: boolean };

// The argument each tool acts on, drawn as the call's literal; the rest print muted after it.
const PRIMARY_ARG: Record<string, string> = {
  bash: 'command',
  read: 'path',
  edit: 'path',
  write: 'path',
  list: 'path',
  grep: 'pattern',
  glob: 'pattern',
  fetch_url: 'url',
  search: 'query',
};

const LITERAL_MAX_CHARS = 120;

// One line of a literal: a heredoc or a multi-line script shows its first line, and the command
// chip under the result shows all of it.
export function literal(text: string): string {
  const lines = text.split('\n');
  const first = lines[0]!;
  const cut =
    first.length > LITERAL_MAX_CHARS ? `${first.slice(0, LITERAL_MAX_CHARS - 1)}…` : first;
  return lines.length > 1 && cut === first ? `${cut} …` : cut;
}

export function callParts(name: string, args: Record<string, unknown>): Part[] {
  const key = PRIMARY_ARG[name];
  const value = key ? args[key] : undefined;
  if (typeof value !== 'string' || HIDDEN_TOOL_ARGS[name]?.has(key!)) {
    const all = formatArgs(name, args);
    return all ? [{ text: all, muted: true }] : [];
  }
  const rest = { ...args };
  delete rest[key!];
  const others = formatArgs(name, rest);
  return [{ text: literal(value), code: true }, ...(others ? [{ text: others, muted: true }] : [])];
}

// Summary shapes, by the tools' own strings: the verb, the literal, then the detail. Each pattern's
// groups are (before, literal, after); `before` is drawn as written but for `Ran: `, whose colon
// only kept a command from reading as a word (scrollbackrules.ts) and code styling does that here.
const SUMMARY_SHAPES: { re: RegExp; before?: string }[] = [
  {
    re: /^(Ran: )([\s\S]*?)( \((?:exit \d+, |killed by \w+, )?[\d,.]+\S* bytes output\))$/,
    before: 'Ran ',
  },
  { re: /^(Read )(\S+)( lines \d+-\d+ of \d+)$/ },
  // A lone read drops its verb (elidedReadSummary): the path opens the row.
  { re: /^()(\S+)( lines \d+-\d+ of \d+)$/ },
  { re: /^(Edited )(\S+)( at line \d+ \(\+\d+ -\d+\))$/ },
  { re: /^(Wrote )(\S+)( \(\+\d+\))$/ },
  { re: /^(Listed \d+\+? entries in )(\S+)(.*)$/ },
  { re: /^(Found \d+\+? matches for )(\/.*\/)(.*)$/ },
  { re: /^(Found \d+\+? file\(s\) matching )(\S+)(.*)$/ },
  { re: /^(Fetched )(\S+)( \(.*\))$/ },
  { re: /^(\w+ declined by user: )([\s\S]+)$/ },
  { re: /^(Bash aborted: )([\s\S]*?)( \(not run\))$/ },
];

export function summaryParts(summary: string): Part[] {
  for (const { re, before } of SUMMARY_SHAPES) {
    const m = re.exec(summary);
    if (!m) continue;
    const parts: Part[] = [];
    const lead = before ?? m[1]!;
    if (lead) parts.push({ text: lead });
    parts.push({ text: literal(m[2]!), code: true });
    if (m[3]) parts.push({ text: m[3], muted: true });
    return parts;
  }
  return [{ text: summary }];
}
