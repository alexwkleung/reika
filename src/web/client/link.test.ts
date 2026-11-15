import { describe, expect, it, vi } from 'vitest';
import { browserTokenStore, readLinkCode, signIn, type TokenStore } from './link.js';

function memoryStore(initial: string | null = null): TokenStore & { value: string | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (t: string) => void (store.value = t),
    remove: () => void (store.value = null),
  };
  return store;
}

function deps(opts: { hash: string; stored?: string | null; response?: Response | Error }) {
  const order: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    order.push('fetch');
    void input;
    void init;
    if (opts.response instanceof Error) throw opts.response;
    return opts.response ?? new Response('', { status: 500 });
  });
  const store = memoryStore(opts.stored ?? null);
  return {
    order,
    fetchFn,
    store,
    deps: {
      hash: opts.hash,
      clearHash: () => order.push('clearHash'),
      fetch: fetchFn as unknown as typeof fetch,
      store,
    },
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('readLinkCode', () => {
  it('reads the code with or without the leading #', () => {
    expect(readLinkCode('#code=abc')).toBe('abc');
    expect(readLinkCode('code=abc')).toBe('abc');
    expect(readLinkCode('#x=1&code=a%2Bb')).toBe('a+b');
  });

  it('is null for no code or an empty one', () => {
    expect(readLinkCode('')).toBeNull();
    expect(readLinkCode('#')).toBeNull();
    expect(readLinkCode('#code=')).toBeNull();
    expect(readLinkCode('#token=abc')).toBeNull();
  });
});

describe('signIn', () => {
  it('trades the code for a token, clearing the address bar before the request', async () => {
    const d = deps({ hash: '#code=c1', response: ok({ token: 't1' }) });
    expect(await signIn(d.deps)).toEqual({ kind: 'signed-in', token: 't1' });
    expect(d.order).toEqual(['clearHash', 'fetch']);
    expect(d.store.value).toBe('t1');
    const [url, init] = d.fetchFn.mock.calls[0]!;
    expect(url).toBe('/session');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'c1' });
  });

  it('is link-dead when the code is refused and no token is stored', async () => {
    const d = deps({ hash: '#code=used', response: new Response('', { status: 401 }) });
    expect(await signIn(d.deps)).toEqual({ kind: 'link-dead' });
    expect(d.store.value).toBeNull();
  });

  it('keeps a tab signed in that reopens a used link', async () => {
    const d = deps({
      hash: '#code=used',
      stored: 'mine',
      response: new Response('', { status: 401 }),
    });
    expect(await signIn(d.deps)).toEqual({ kind: 'signed-in', token: 'mine' });
    expect(d.store.value).toBe('mine');
  });

  it('a fresh code replaces a stored token', async () => {
    const d = deps({ hash: '#code=c2', stored: 'old', response: ok({ token: 'new' }) });
    expect(await signIn(d.deps)).toEqual({ kind: 'signed-in', token: 'new' });
    expect(d.store.value).toBe('new');
  });

  it('uses a stored token with no code, without a request', async () => {
    const d = deps({ hash: '', stored: 'mine' });
    expect(await signIn(d.deps)).toEqual({ kind: 'signed-in', token: 'mine' });
    expect(d.order).toEqual([]);
  });

  it('is no-link with neither a code nor a stored token', async () => {
    const d = deps({ hash: '#' });
    expect(await signIn(d.deps)).toEqual({ kind: 'no-link' });
    expect(d.order).toEqual([]);
  });

  it('reports a network failure, a server error and a body with no token', async () => {
    for (const response of [
      new Error('offline'),
      new Response('', { status: 500 }),
      ok({ nope: 1 }),
      new Response('not json', { status: 200 }),
    ]) {
      const d = deps({ hash: '#code=c', response });
      const r = await signIn(d.deps);
      expect(r.kind).toBe('error');
      expect(d.store.value).toBeNull();
    }
  });
});

describe('browserTokenStore', () => {
  it('reads and writes the token under its key', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as unknown as Storage;
    const store = browserTokenStore(() => storage);
    store.set('t');
    expect(map.get('reika-token')).toBe('t');
    expect(store.get()).toBe('t');
    store.remove();
    expect(store.get()).toBeNull();
  });

  it('survives storage that throws', () => {
    const store = browserTokenStore(() => {
      throw new Error('denied');
    });
    expect(store.get()).toBeNull();
    expect(() => store.set('t')).not.toThrow();
    expect(() => store.remove()).not.toThrow();
  });
});
