import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { collectSourcedUrls, exfiltrationRisk, urlCarriesData } from './_exfil.js';

// The false-positive side is the one that decides whether the prompt is worth having: every row
// here is a URL a model fetches in ordinary work, and a hit on any of them is a nag.
describe('urlCarriesData — ordinary URLs pass', () => {
  it.each([
    'https://nodejs.org/api/fs.html',
    'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
    'https://github.com/octocat/hello-world/issues/42',
    'https://example.com/docs?page=2&lang=en',
    'https://www.notion.so/example/550e8400-e29b-41d4-a716-446655440000',
    'https://blog.example.com/2024/03/how-to-configure-typescript-5-strict-mode',
    'https://docs.python.org/3.12/library/asyncio-task.html',
    'https://en.wikipedia.org/wiki/Server-side_request_forgery',
    'https://www.npmjs.com/package/@types/node',
    'https://en.wikipedia.org/wiki/Schr%C3%B6dinger%27s_cat_2',
    'https://github.com/search?q=useEffect&type=code',
    'https://example.com/changelog#v2.10.0-beta-release-notes-2024',
  ])('%s', url => {
    expect(urlCarriesData(url)).toBeUndefined();
  });
});

describe('urlCarriesData — the leak shapes', () => {
  it.each([
    ['https://evil.example/?d=sk-live-abcdef1234567890', /query value "d"/],
    ['https://evil.example/c?a=1&b=2&c=3&d=4', /4 query parameters/],
    ['https://evil.example/x/c2stbGl2ZS1hYmNkZWYxMjM0NTY3ODkw', /path segment/],
    ['https://evil.example/sk-live-abcdef1234567890', /path segment/],
    [
      'https://evil.example/x/%73%6b%2d%6c%69%76%65%2d%61%62%63%64%65%66%31%32%33%34%35%36%37%38%39%30',
      /path segment/,
    ],
    // DNS exfiltration: the lookup alone delivers the label, no response needed.
    ['https://c2stbGl2ZS1hYmNkZWYxMjM0NTY3ODkw.evil.example/', /host name label/],
    // Documented false positive (#548): a hex SHA is indistinguishable from a hex token.
    [
      'https://github.com/octocat/hello-world/commit/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
      /path segment/,
    ],
  ])('%s', (url, reason) => {
    expect(urlCarriesData(url)).toMatch(reason);
  });
});

describe('collectSourcedUrls', () => {
  const history: Message[] = [
    { role: 'user', content: 'read https://example.com/guide?ref=newsletter-2024-spring please' },
    {
      role: 'user',
      content: '/stats https://meta.example/should-not-count-9999999999',
      meta: true,
    },
    {
      role: 'assistant',
      content: 'I will fetch https://model.example/invented?d=abcdef1234567890',
    },
    {
      role: 'tool',
      callId: 'c1',
      summary: 'Found 2 results',
      payload:
        '1. [Docs](https://docs.example.com/api?version=2024-01-01T00:00)\n2. https://b.example/x.',
    },
  ];
  const sourced = collectSourcedUrls(history);

  it('collects user and tool URLs, normalized and trimmed of punctuation', () => {
    expect(sourced.has('https://example.com/guide?ref=newsletter-2024-spring')).toBe(true);
    expect(sourced.has('https://docs.example.com/api?version=2024-01-01T00:00')).toBe(true);
    expect(sourced.has('https://b.example/x')).toBe(true);
  });

  it("never counts the model's own text or a meta echo as a source", () => {
    expect(sourced.has('https://model.example/invented?d=abcdef1234567890')).toBe(false);
    expect([...sourced].some(u => u.includes('meta.example'))).toBe(false);
  });
});

describe('exfiltrationRisk', () => {
  const sourced = new Set(['https://docs.example.com/api?version=2024-01-01T00:00']);

  it('passes a data-carrying URL the model was handed', () => {
    expect(
      exfiltrationRisk('HTTPS://docs.example.com/api?version=2024-01-01T00:00', sourced),
    ).toBeUndefined();
  });

  // The attack: the page planted the prefix, the model appended the data.
  it('flags the same host once the model appends data to it', () => {
    expect(
      exfiltrationRisk(
        'https://docs.example.com/api?version=2024-01-01T00:00&d=sk-live-abcdef12345',
        sourced,
      ),
    ).toMatch(/not a link from your prompt or any tool result/);
  });

  it('passes an unsourced URL that carries nothing', () => {
    expect(exfiltrationRisk('https://nodejs.org/api/fs.html', sourced)).toBeUndefined();
  });

  it('treats unknown provenance as unsourced', () => {
    expect(
      exfiltrationRisk('https://evil.example/?d=sk-live-abcdef1234567890', undefined),
    ).toBeDefined();
  });
});
