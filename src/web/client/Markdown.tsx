import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import { memo, type ReactNode } from 'react';
import { highlightCode } from './highlight.js';
import './markdown.css';

// Markdown from marked's TOKENS to React elements, never from its HTML output: every string in a
// token reaches the page as text. Raw HTML stays literal, only http(s)/mailto links become anchors,
// and an image is a link to it.

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

// marked leaves entities in text as written; `&amp;` in markdown source means `&`.
function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, e => ENTITIES[e]!);
}

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function safeHref(href: string): string | null {
  try {
    return LINK_SCHEMES.has(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) {
    return (
      <span className="md-link-plain">
        {children}
        {` (${href})`}
      </span>
    );
  }
  return (
    <a className="md-link" href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function inline(tokens: Token[] | undefined, key: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => span(t as MarkedToken, `${key}.${i}`));
}

function span(token: MarkedToken, key: string): ReactNode {
  switch (token.type) {
    case 'text':
      return token.tokens ? <span key={key}>{inline(token.tokens, key)}</span> : decode(token.text);
    case 'escape':
      return token.text;
    case 'strong':
      return <strong key={key}>{inline(token.tokens, key)}</strong>;
    case 'em':
      return <em key={key}>{inline(token.tokens, key)}</em>;
    case 'del':
      return <del key={key}>{inline(token.tokens, key)}</del>;
    case 'codespan':
      return (
        <code key={key} className="md-inline-code">
          {token.text}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'link':
      return (
        <Link key={key} href={token.href}>
          {inline(token.tokens, key)}
        </Link>
      );
    case 'image':
      return (
        <Link key={key} href={token.href}>
          {`[image: ${decode(token.text) || token.href}]`}
        </Link>
      );
    case 'html':
      return token.text;
    default:
      return 'raw' in token ? (token as { raw: string }).raw : '';
  }
}

function listItem(item: Tokens.ListItem, key: string): ReactNode {
  return (
    <li key={key} className={item.task ? 'md-task' : undefined}>
      {item.task ? (
        <span className="md-task-box" aria-label={item.checked ? 'done' : 'not done'}>
          {item.checked ? '[x] ' : '[ ] '}
        </span>
      ) : null}
      {blocks(item.tokens, key, !item.loose)}
    </li>
  );
}

function block(token: MarkedToken, key: string, tight: boolean): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'paragraph':
      return <p key={key}>{inline(token.tokens, key)}</p>;
    case 'text':
      // A tight list item's text: no paragraph margin.
      return tight ? (
        <span key={key}>{token.tokens ? inline(token.tokens, key) : decode(token.text)}</span>
      ) : (
        <p key={key}>{token.tokens ? inline(token.tokens, key) : decode(token.text)}</p>
      );
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, token.depth))}` as 'h1';
      return (
        <Tag key={key} className="md-heading">
          {inline(token.tokens, key)}
        </Tag>
      );
    }
    case 'code':
      return (
        <pre key={key} className="md-code">
          <code>{highlightCode(token.text, token.lang)}</code>
        </pre>
      );
    case 'hr':
      return <hr key={key} className="md-hr" />;
    case 'blockquote':
      return (
        <blockquote key={key} className="md-quote">
          {blocks(token.tokens, key)}
        </blockquote>
      );
    case 'list': {
      const items = token.items.map((item, i) => listItem(item, `${key}.${i}`));
      return token.ordered ? (
        <ol key={key} start={typeof token.start === 'number' ? token.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'table':
      return (
        <div key={key} className="md-table-scroll">
          <table className="md-table">
            <thead>
              <tr>
                {token.header.map((cell, i) => (
                  <th key={i} className={cell.align ? `md-align-${cell.align}` : undefined}>
                    {inline(cell.tokens, `${key}.h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {token.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className={cell.align ? `md-align-${cell.align}` : undefined}>
                      {inline(cell.tokens, `${key}.${r}.${i}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'html':
      return (
        <p key={key} className="md-raw">
          {token.text.trim()}
        </p>
      );
    default:
      return 'raw' in token ? <p key={key}>{(token as { raw: string }).raw}</p> : null;
  }
}

function blocks(tokens: Token[], key: string, tight = false): ReactNode[] {
  return tokens.map((t, i) => block(t as MarkedToken, `${key}.${i}`, tight));
}

function lex(text: string): Token[] | null {
  try {
    return Lexer.lex(text);
  } catch {
    return null;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const tokens = lex(text);
  return <div className="md">{tokens ? blocks(tokens, 'm') : <p>{text}</p>}</div>;
});

// One line of inline markdown (a plan step): code spans and emphasis, no blocks.
export function InlineMarkdown({ text }: { text: string }) {
  try {
    return <>{inline(Lexer.lexInline(text), 'i')}</>;
  } catch {
    return <>{text}</>;
  }
}
