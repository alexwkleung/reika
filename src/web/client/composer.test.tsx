import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { ClientMessage, WireCatalog, WireCompletion, WireState } from '../protocol.js';
import { PASTE_LINE_THRESHOLD as n } from '../../ui/pastes.js';
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
const { Composer, placeholderFor, sendFailure } = await import('./Composer.js');
const { IMAGES_UNSUPPORTED } = await import('./keys.js');

const session = (over: Partial<WireState> = {}): WireState => ({
  mode: 'agent',
  status: 'idle',
  error: null,
  model: 'local-model',
  profile: 'default',
  cwd: '/repo',
  autoApprove: 'off',
  unattended: false,
  usage: { promptTokens: 0, completionTokens: 0 },
  lastUsage: null,
  estimatedContext: null,
  contextWindow: null,
  shrink: { sheds: 0, folds: 0 },
  decodeRate: null,
  queue: [],
  approvals: { approved: 0, declined: 0 },
  preparing: false,
  stage: null,
  modelPinned: false,
  ...over,
});

const catalog: WireCatalog = {
  models: [
    {
      name: 'default',
      model: 'local-model',
      baseURL: 'http://127.0.0.1:1/v1',
      kind: 'model',
      active: true,
    },
    {
      name: 'kimi',
      model: 'kimi-k3',
      baseURL: 'http://127.0.0.1:2/v1',
      kind: 'profile',
      active: false,
    },
  ],
};

type MountOpts = {
  reply?: SendResult;
  completions?: (text: string) => WireCompletion;
  session?: Partial<WireState>;
  history?: string[];
  waiting?: boolean;
  locked?: boolean;
  restoreLine?: { current: () => void };
};

