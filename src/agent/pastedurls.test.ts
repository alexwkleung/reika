import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractOptions, UrlExtraction } from '../tools/fetch.js';

const extractUrl = vi.hoisted(() =>
  vi.fn<(url: string, opts?: ExtractOptions) => Promise<UrlExtraction>>(),
);
vi.mock('../tools/fetch.js', () => ({ extractUrl }));

const { expandPastedUrls, isUrlTheRequest, planPastedUrls } = await import('./pastedurls.js');

function ok(content: string): UrlExtraction {
  return { ok: true, content, extractedChars: content.length };
}

beforeEach(() => {
  extractUrl.mockReset();
  extractUrl.mockImplementation(async (url: string) => ok(`content of ${url}`));
});

const ask = { mode: 'ask' as const };

describe('expandPastedUrls', () => {
  it('is a strict no-op when off', async () => {
    const r = await expandPastedUrls('see https://example.com/docs', { mode: 'off' });
    expect(r.blocks).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(extractUrl).not.toHaveBeenCalled();
  });

  it('does nothing when the prompt has no URL', async () => {
    const r = await expandPastedUrls('fix the parser', ask);
    expect(r.blocks).toEqual([]);
    expect(extractUrl).not.toHaveBeenCalled();
  });

  it('fetches a pasted URL into a labeled block', async () => {
    const r = await expandPastedUrls('read https://example.com/docs and summarize', ask);
    expect(r.fetched).toEqual(['https://example.com/docs']);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toContain('<url href="https://example.com/docs">');
    expect(r.blocks[0]).toContain('content of https://example.com/docs');
    expect(r.notices[0]).toMatchObject({ tone: 'info' });
  });

  it('caps at two URLs and says so', async () => {
    const input = 'https://a.com https://b.com https://c.com';
    const r = await expandPastedUrls(input, ask);
    expect(extractUrl).toHaveBeenCalledTimes(2);
    expect(r.fetched).toEqual(['https://a.com', 'https://b.com']);
    expect(r.notices.some(n => n.text.includes('3 found'))).toBe(true);
  });

  it('reports the fetch count before the requests go out', async () => {
    const onStart = vi.fn();
    let startedBeforeFetch = false;
    extractUrl.mockImplementation(async () => {
      startedBeforeFetch = onStart.mock.calls.length === 1;
      return ok('x');
    });
    await expandPastedUrls('https://a.com and https://b.com', { ...ask, onStart });
    expect(onStart).toHaveBeenCalledExactlyOnceWith(2);
    expect(startedBeforeFetch).toBe(true);
  });

  it('does not report a start when there is nothing to fetch', async () => {
    const onStart = vi.fn();
    await expandPastedUrls('no links here', { ...ask, onStart });
    await expandPastedUrls('https://a.com', { mode: 'off', onStart });
    expect(onStart).not.toHaveBeenCalled();
  });

  it('truncates a long page and points at fetch_url for the rest', async () => {
    extractUrl.mockResolvedValue(ok('y'.repeat(20_000)));
    const r = await expandPastedUrls('https://example.com', ask);
    expect(r.blocks[0].length).toBeLessThan(9000);
    expect(r.blocks[0]).toContain('call fetch_url for the full page');
  });

  it('warns without a block when the server returns an error', async () => {
    extractUrl.mockResolvedValue({ ok: false, reached: true, error: '404 Not Found' });
    const r = await expandPastedUrls('https://example.com/gone', ask);
    expect(r.blocks).toEqual([]);
    expect(r.fetched).toEqual([]);
    expect(r.notices[0]).toMatchObject({ tone: 'warn' });
    expect(r.notices[0].text).toContain("Couldn't fetch");
  });

  it('distinguishes an unreachable host from a dead link', async () => {
    extractUrl.mockResolvedValue({ ok: false, reached: false, error: 'getaddrinfo ENOTFOUND' });
    const r = await expandPastedUrls('https://example.com', ask);
    expect(r.notices[0].text).toContain("Couldn't reach");
  });

  it('keeps a good fetch when the other one fails', async () => {
    extractUrl.mockImplementation(async (url: string) =>
      url.includes('bad') ? { ok: false, reached: true, error: '500' } : ok('good page'),
    );
    const r = await expandPastedUrls('https://bad.com and https://good.com', ask);
    expect(r.fetched).toEqual(['https://good.com']);
    expect(r.blocks).toHaveLength(1);
    expect(r.notices).toHaveLength(2);
  });
});

