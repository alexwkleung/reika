import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { highlightCode, parseHljsHtml } from './highlight.js';

const markup = (code: string, lang?: string) =>
  renderToStaticMarkup(<code>{highlightCode(code, lang)}</code>);

describe('parseHljsHtml', () => {
  it('reads spans, nested spans and entity-escaped text', () => {
    expect(
      parseHljsHtml(
        '<span class="hljs-keyword">const</span> a = <span class="hljs-title function_">f</span>(&lt;b&gt; &amp; &quot;c&quot; &#x27;d&#x27;)',
      ),
    ).toEqual([
      { className: 'hljs-keyword', children: ['const'] },
      ' a = ',
      { className: 'hljs-title function_', children: ['f'] },
      '(<b> & "c" \'d\')',
    ]);
    expect(parseHljsHtml('<span class="hljs-a"><span class="hljs-b">x</span>y</span>')).toEqual([
      { className: 'hljs-a', children: [{ className: 'hljs-b', children: ['x'] }, 'y'] },
    ]);
  });

  it('turns any other tag into literal text', () => {
    for (const hostile of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<span class="hljs-a" onclick="x">y</span>',
      '<span class="evil">y</span>',
      "<span class='hljs-a'>y</span>",
      '<span class="hljs-a"style="x">y</span>',
      '<SPAN class="hljs-a">y</SPAN>',
    ]) {
      const nodes = parseHljsHtml(hostile);
      expect(nodes.every(n => typeof n === 'string')).toBe(true);
      expect(nodes.join('')).toContain('<');
    }
  });

  it('leaves an unknown entity as written and a stray close tag as text', () => {
    expect(parseHljsHtml('&nbsp;&#60;')).toEqual(['&nbsp;&#60;']);
    expect(parseHljsHtml('a</span>b')).toEqual(['a</span>b']);
  });

  it('keeps text after an unclosed span inside it', () => {
    expect(parseHljsHtml('<span class="hljs-a">x')).toEqual([
      { className: 'hljs-a', children: ['x'] },
    ]);
  });
});

describe('highlightCode', () => {
  it('highlights a known language into hljs spans', () => {
    const html = markup('const x = 1;', 'js');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it('renders an unknown or missing language as plain escaped text', () => {
    expect(markup('<b>x</b>', 'nosuchlang')).toBe('<code>&lt;b&gt;x&lt;/b&gt;</code>');
    expect(markup('a < b')).toBe('<code>a &lt; b</code>');
  });

  it('a hostile fence stays text in the output', () => {
    const html = markup('"<script>alert(1)</script>"', 'html');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<span class="hljs-name">script</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;');
  });
});
