import { describe, expect, it } from 'vitest';
import { translationLink } from './translationLink';

describe('partial translation navigation', () => {
  const translated = ['index', 'models', 'platforms', 'architecture'];

  it.each(['models', 'platforms', 'architecture'])('switches %s in both directions', page => {
    expect(translationLink(`${page}.md`, 'zh', translated)).toBe(`/zh/${page}`);
    expect(translationLink(`zh/${page}.md`, 'root', translated)).toBe(`/${page}`);
  });

  it.each(['index.md', 'usage.md', 'configuration.md', '404.md'])('%s falls back to home', page => {
    expect(translationLink(page, 'zh', translated)).toBe('/zh/');
    expect(translationLink(`zh/${page}`, 'root', translated)).toBe('/');
  });

  it('uses the discovered list rather than a fixed set of page names', () => {
    expect(translationLink('models.md', 'zh', [])).toBe('/zh/');
    expect(translationLink('tools.md', 'zh', ['tools'])).toBe('/zh/tools');
  });
});