// #448: the trigger is the prompt's shape, not the presence of a URL. A wrong `true` is an
// outbound request nobody meant; a wrong `false` is one keystroke in the dialog — so it
// under-fetches, and these pin both sides.
describe('isUrlTheRequest — shape gate', () => {
  const yes = (prompt: string, url = /https?:\/\/\S+/.exec(prompt)![0].replace(/[.,;:!?]+$/, '')) =>
    expect(isUrlTheRequest(prompt, url), prompt).toBe(true);
  const no = (prompt: string, url = /https?:\/\/\S+/.exec(prompt)![0].replace(/[.,;:!?]+$/, '')) =>
    expect(isUrlTheRequest(prompt, url), prompt).toBe(false);

  it('the URL alone, or at the start or end of a short prompt', () => {
    yes('https://example.com/docs');
    yes('https://example.com/docs — how does auth work here?');
    yes('what does the auth section say https://example.com/docs');
    yes("what's at https://example.com/docs?");
    yes('please https://example.com/docs');
    yes('(https://example.com/docs)');
    yes('https://example.com/docs please');
  });

  it('after a read verb, with a filler word or two allowed', () => {
    yes('can you read https://example.com/docs and tell me how auth works');
    yes('summarize this link https://example.com/docs for me');
    yes('look at https://example.com/docs — does it mention rate limits?');
    yes('what does https://example.com/docs say about tokens');
    yes('implement https://example.com/spec in src/api.ts');
    yes('summarize: https://example.com/docs, then compare it with our README');
  });

  it('a URL inside an error, a log line, or a commit body is not a request', () => {
    no('TypeError: fetch failed at https://api.example.com/v1/users?token=abc — what happened?');
    no('GET https://example.com/confirm?t=123 404\nwhat is wrong with this route');
    no(
      'the job failed with\n  Error: connect ECONNREFUSED\n  see https://ci.example.com/unsubscribe?t=1',
    );
    no(
      'fix the bug where the client retries forever when https://api.example.com/v1/users returns a 429 with a retry-after header that the parser in src/client.ts does not read',
    );
    no('from https://tracker.example.com/click?id=9 the redirect goes to the wrong page');
  });

  it('a link at the end of a multi-line paste is the unsubscribe-at-the-bottom shape', () => {
    no('Your build failed.\nView the logs here:\nhttps://ci.example.com/build/42?token=abc');
  });

  it('a verb two lines up is not about the link on this line', () => {
    no('read the following error\n\nError: 500\nhttps://api.example.com/x');
  });

  it('why-is-my-dev-server-broken is asked about, not auto-fetched', () => {
    no('why is http://localhost:3000/api 500ing?');
  });
});

describe('planPastedUrls', () => {
  it('is a request only when every candidate clears the gate', () => {
    expect(planPastedUrls('read https://a.com and https://b.com').request).toBe(true);
    expect(
      planPastedUrls('compare https://a.com with the failing https://b.com endpoint').request,
    ).toBe(false);
  });

  it('never counts a credentialed URL as a candidate, and names only its host', () => {
    const plan = planPastedUrls('read https://user:hunter2@example.com/private and https://ok.com');
    expect(plan.urls).toEqual(['https://ok.com']);
    expect(plan.refused).toEqual(['example.com']);
    expect(plan.found).toBe(2);
    expect(JSON.stringify(plan)).not.toContain('hunter2');
  });
});

describe('expandPastedUrls — incidental links (#448)', () => {
  const incidental = 'TypeError: fetch failed at https://api.example.com/v1/users — what happened?';

  it("under 'ask' with nobody asked, leaves the link and says how to get the fetch", async () => {
    const r = await expandPastedUrls(incidental, ask);
    expect(extractUrl).not.toHaveBeenCalled();
    expect(r.blocks).toEqual([]);
    expect(r.notices).toEqual([
      expect.objectContaining({ tone: 'info', text: expect.stringContaining('not fetched') }),
    ]);
    expect(r.notices[0].text).toContain('REIKA_PASTE_FETCH=apply');
  });

  it("under 'apply' with nobody asked, fetches it — with the host policy kept", async () => {
    const r = await expandPastedUrls(incidental, { mode: 'apply' });
    expect(extractUrl).toHaveBeenCalledWith('https://api.example.com/v1/users', {
      allowPrivate: false,
    });
    expect(r.fetched).toEqual(['https://api.example.com/v1/users']);
  });

  it('a decline in the dialog leaves it silently — the dialog was the line', async () => {
    const r = await expandPastedUrls(incidental, { ...ask, incidental: false });
    expect(extractUrl).not.toHaveBeenCalled();
    expect(r.notices).toEqual([]);
  });

  it('a confirmed fetch opens the host policy, since a human vouched for the address', async () => {
    await expandPastedUrls('why is http://localhost:3000/api 500ing?', {
      ...ask,
      incidental: true,
    });
    expect(extractUrl).toHaveBeenCalledWith('http://localhost:3000/api', { allowPrivate: true });
  });

  it('a request-shaped prompt opens the host policy on its own', async () => {
    await expandPastedUrls('read http://localhost:3000/api', ask);
    expect(extractUrl).toHaveBeenCalledWith('http://localhost:3000/api', { allowPrivate: true });
  });

  it('refuses a credentialed URL in every mode, with a receipt that does not echo the secret', async () => {
    for (const mode of ['ask', 'apply'] as const) {
      extractUrl.mockClear();
      const r = await expandPastedUrls('read https://user:hunter2@example.com/private', {
        mode,
        incidental: true,
      });
      expect(extractUrl).not.toHaveBeenCalled();
      expect(r.blocks).toEqual([]);
      expect(r.notices).toHaveLength(1);
      expect(r.notices[0]).toMatchObject({ tone: 'warn' });
      expect(r.notices[0].text).toContain('credentials');
      expect(r.notices[0].text).toContain('example.com');
      expect(r.notices[0].text).not.toContain('hunter2');
      expect(r.notices[0].text).not.toContain('user:');
    }
  });
});