async function mount(opts: MountOpts = {}) {
  const sent: ClientMessage[] = [];
  const send = (m: ClientMessage) => {
    if (m.type === 'complete') {
      return Promise.resolve<SendResult>({ kind: 'ok', reply: opts.completions?.(m.text) ?? null });
    }
    sent.push(m);
    return Promise.resolve<SendResult>(opts.reply ?? { kind: 'ok' });
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (over: MountOpts = {}) =>
    act(async () =>
      root.render(
        <Composer
          send={send}
          session={session({ ...opts.session, ...over.session })}
          catalog={catalog}
          history={over.history ?? opts.history ?? []}
          waiting={over.waiting ?? opts.waiting ?? false}
          locked={over.locked ?? opts.locked ?? false}
          restoreLine={opts.restoreLine}
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
  const paste = (data: { types?: string[]; text?: string }) =>
    act(async () => {
      const e = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'clipboardData', {
        value: {
          items: (data.types ?? []).map(type => ({ kind: 'file', type })),
          getData: (t: string) => (t === 'text/plain' ? (data.text ?? '') : ''),
        },
      });
      box().dispatchEvent(e);
    });
  const button = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const click = (el: Element) =>
    act(async () => {
      el.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  return {
    sent,
    container,
    box,
    type,
    press,
    paste,
    button,
    click,
    render,
    unmount: () => act(async () => root.unmount()),
  };
}

describe('Composer', () => {
  it('Enter submits with the mode it was typed in and clears; Shift+Enter and composition do not', async () => {
    const m = await mount({ session: { mode: 'plan' } });
    await m.type('hello');
    await m.press('Enter', { shiftKey: true });
    await m.press('Enter', { isComposing: true });
    expect(m.sent).toEqual([]);
    await m.press('Enter');
    expect(m.sent).toEqual([{ type: 'submit', text: 'hello', mode: 'plan' }]);
    expect(m.box().value).toBe('');
    await m.unmount();
  });

  it('Send sends, and is off for an empty box', async () => {
    const m = await mount();
    expect(m.button('Send')!.disabled).toBe(true);
    await m.type('via the button');
    await m.click(m.button('Send')!);
    expect(m.sent).toEqual([{ type: 'submit', text: 'via the button', mode: 'agent' }]);
    await m.unmount();
  });

  it('keeps the text and shows why on a failed send', async () => {
    const m = await mount({
      reply: { kind: 'conflict', error: 'the mode is now shell, not agent' },
    });
    await m.type('keep me');
    await m.press('Enter');
    expect(m.box().value).toBe('keep me');
    expect(m.container.textContent).toContain('the mode is now shell, not agent');
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

  it('a trailing backslash and Enter break the line, as in the TUI', async () => {
    const m = await mount();
    await m.type('first\\');
    await m.press('Enter');
    expect(m.box().value).toBe('first\n');
    expect(m.sent).toEqual([]);
    await m.unmount();
  });

  it('while busy: Stop for an empty box, the queue, Escape aborts, typed text is queued', async () => {
    const m = await mount({
      session: { status: 'busy', queue: [{ content: 'next thing', images: 0 }] },
    });
    expect(m.container.textContent).toContain('Queued');
    expect(m.container.textContent).toContain('next thing');
    expect(m.box().placeholder).toBe('Queue a message · Esc stops');
    await m.press('Escape');
    await m.click(m.button('Stop')!);
    expect(m.sent).toEqual([{ type: 'abort' }, { type: 'abort' }]);
    await m.type('queue this');
    expect(m.button('Stop')).toBeNull();
    await m.press('Enter');
    expect(m.sent.at(-1)).toEqual({ type: 'submit', text: 'queue this', mode: 'agent' });
    await m.unmount();
  });

  it('shows what a submit is waiting on', async () => {
    const m = await mount({ session: { stage: 'Fetching 1 pasted link' } });
    expect(m.container.querySelector('[role="status"]')?.textContent).toBe(
      'Fetching 1 pasted link…',
    );
    await m.unmount();
  });

  it('an image paste is refused with a message and inserts nothing', async () => {
    const m = await mount();
    await m.paste({ types: ['image/png'] });
    expect(m.container.textContent).toContain(IMAGES_UNSUPPORTED);
    expect(m.box().value).toBe('');
    await m.unmount();
  });

  it('parks a large paste as a marker numbered above the history, and sends it beside the text', async () => {
    const m = await mount({ history: [`old [Pasted text #3 +${n} lines]`] });
    const log = 'line\n'.repeat(n);
    await m.type('why? ');
    await m.paste({ text: log });
    const marker = `[Pasted text #4 +${n} lines]`;
    expect(m.box().value).toBe(`why? ${marker}`);
    await m.press('Enter');
    expect(m.sent).toEqual([
      { type: 'submit', text: `why? ${marker}`, mode: 'agent', pastes: [{ marker, text: log }] },
    ]);
    await m.unmount();
  });

  it('a small paste goes in as text', async () => {
    const m = await mount();
    await m.paste({ text: 'short' });
    expect(m.sent).toEqual([]);
    await m.unmount();
  });

  it('↑ recalls the shared history and ↓ brings the draft back', async () => {
    const m = await mount({ history: ['first', 'second'] });
    await m.type('draft');
    await m.press('ArrowUp');
    expect(m.box().value).toBe('second');
    await m.press('ArrowUp');
    expect(m.box().value).toBe('first');
    await m.press('ArrowDown');
    await m.press('ArrowDown');
    expect(m.box().value).toBe('draft');
    await m.unmount();
  });

  it('asks the server for completions and applies one; Enter on a complete line sends it', async () => {
    const asked: string[] = [];
    const m = await mount({
      completions: text => {
        asked.push(text);
        return text.startsWith('/mo')
          ? {
              kind: 'command',
              partial: text,
              items: [
                { value: '/model', display: '/model  —  pick a model' },
                { value: '/mode', display: '/mode  —  made up' },
              ],
            }
          : null;
      },
    });
    await m.type('plain');
    await m.type('/mo');
    expect(asked).toEqual(['/mo']);
    const options = () => [...m.container.querySelectorAll('[role="option"]')];
    expect(options().map(o => o.textContent)).toEqual(['/modelpick a model', '/modemade up']);
    await m.press('ArrowDown');
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    await m.press('ArrowUp');
    await m.press('Tab');
    expect(m.box().value).toBe('/model');
    expect(options()).toEqual([]);

    await m.type('/model');
    await m.press('Enter');
    expect(m.sent).toEqual([{ type: 'submit', text: '/model', mode: 'agent' }]);
    await m.unmount();
  });

  it('Escape closes the completion list without stopping a turn', async () => {
    const m = await mount({
      session: { status: 'busy' },
      completions: () => ({
        kind: 'file',
        partial: '@',
        items: [{ value: '@a.ts', display: 'a.ts' }],
      }),
    });
    await m.type('@');
    await m.press('Escape');
    expect(m.container.querySelector('[role="listbox"]')).toBeNull();
    expect(m.sent).toEqual([]);
    await m.unmount();
  });

  it('attach starts an @ mention and opens file completion', async () => {
    const asked: string[] = [];
    const m = await mount({
      completions: text => {
        asked.push(text);
        return null;
      },
    });
    await m.type('look at');
    await m.click(m.button('Attach a file')!);
    expect(m.box().value).toBe('look at @');
    expect(asked.at(-1)).toBe('look at @');
    await m.unmount();
  });

  it('the mode pill switches through the server, and is off while a prompt runs', async () => {
    const m = await mount();
    await m.click(m.button('Mode: agent')!);
    const plan = [...m.container.querySelectorAll('[role="menuitemradio"]')].find(
      o => o.textContent === 'plan',
    )!;
    await m.click(plan);
    expect(m.sent).toEqual([{ type: 'mode', mode: 'plan' }]);
    for (const over of [
      { status: 'busy' as const },
      { preparing: true },
      { queue: [{ content: 'x', images: 0 }] },
    ]) {
      await m.render({ session: over });
      expect(m.button('Mode: agent')!.disabled).toBe(true);
      expect(m.button('Model: local-model')!.disabled).toBe(true);
    }
    await m.unmount();
  });

  it('the model pill lists the catalog and picks one', async () => {
    const m = await mount();
    await m.click(m.button('Model: local-model')!);
    const items = [...m.container.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map(i => [i.textContent, i.getAttribute('aria-checked')])).toEqual([
      ['defaultlocal-model', 'true'],
      ['kimikimi-k3', 'false'],
    ]);
    await m.click(items[1]!);
    expect(m.sent).toEqual([{ type: 'model', name: 'kimi' }]);
    await m.unmount();
  });

  it('is disabled with a line while a dialog waits', async () => {
    const m = await mount({ waiting: true });
    expect(m.box().disabled).toBe(true);
    expect(m.container.textContent).toContain('Answer above to continue.');
    expect(m.button('Mode: agent')!.disabled).toBe(true);
    await m.unmount();
  });

  it("takes back its own line on a confirm's Don't send, and only once", async () => {
    const restoreLine = { current: () => {} };
    const m = await mount({ restoreLine });
    await m.type('verify the change');
    await m.press('Enter');
    expect(m.box().value).toBe('');
    await act(async () => restoreLine.current());
    expect(m.box().value).toBe('verify the change');
    await m.type('');
    await act(async () => restoreLine.current());
    expect(m.box().value).toBe('');
    await m.unmount();
  });

  it('does not take back a line it queued behind a running turn', async () => {
    const restoreLine = { current: () => {} };
    const m = await mount({ restoreLine, session: { status: 'busy' } });
    await m.type('later');
    await m.press('Enter');
    await act(async () => restoreLine.current());
    expect(m.box().value).toBe('');
    await m.unmount();
  });

  it('is locked when the server speaks another version', async () => {
    const m = await mount({ locked: true });
    expect(m.box().disabled).toBe(true);
    expect(m.box().placeholder).toBe('Reload the page to keep going');
    expect(m.button('Mode: agent')!.disabled).toBe(true);
    await m.unmount();
  });

  it('places the TUI’s hint, a shell mode prompt and nothing about images', () => {
    expect(placeholderFor('agent', false, false)).toBe('Type / for commands, @ to attach files');
    expect(placeholderFor('shell', false, false)).toBe('Run a shell command');
    expect(placeholderFor('shell', true, false)).toBe('Queue a message · Esc stops');
  });
});
