import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import type { ClientMessage } from '../protocol.js';
import { App } from './App.js';
import type { Connection } from './connection.js';
import { openEventStream } from './eventstream.js';
import { frameOrTimer } from './framebatch.js';
import { createHolder } from './holder.js';
import { browserTokenStore, signIn } from './link.js';
import { sendMessage, uploadImage, type SendResult, type UploadResult } from './send.js';
import { foldEvent, initialClientState, type ClientState } from './store.js';

// Wiring only: sign in, stream, fold into the holder, render.

const state = createHolder<ClientState>(initialClientState);
const connection = createHolder<Connection>({ signIn: null, stream: null });

// Wrapped, never passed bare: a browser's fetch called as a method of another object throws.
const browserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const tokens = browserTokenStore(() => window.sessionStorage);
const schedule = frameOrTimer(requestAnimationFrame, (callback, ms) => setTimeout(callback, ms));
let token: string | null = null;
const send = (message: ClientMessage): Promise<SendResult> =>
  token ? sendMessage(token, message, browserFetch) : Promise.resolve({ kind: 'signed-out' });

const upload = (file: Blob): Promise<UploadResult> =>
  token ? uploadImage(token, file, browserFetch) : Promise.resolve({ kind: 'signed-out' });

async function start(): Promise<void> {
  const result = await signIn({
    hash: location.hash,
    clearHash: () => history.replaceState(null, '', location.pathname + location.search),
    fetch: browserFetch,
    store: tokens,
  });
  connection.update(c => ({ ...c, signIn: result }));
  if (result.kind !== 'signed-in') return;
  token = result.token;
  openEventStream({
    token: result.token,
    resumeFrom: () => state.get().lastSeq,
    onEvent: event => {
      const receivedAt = Date.now();
      state.update(s => foldEvent(s, event, receivedAt));
    },
    onStatus: status => {
      if (status === 'signed-out') {
        tokens.remove();
        token = null;
      }
      connection.update(c => ({ ...c, stream: status }));
    },
    fetch: browserFetch,
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App state={state} connection={connection} schedule={schedule} send={send} upload={upload} />
  </StrictMode>,
);
void start();
