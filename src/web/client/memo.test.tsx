import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ServerEvent } from '../protocol.js';
import type * as MessageRowModule from './MessageRow.js';

// react-dom's client renderer on a linkedom document: the one test here that needs updates, which
// renderToStaticMarkup cannot show.
const { window, document } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>',
);
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { scrollTo: () => {} });

const renders = vi.hoisted(() => ({ rows: 0 }));
vi.mock('./MessageRow.js', async importOriginal => {
  const { memo } = await import('react');
  const real = await importOriginal<typeof MessageRowModule>();
  const Counted = memo(function Counted(props: Parameters<typeof real.MessageRow>[0]) {
    renders.rows++;
    return <real.MessageRow {...props} />;
  });
  return { MessageRow: Counted };
});

describe('committed rows are memoised', () => {
  it('a live update re-renders no row, and a new message renders only itself', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { App } = await import('./App.js');
    const { createHolder } = await import('./holder.js');
    const { foldEvent, initialClientState } = await import('./store.js');
    const state = createHolder(initialClientState);
    const connection = createHolder({ signIn: null, stream: null });
    const send = (e: ServerEvent) => act(async () => state.update(s => foldEvent(s, e)));
    const root = createRoot(document.getElementById('root')!);
    await act(async () =>
      root.render(
        <App
          state={state}
          connection={connection}
          schedule={cb => cb()}
          send={async () => ({ kind: 'ok' })}
        />,
      ),
    );
    await send({ type: 'hello', seq: 0, version: PROTOCOL_VERSION });
    await send({
      type: 'reset',
      seq: 0,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    });
    expect(renders.rows).toBe(2);
    await send({
      type: 'live',
      live: {
        phase: 'thinking',
        content: 'streaming',
        reasoning: '',
        tool: null,
        pending: null,
        plan: null,
        usage: null,
        subagent: false,
        note: false,
        typechecking: false,
        recovering: false,
        promptProgress: null,
        looping: false,
      },
    });
    await send({ type: 'delta', channel: 'content', text: ' more' });
    expect(renders.rows).toBe(2);
    await send({ type: 'message', seq: 1, message: { role: 'system', content: 'three' } });
    expect(renders.rows).toBe(3);
    expect(document.querySelectorAll('.row').length).toBeGreaterThanOrEqual(3);
    await act(async () => root.unmount());
  });
});
