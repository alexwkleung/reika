import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The page holds a token that drives the agent and draws text from models and fetched pages, so
// nothing in it may turn a string into markup or code.
const FORBIDDEN = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval(',
  'new Function',
  'createContextualFragment',
];

describe('client sources', () => {
  it('use no API that parses a string as HTML or code', () => {
    const here = import.meta.dirname;
    const files = readdirSync(here).filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap(f => {
      const source = readFileSync(join(here, f), 'utf8');
      return FORBIDDEN.filter(name => source.includes(name)).map(name => `${f}: ${name}`);
    });
    expect(hits).toEqual([]);
  });
});
