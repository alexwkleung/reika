import hljs from 'highlight.js/lib/common';
import type { ReactNode } from 'react';

// highlight.js hands back an HTML string. It never reaches the DOM as HTML: this parser accepts
// only the three shapes highlight.js emits (`<span class="hljs-…">`, `</span>`, entity-escaped
// text) and turns anything else into literal text, so a hostile code fence stays text.

export type HljsNode = string | { className: string; children: HljsNode[] };

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, e => ENTITIES[e]!);
}

// `hljs-keyword`, the scope suffixes highlight.js 11 adds (`hljs-title function_`), and the
// `language-css` wrapper around an embedded language.
const CLASS_WORD = '(?:hljs-[a-z0-9_-]+|language-[a-z0-9_-]+|[a-z0-9_-]*_)';
const OPEN_SPAN = new RegExp(`^<span class="(${CLASS_WORD}(?: ${CLASS_WORD})*)">`);
const CLOSE_SPAN = '</span>';

export function parseHljsHtml(html: string): HljsNode[] {
  const root: HljsNode[] = [];
  const stack: { className: string; children: HljsNode[] }[] = [];
  const children = (): HljsNode[] => stack.at(-1)?.children ?? root;
  const pushText = (text: string): void => {
    if (!text) return;
    const list = children();
    const last = list.at(-1);
    if (typeof last === 'string') list[list.length - 1] = last + text;
    else list.push(text);
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(decodeEntities(html.slice(i)));
      break;
    }
    pushText(decodeEntities(html.slice(i, lt)));
    const rest = html.slice(lt);
    const open = OPEN_SPAN.exec(rest);
    if (open) {
      const node = { className: open[1]!, children: [] };
      children().push(node);
      stack.push(node);
      i = lt + open[0].length;
    } else if (rest.startsWith(CLOSE_SPAN) && stack.length > 0) {
      stack.pop();
      i = lt + CLOSE_SPAN.length;
    } else {
      // Not a tag highlight.js writes: the `<` is text, and so is what follows it.
      pushText('<');
      i = lt + 1;
    }
  }
  return root;
}

function toReact(nodes: HljsNode[], key = ''): ReactNode[] {
  return nodes.map((node, i) =>
    typeof node === 'string' ? (
      node
    ) : (
      <span key={`${key}${i}`} className={node.className}>
        {toReact(node.children, `${key}${i}.`)}
      </span>
    ),
  );
}

// Plain text for a language highlight.js does not know, as the TUI does.
export function highlightCode(code: string, language: string | undefined): ReactNode[] {
  const lang = language?.split(/\s/)[0]?.toLowerCase();
  if (!lang || !hljs.getLanguage(lang)) return [code];
  try {
    return toReact(
      parseHljsHtml(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value),
    );
  } catch {
    return [code];
  }
}
