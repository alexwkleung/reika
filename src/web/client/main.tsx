import { StrictMode, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { openEventStream, type StreamStatus } from './eventstream.js';
import { createHolder } from './holder.js';
import { browserTokenStore, signIn, type SignInResult } from './link.js';
import { foldEvent, initialClientState, type ClientState } from './store.js';

// The thinnest entry: sign in, stream, fold, and a plain readout that proves the bundle runs.
// The designed screens replace Placeholder.

type Connection = { signIn: SignInResult | null; stream: StreamStatus | null };

const state = createHolder<ClientState>(initialClientState);
const connection = createHolder<Connection>({ signIn: null, stream: null });

// Wrapped, never passed bare: a browser's fetch called as a method of another object throws.
const browserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const tokens = browserTokenStore(() => window.sessionStorage);

async function start(): Promise<void> {
  const result = await signIn({
    hash: location.hash,
    clearHash: () => history.replaceState(null, '', location.pathname + location.search),
    fetch: browserFetch,
    store: tokens,
  });
  connection.update(c => ({ ...c, signIn: result }));
  if (result.kind !== 'signed-in') return;
  openEventStream({
    token: result.token,
    resumeFrom: () => state.get().lastSeq,
    onEvent: event => state.update(s => foldEvent(s, event)),
    onStatus: status => {
      if (status === 'signed-out') tokens.remove();
      connection.update(c => ({ ...c, stream: status }));
    },
    fetch: browserFetch,
  });
}

function describeConnection(c: Connection): string {
  if (!c.signIn) return 'signing in';
  switch (c.signIn.kind) {
    case 'link-dead':
      return 'link already used or expired: press Enter in the terminal running `reika web` for a new one';
    case 'no-link':
      return 'not signed in: open the link `reika web` printed';
    case 'error':
      return c.signIn.message;
    case 'signed-in':
      return c.stream ?? 'connecting';
  }
}

function Placeholder() {
  const s = useSyncExternalStore(state.subscribe, state.get);
  const c = useSyncExternalStore(connection.subscribe, connection.get);
  return (
    <main className="placeholder">
      <p>
        connection: <span data-field="connection">{describeConnection(c)}</span>
      </p>
      <p>
        model: <span data-field="model">{s.session?.model ?? '-'}</span>
      </p>
      <p>
        mode: <span data-field="mode">{s.session?.mode ?? '-'}</span>
      </p>
      <p>
        messages: <span data-field="messages">{s.messages.length}</span>
      </p>
      {s.versionMismatch !== null && (
        <p>server protocol {s.versionMismatch} differs from this page's</p>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
void start();
