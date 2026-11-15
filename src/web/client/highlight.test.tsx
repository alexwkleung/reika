import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { highlightCode, highlightNodes, parseHljsHtml, sliceNodes } from './highlight.js';

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

describe('sliceNodes', () => {
  const nodes = parseHljsHtml(
    '<span class="hljs-comment">// <span class="hljs-doctag">TODO</span> later</span> x',
  );

  it('keeps the spans around a slice from the middle', () => {
    expect(sliceNodes(nodes, 3, 9)).toEqual([
      {
        className: 'hljs-comment',
        children: [{ className: 'hljs-doctag', children: ['TODO'] }, ' l'],
      },
    ]);
  });

  it('drops spans the slice does not reach, and joins back to the whole text', () => {
    expect(sliceNodes(nodes, 13, 14)).toEqual([' ']);
    const text = (list: ReturnType<typeof sliceNodes>): string =>
      list.map(n => (typeof n === 'string' ? n : text(n.children))).join('');
    const whole = text(nodes);
    expect(
      [0, 4, 11, whole.length].every(
        cut =>
          text(sliceNodes(nodes, 0, cut)) + text(sliceNodes(nodes, cut, whole.length)) === whole,
      ),
    ).toBe(true);
  });

  it('cuts a comment word out of a highlighted line still coloured as comment', () => {
    const line = 'const a = 1; // keep this';
    const cut = sliceNodes(highlightNodes(line, 'typescript'), line.indexOf('keep'), line.length);
    expect(cut).toEqual([{ className: 'hljs-comment', children: ['keep this'] }]);
  });
});
