// Sign-in: a printed link carries a single-use code in its fragment (server.ts), traded once at
// POST /session for the token, which this tab keeps. The browser parts are handed in, so this
// runs under a test with no DOM.

export const TOKEN_STORAGE_KEY = 'reika-token';

export type TokenStore = {
  get(): string | null;
  set(token: string): void;
  remove(): void;
};

export type SignInDeps = {
  hash: string;
  // Takes the code off the address bar, so a reload or a copied URL does not carry it.
  clearHash(): void;
  fetch: typeof fetch;
  store: TokenStore;
};

export type SignInResult =
  | { kind: 'signed-in'; token: string }
  | { kind: 'link-dead' }
  | { kind: 'no-link' }
  | { kind: 'error'; message: string };

export function readLinkCode(hash: string): string | null {
  const code = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('code');
  return code ? code : null;
}

// Storage access throws in some private modes; a tab that cannot keep the token still signs in.
export function browserTokenStore(storage: () => Storage): TokenStore {
  return {
    get: () => {
      try {
        return storage().getItem(TOKEN_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    set: token => {
      try {
        storage().setItem(TOKEN_STORAGE_KEY, token);
      } catch {}
    },
    remove: () => {
      try {
        storage().removeItem(TOKEN_STORAGE_KEY);
      } catch {}
    },
  };
}

async function tradeCode(code: string, fetchFn: typeof fetch): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetchFn('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (e) {
    return { kind: 'error', message: `cannot reach the server: ${(e as Error).message}` };
  }
  if (res.status === 401) return { kind: 'link-dead' };
  if (!res.ok) return { kind: 'error', message: `sign-in refused (${res.status})` };
  try {
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token === 'string' && body.token)
      return { kind: 'signed-in', token: body.token };
  } catch {}
  return { kind: 'error', message: 'sign-in answered without a token' };
}

export async function signIn(deps: SignInDeps): Promise<SignInResult> {
  const stored = deps.store.get();
  const code = readLinkCode(deps.hash);
  if (!code) return stored ? { kind: 'signed-in', token: stored } : { kind: 'no-link' };
  deps.clearHash();
  const traded = await tradeCode(code, deps.fetch);
  if (traded.kind === 'signed-in') {
    deps.store.set(traded.token);
    return traded;
  }
  // A used link reopened in a tab that is already signed in: the tab's own token still holds.
  return stored ? { kind: 'signed-in', token: stored } : traded;
}
