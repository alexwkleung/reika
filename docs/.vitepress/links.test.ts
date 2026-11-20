import { describe, expect, it } from 'vitest';
import { dropReadmeBackLink } from './links';

const link = (href: string, text: string) => [
  { type: 'paragraph_open' },
  {
    type: 'inline',
    children: [
      { type: 'link_open', attrGet: (name: string) => (name === 'href' ? href : null) },
      { type: 'text', content: text },
      { type: 'link_close' },
    ],
  },
  { type: 'paragraph_close' },
];
const heading = [
  { type: 'heading_open' },
  { type: 'inline', children: [] },
  { type: 'heading_close' },
];
const types = (tokens: { type: string }[]) => tokens.map(t => t.type);

describe('dropReadmeBackLink', () => {
  it('drops the back link under the title, English and zh paths alike', () => {
    for (const href of ['../README.md', '../../README.md']) {
      const tokens = [...heading, ...link(href, '← README'), ...link('usage.md', 'Usage')];
      dropReadmeBackLink(tokens);
      expect(types(tokens)).toEqual([...types(heading), ...types(link('usage.md', 'Usage'))]);
    }
  });

  it('leaves a README link that is part of a sentence or has other text', () => {
    const other = [...link('../README.md', 'the README'), ...link('../README.md', '← README.md')];
    const before = types(other);
    dropReadmeBackLink(other);
    expect(types(other)).toEqual(before);
  });

  it('leaves a ← link to another page', () => {
    const tokens = link('../CHANGELOG.md', '← README');
    dropReadmeBackLink(tokens);
    expect(tokens).toHaveLength(3);
  });
});
