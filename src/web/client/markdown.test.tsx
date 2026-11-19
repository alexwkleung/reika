import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineMarkdown, Markdown, safeHref } from './Markdown.js';

const md = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders headings, emphasis, inline code, hr and quotes', () => {
    const html = md('# Title\n\nSome *em*, **strong**, ~~gone~~ and `a<b>`.\n\n---\n\n> quoted');
    expect(html).toContain('<h1 class="md-heading">Title</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<del>gone</del>');
    expect(html).toContain('<code class="md-inline-code">a&lt;b&gt;</code>');
    expect(html).toContain('<hr class="md-hr"/>');
    expect(html).toContain('<blockquote class="md-quote"><p>quoted</p></blockquote>');
  });

  it('renders ordered, nested and task lists', () => {
    const html = md('3. three\n4. four\n   - inner\n\n- [x] done\n- [ ] todo');
    expect(html).toContain('<ol start="3">');
    expect(html).toMatch(/<li><span>four<\/span><ul><li><span>inner<\/span><\/li><\/ul><\/li>/);
    expect(html).toContain(
      '<li class="md-task"><span class="md-task-box" aria-label="done">[x] </span>',
    );
    expect(html).toContain('aria-label="not done">[ ] </span>');
  });

  it('renders a table inside its own scroll box', () => {
    const html = md('| a | b |\n|---|--:|\n| 1 | 2 |');
    expect(html).toContain('<div class="md-table-scroll"><table class="md-table">');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td class="md-align-right">2</td>');
  });

  it('renders a fenced block highlighted, and an unknown language as plain text', () => {
    expect(md('```ts\nconst x = 1;\n```')).toContain('<span class="hljs-keyword">const</span>');
    expect(md('```nosuchlang\n<b>x</b>\n```')).toContain(
      '<pre class="md-code"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>',
    );
  });

  it('decodes the entities markdown source writes', () => {
    expect(md('a &amp; b')).toContain('<p>a &amp; b</p>');
  });

  it('opens http(s) and mailto links in a new tab, without opener or referrer', () => {
    const html = md('[docs](https://example.com/d) and <mailto:octocat@example.com>');
    expect(html).toContain(
      '<a class="md-link" href="https://example.com/d" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(html).toContain('href="mailto:octocat@example.com"');
  });
});

describe('Markdown: hostile input', () => {
  it('raw HTML blocks and inline tags stay literal text', () => {
    const html = md('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> there');
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('a javascript: or data: link is plain text showing the URL', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      '/relative',
    ]) {
      const html = md(`[click](${href})`);
      expect(html).not.toContain('<a ');
      expect(html).toContain('md-link-plain');
      expect(html).toContain('click');
    }
  });

  it('an image is a link with its alt text, never an <img>', () => {
    const html = md('![a cat](https://example.com/cat.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.com/cat.png"');
    expect(html).toContain('[image: a cat]');
    expect(md('![x](javascript:alert(1))')).not.toContain('<a ');
  });

  it('HTML in a table cell stays text', () => {
    const html = md('| a |\n|---|\n| <b onclick="x">y</b> |');
    expect(html).not.toContain('<b ');
    expect(html).toContain('&lt;b onclick=&quot;x&quot;&gt;');
  });
});

describe('safeHref and InlineMarkdown', () => {
  it('admits only three schemes', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('HTTP://EXAMPLE.COM')).toBe('HTTP://EXAMPLE.COM');
    expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com');
    expect(safeHref(' javascript:alert(1)')).toBeNull();
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
  });

  it('renders one line with code spans and no blocks', () => {
    const html = renderToStaticMarkup(<InlineMarkdown text="Edit `a.ts` **now**" />);
    expect(html).toBe('Edit <code class="md-inline-code">a.ts</code> <strong>now</strong>');
  });
});
