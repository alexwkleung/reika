import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { ClientMessage, WireState } from '../protocol.js';
import type { SendResult } from './send.js';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  window,
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: window.HTMLElement,
});
// react-dom checks `'oninput' in document` once at load; without it it takes an old-IE polyfill.
Object.assign(document, { oninput: null });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Composer, sendFailure } = await import('./Composer.js');
const { IMAGES_UNSUPPORTED } = await import('./keys.js');

async function mount(
  opts: { reply?: SendResult; busy?: boolean; waiting?: boolean; queue?: WireState['queue'] } = {},
) {
  const sent: ClientMessage[] = [];
  const send = (m: ClientMessage) => {
    sent.push(m);
    return Promise.resolve<SendResult>(opts.reply ?? { kind: 'ok' });
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (over: { busy?: boolean; waiting?: boolean } = {}) =>
    act(async () =>
      root.render(
        <Composer
          send={send}
          busy={over.busy ?? opts.busy ?? false}
          queue={opts.queue ?? []}
          waiting={over.waiting ?? opts.waiting ?? false}
        />,
      ),
    );
  await render();
  const box = () => container.querySelector('textarea') as HTMLTextAreaElement;
  const type = (value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box()), 'value')!.set!;
      setter.call(box(), value);
      box().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const press = (key: string, extra: Record<string, unknown> = {}) =>
    act(async () => {
      const e = new window.Event('keydown', { bubbles: true, cancelable: true });
      for (const [k, v] of Object.entries({ key, shiftKey: false, isComposing: false, ...extra })) {
        Object.defineProperty(e, k, { value: v });
      }
      box().dispatchEvent(e);
    });
  const paste = (types: string[]) =>
    act(async () => {
      const e = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'clipboardData', {
        value: { items: types.map(type => ({ kind: 'file', type })) },
      });
      box().dispatchEvent(e);
    });
  return {
    sent,
    container,
    box,
    type,
    press,
    paste,
    render,
    unmount: () => act(async () => root.unmount()),
  };
}

describe('Composer', () => {
  it('Enter submits and clears on ok; Shift+Enter and composition do not', async () => {
    const m = await mount();
    await m.type('hello');
    await m.press('Enter', { shiftKey: true });
    await m.press('Enter', { isComposing: true });
    expect(m.sent).toEqual([]);
    await m.press('Enter');
    expect(m.sent).toEqual([{ type: 'submit', text: 'hello' }]);
    expect(m.box().value).toBe('');
    await m.unmount();
  });

  it('keeps the text and shows why on a failed send', async () => {
    const m = await mount({
      reply: { kind: 'failed', status: 400, error: 'a session is still loading' },
    });
    await m.type('keep me');
    await m.press('Enter');
    expect(m.box().value).toBe('keep me');
    expect(m.container.textContent).toContain('a session is still loading');
    await m.unmount();
  });

  it('a signed-out send uses the banner’s wording', async () => {
    expect(sendFailure({ kind: 'signed-out' })).toMatch(/no longer accepts this tab/);
    expect(sendFailure({ kind: 'failed', status: null, error: 'offline' })).toBe(
      'Cannot reach the server: offline',
    );
    expect(sendFailure({ kind: 'ok' })).toBeNull();
  });

  it('blank text sends nothing', async () => {
    const m = await mount();
    await m.type('   ');
    await m.press('Enter');
    expect(m.sent).toEqual([]);
    await m.unmount();
  });

  it('while busy: shows Stop and the queue, Escape on an empty box aborts', async () => {
    const m = await mount({ busy: true, queue: [{ content: 'next thing', images: 0 }] });
    expect(m.container.textContent).toContain('queued');
    expect(m.container.textContent).toContain('next thing');
    await m.press('Escape');
    expect(m.sent).toEqual([{ type: 'abort' }]);
    await act(async () => {
      const stop = [...m.container.querySelectorAll('button')].find(b => b.textContent === 'Stop')!;
      stop.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(m.sent).toEqual([{ type: 'abort' }, { type: 'abort' }]);
    await m.type('queue this');
    await m.press('Enter');
    expect(m.sent.at(-1)).toEqual({ type: 'submit', text: 'queue this' });
    await m.unmount();
  });

  it('an image paste is refused with a message and inserts nothing', async () => {
    const m = await mount();
    await m.paste(['image/png']);
    expect(m.container.textContent).toContain(IMAGES_UNSUPPORTED);
    expect(m.box().value).toBe('');
    await m.unmount();
  });

  it('is disabled with a line while a dialog waits', async () => {
    const m = await mount({ waiting: true });
    expect(m.box().disabled).toBe(true);
    expect(m.container.textContent).toContain('A question is waiting above.');
    await m.unmount();
  });
});
