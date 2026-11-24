import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dropReadmeBackLink,
  placeUntranslatedNotice,
  UNTRANSLATED_NOTICE,
  untranslatedSource,
} from './links';

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

describe('placeUntranslatedNotice', () => {
  const html = (content: string) => ({ type: 'html_block', content });
  const quote = [
    { type: 'blockquote_open' },
    { type: 'paragraph_open' },
    { type: 'inline' },
    { type: 'paragraph_close' },
    { type: 'blockquote_close' },
  ];

  it("replaces the stub's own notice", () => {
    const tokens = [...quote, ...heading];
    placeUntranslatedNotice(tokens, html);
    expect(types(tokens)).toEqual(['html_block', ...types(heading)]);
    expect(tokens[0]).toMatchObject({ content: UNTRANSLATED_NOTICE });
  });

  it('adds the notice to a stub without one, keeping a later blockquote', () => {
    const tokens = [...heading, ...quote];
    placeUntranslatedNotice(tokens, html);
    expect(types(tokens)).toEqual(['html_block', ...types(heading), ...types(quote)]);
  });
});

describe('which zh pages get the notice', () => {
  const zhDir = fileURLToPath(new URL('../zh/', import.meta.url));
  const pages = readdirSync(zhDir).filter(name => name.endsWith('.md'));

  it.each(pages)('zh/%s gets it exactly when it is an include stub', name => {
    const file = join(zhDir, name);
    const isStub = /^\s*(>[^\n]*\n\s*)?<!--\s*@include:[^>]*-->\s*$/.test(
      readFileSync(file, 'utf8'),
    );
    expect(untranslatedSource(file) !== null).toBe(isStub);
  });

  it('never gets it on an English page', () => {
    expect(untranslatedSource(fileURLToPath(new URL('../usage.md', import.meta.url)))).toBeNull();
  });
});
