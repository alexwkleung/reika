import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from './App.js';
import type { Connection } from './connection.js';
import { openEventStream } from './eventstream.js';
import { createHolder } from './holder.js';
import { browserTokenStore, signIn } from './link.js';
import { foldEvent, initialClientState, type ClientState } from './store.js';

// Wiring only: sign in, stream, fold into the holder, render.

const state = createHolder<ClientState>(initialClientState);
const connection = createHolder<Connection>({ signIn: null, stream: null });

// Wrapped, never passed bare: a browser's fetch called as a method of another object throws.
const browserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const tokens = browserTokenStore(() => window.sessionStorage);
const schedule = (callback: () => void) => void requestAnimationFrame(callback);

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App state={state} connection={connection} schedule={schedule} />
  </StrictMode>,
);
void start();
