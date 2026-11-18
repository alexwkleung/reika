import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage, WireSessionList, WireState } from '../protocol.js';
import type { SendResult } from './send.js';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  window,
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: window.HTMLElement,
});
Object.assign(document, { oninput: null });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { History } = await import('./History.js');

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
  contextUsable: null,
  shrink: { sheds: 0, folds: 0 },
  decodeRate: null,
  queue: [],
  approvals: { approved: 0, declined: 0 },
  preparing: false,
  stage: null,
  modelPinned: false,
  session: 'b.jsonl',
  workingWords: false,
  pr: null,
  ...over,
});

const listOf = (over: Partial<WireSessionList> = {}): WireSessionList => ({
  scope: 'project',
  entries: [
    {
      id: 'b.jsonl',
      title: 'rename foo',
      savedAt: new Date().toISOString(),
      messageCount: 4,
      current: true,
    },
    {
      id: 'a.jsonl',
      title: 'which db',
      savedAt: new Date().toISOString(),
      messageCount: 6,
      chat: true,
    },
  ],
  total: 2,
  autosave: true,
  ...over,
});

// What the page's media query and storage answer; linkedom has neither.
const env = { wide: false, stored: new Map<string, string>() };
Object.assign(window, {
  matchMedia: (media: string) => ({
    media,
    matches: env.wide,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
  localStorage: {
    getItem: (k: string) => env.stored.get(k) ?? null,
    setItem: (k: string, v: string) => env.stored.set(k, v),
  },
});

type Opts = {
  signedIn?: boolean;
  state?: Partial<WireState>;
  waiting?: boolean;
  // Null answers as a failed request.
  list?: (m: Extract<ClientMessage, { type: 'sessions' }>) => WireSessionList | null;
  reply?: (m: ClientMessage) => SendResult;
  // Held open until the test settles it, for what the panel shows while a resume is in flight.
  hold?: Promise<SendResult>;
};

async function mount(opts: Opts = {}) {
  const sent: ClientMessage[] = [];
  const send = (m: ClientMessage): Promise<SendResult> => {
    sent.push(m);
    if (m.type === 'sessions') {
      const reply = (opts.list ?? (() => listOf()))(m);
      return Promise.resolve<SendResult>(
        reply ? { kind: 'ok', reply } : { kind: 'failed', status: 500, error: 'down' },
      );
    }
    if (opts.hold) return opts.hold;
    return Promise.resolve(opts.reply?.(m) ?? { kind: 'ok' });
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (state: Partial<WireState> | null = {}) =>
    act(async () =>
      root.render(
        <History
          session={state === null ? null : session({ ...opts.state, ...state })}
          waiting={opts.waiting ?? false}
          locked={false}
          send={send}
        />,
      ),
    );
  await render(opts.signedIn === false ? null : {});
  const q = <T extends Element>(sel: string) => container.querySelector(sel) as T | null;
  const click = (el: Element | null) =>
    act(async () => {
      el!.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  const rows = () => [...container.querySelectorAll('.history-row')] as HTMLButtonElement[];
  const open = () => click(q('.history-show'));
  return { sent, render, q, click, rows, open, container };
}

describe('History as a drawer', () => {
  it('asks for the project list when opened, marking the session you are in', async () => {
    const h = await mount();
    expect(h.q('.history')).toBeNull();
    await h.open();
    expect(h.sent).toEqual([{ type: 'sessions', scope: 'project' }]);
    const [current, other] = h.rows();
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(current.disabled).toBe(true);
    expect(current.textContent).toContain('current');
    expect(other.disabled).toBe(false);
    expect(other.textContent).toContain('which db');
    expect(other.textContent).toContain('chat');
    expect(other.textContent).toContain('6 msgs');
  });

  it('puts focus on its close button, not the filter, when opened', async () => {
    // linkedom keeps no focus, so the call is what is checked.
    const proto = window.HTMLElement.prototype as { focus?: () => void };
    const real = proto.focus;
    const focus = vi.fn();
    proto.focus = focus;
    const h = await mount();
    await h.open();
    proto.focus = real;
    expect(focus.mock.contexts).toEqual([h.q('.history-close')]);
    expect(h.q('.history-head .history-new')?.nextElementSibling?.className).toBe('history-close');
    expect(h.q('.history-head')?.nextElementSibling?.className).toBe('history-search');
  });

  it('keeps its rows as drawn while a resume is in flight, and takes no second click', async () => {
    let settle!: (r: SendResult) => void;
    const h = await mount({ hold: new Promise<SendResult>(r => (settle = r)) });
    await h.open();
    await h.click(h.rows()[1]);
    // Dimmed for the frame or two a resume takes, every row read as a flicker.
    expect(h.rows()[1].disabled).toBe(false);
    expect(h.rows()[1].getAttribute('aria-disabled')).toBe('true');
    expect(h.q<HTMLButtonElement>('.history-new')!.disabled).toBe(false);
    expect(h.rows()[1].textContent).toContain('6 msgs');
    await h.click(h.rows()[1]);
    await h.click(h.q('.history-new'));
    expect(h.sent.filter(m => m.type !== 'sessions')).toHaveLength(1);
    await act(async () => settle({ kind: 'ok' }));
  });

  it('opens a row by id in the listed scope and closes', async () => {
    const h = await mount();
    await h.open();
    await h.click(h.rows()[1]);
    expect(h.sent.at(-1)).toEqual({ type: 'resume', scope: 'project', id: 'a.jsonl' });
    expect(h.q('.history')).toBeNull();
  });

  it('shows a refusal and asks for the list again', async () => {
    const h = await mount({
      reply: () => ({ kind: 'conflict', error: 'that session is no longer listed' }),
    });
    await h.open();
    await h.click(h.rows()[1]);
    expect(h.q('.history-error')?.textContent).toBe('That session is no longer listed.');
    expect(h.sent.filter(m => m.type === 'sessions')).toHaveLength(2);
    expect(h.q('.history')).not.toBeNull();
  });

  it('disables opening and New conversation while a prompt runs, saying why', async () => {
    const h = await mount({ state: { status: 'busy' } });
    await h.open();
    const other = h.rows()[1];
    expect(other.disabled).toBe(true);
    // Not said in the panel: the input box already shows the prompt running.
    expect(h.q('.history-blocked')).toBeNull();
    const fresh = h.q<HTMLButtonElement>('.history-new')!;
    expect(fresh.disabled).toBe(true);
    expect(fresh.getAttribute('data-tip')).toMatch(/running prompt/);
    expect(fresh.getAttribute('aria-description')).toMatch(/running prompt/);
    expect(fresh.hasAttribute('title')).toBe(false);
  });

  it('sends new for New conversation', async () => {
    const h = await mount();
    await h.open();
    await h.click(h.q('.history-new'));
    expect(h.sent.at(-1)).toEqual({ type: 'new' });
    expect(h.q('.history')).toBeNull();
  });

  it('starts a new conversation from the collapsed rail without opening the panel', async () => {
    const h = await mount();
    await h.click(h.q('.history-rail-new'));
    expect(h.sent).toEqual([{ type: 'new' }]);
    expect(h.q('.history')).toBeNull();
  });

  it('turns the rail button off while a prompt runs, saying why', async () => {
    const h = await mount({ state: { status: 'busy' } });
    const fresh = h.q<HTMLButtonElement>('.history-rail-new')!;
    expect(fresh.disabled).toBe(true);
    expect(fresh.getAttribute('aria-description')).toMatch(/running prompt/);
  });

  it('opens the panel to show a refusal from the rail', async () => {
    const h = await mount({
      reply: m =>
        m.type === 'new' ? { kind: 'conflict', error: 'a turn is running' } : { kind: 'ok' },
    });
    await h.click(h.q('.history-rail-new'));
    expect(h.q('.history-error')?.textContent).toBe('A turn is running.');
  });

  it('names the total of a capped list in the filter, and no count when it is whole', async () => {
    const capped = await mount({ list: () => listOf({ total: 250 }) });
    await capped.open();
    expect(capped.q('.history-filter')?.getAttribute('placeholder')).toBe(
      'Filter all 250 sessions',
    );
    expect(capped.q('.history-note')).toBeNull();
    const whole = await mount({ list: () => listOf({ total: 2 }) });
    await whole.open();
    expect(whole.q('.history-filter')?.getAttribute('placeholder')).toBe('Filter sessions');
  });

  it('switches to the /save transcripts', async () => {
    const h = await mount({ list: m => listOf({ scope: m.scope, entries: [], total: 0 }) });
    await h.open();
    expect(h.q('.history-note')?.textContent).toBe('No saved sessions for this project yet.');
    // A browser toggles the box before the click event; linkedom does not.
    const toggle = h.q<HTMLInputElement>('.history-scope input')!;
    toggle.checked = true;
    await h.click(toggle);
    expect(h.sent.at(-1)).toEqual({ type: 'sessions', scope: 'root' });
    expect(h.q('.history-note')?.textContent).toBe('No /save transcripts yet.');
  });

  it('asks again when the open session changes under it', async () => {
    const h = await mount();
    await h.open();
    await h.render({ session: 'a.jsonl' });
    expect(h.sent.filter(m => m.type === 'sessions')).toHaveLength(2);
  });

  it('clears the filter when it closes', async () => {
    const h = await mount();
    await h.open();
    const box = h.q<HTMLInputElement>('.history-filter')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value')!.set!;
      setter.call(box, 'parser');
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await h.click(h.q('.history-close'));
    await h.open();
    expect(h.q<HTMLInputElement>('.history-filter')!.value).toBe('');
  });

  it('closes on Escape', async () => {
    const h = await mount();
    await h.open();
    await act(async () => {
      const e = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'key', { value: 'Escape' });
      h.q('.history-filter')!.dispatchEvent(e);
    });
    expect(h.q('.history')).toBeNull();
  });
});

describe('History as a pane', () => {
  const wide = async (opts: Opts = {}) => {
    env.wide = true;
    try {
      return await mount(opts);
    } finally {
      env.wide = false;
    }
  };

  it('is shown on load beside the page, not as a dialog, and leaves focus alone', async () => {
    env.stored.clear();
    const h = await wide();
    const pane = h.q('.history--pane');
    expect(pane).not.toBeNull();
    expect(pane!.getAttribute('role')).toBeNull();
    // Collapsed from its own header; the show button is not on the page while it is open.
    expect(h.q('.history--pane .history-close')!.getAttribute('aria-label')).toBe('Hide history');
    expect(h.q('.history-show')).toBeNull();
    expect(document.body.classList.contains('with-history')).toBe(true);
    expect(document.activeElement?.className).not.toBe('history-filter');
    expect(h.sent).toEqual([{ type: 'sessions', scope: 'project' }]);
  });

  it('stays shown after opening a session', async () => {
    env.stored.clear();
    const h = await wide();
    await h.click(h.rows()[1]);
    expect(h.sent.at(-1)).toEqual({ type: 'resume', scope: 'project', id: 'a.jsonl' });
    expect(h.q('.history--pane')).not.toBeNull();
  });

  it('collapses with its toggle and remembers that', async () => {
    env.stored.clear();
    const h = await wide();
    await h.click(h.q('.history--pane .history-close'));
    expect(h.q('.history')).toBeNull();
    expect(h.q('.history-show')!.getAttribute('aria-label')).toBe('Show history');
    expect(document.body.classList.contains('with-history')).toBe(false);
    const again = await wide();
    expect(again.q('.history')).toBeNull();
    await again.click(again.q('.history-show'));
    expect(again.q('.history--pane')).not.toBeNull();
    expect(env.stored.get('reika.history.pinned')).toBe('true');
  });

  it('turns rows off while a prompt runs, and asks again when it ends', async () => {
    env.stored.clear();
    const h = await wide({ state: { status: 'busy' } });
    expect(h.rows().some(r => r.disabled)).toBe(true);
    const asked = h.sent.filter(m => m.type === 'sessions').length;
    await h.render({ status: 'idle' });
    expect(h.rows().every(r => r.disabled === (r.getAttribute('aria-current') === 'true'))).toBe(
      true,
    );
    expect(h.sent.filter(m => m.type === 'sessions').length).toBe(asked + 1);
  });

  it('waits for the session before asking, and a good list clears a failed one', async () => {
    env.stored.clear();
    let fail = true;
    const h = await wide({
      signedIn: false,
      list: m => (fail ? null : listOf({ scope: m.scope })),
    });
    expect(h.sent).toEqual([]);
    await h.render({});
    expect(h.sent).toEqual([{ type: 'sessions', scope: 'project' }]);
    expect(h.q('.history-error')?.textContent).toBe('Could not list sessions.');
    fail = false;
    await h.render({ status: 'busy' });
    await h.render({});
    expect(h.q('.history-error')).toBeNull();
    expect(h.rows()).toHaveLength(2);
  });
});
