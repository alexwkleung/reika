import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { ClientMessage, WireDialog } from '../protocol.js';
import type { SendResult } from './send.js';
import type { OpenDialog } from './store.js';

const { window, document } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>',
);
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
const { ANSWERED_ELSEWHERE, Dialogs } = await import('./Dialogs.js');

type Pending = { message: ClientMessage; resolve: (r: SendResult) => void };

async function mount(dialog: WireDialog, opts: { reply?: SendResult; hold?: boolean } = {}) {
  const sent: ClientMessage[] = [];
  const pending: Pending[] = [];
  const send = (message: ClientMessage) => {
    sent.push(message);
    if (opts.hold) return new Promise<SendResult>(resolve => pending.push({ message, resolve }));
    return Promise.resolve<SendResult>(opts.reply ?? { kind: 'ok' });
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const dialogs: OpenDialog[] = [{ id: 'd1', dialog }];
  const counts = { restored: 0 };
  await act(async () =>
    root.render(
      <Dialogs dialogs={dialogs} send={send} onDontSend={() => void counts.restored++} />,
    ),
  );
  const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
  const button = (label: string) => {
    const b = buttons().find(x => x.textContent!.includes(label));
    if (!b)
      throw new Error(
        `no button ${label}: ${buttons()
          .map(x => x.textContent)
          .join(' | ')}`,
      );
    return b;
  };
  const click = (label: string) =>
    act(async () => {
      button(label).dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  const type = (value: string) =>
    act(async () => {
      const input = container.querySelector('input') as HTMLInputElement;
      setValue(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const key = (k: string, target: EventTarget = document.body) =>
    act(async () => {
      const e = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'key', { value: k });
      target.dispatchEvent(e);
    });
  return {
    sent,
    pending,
    get restored() {
      return counts.restored;
    },
    container,
    button,
    click,
    type,
    key,
    unmount: () => act(async () => root.unmount()),
  };
}

// React tracks an input's value through the prototype setter; going around it is how a test types.
function setValue(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

const approval: WireDialog = {
  kind: 'approval',
  tool: 'bash',
  subject: '/repo',
  preview: 'rm -rf build',
  warnings: ['Recursive delete'],
};

describe('approval', () => {
  it('Yes, Always and No send exactly the approval answers', async () => {
    for (const [label, expected] of [
      ['Yes', { type: 'answer', id: 'd1', kind: 'approval', answer: true }],
      [
        'Always this session',
        { type: 'answer', id: 'd1', kind: 'approval', answer: true, always: true },
      ],
      ['No', { type: 'answer', id: 'd1', kind: 'approval', answer: false }],
    ] as const) {
      const m = await mount(approval);
      expect(m.container.textContent).toContain('rm -rf build');
      expect(m.container.textContent).toContain('Recursive delete');
      await m.click(label);
      expect(m.sent).toEqual([expected]);
      await m.unmount();
    }
  });

  it('No with a typed reason declines with feedback', async () => {
    const m = await mount(approval);
    await m.type('  use the clean script  ');
    expect(m.button('No, with reason')).toBeDefined();
    await m.click('No');
    expect(m.sent).toEqual([
      { type: 'answer', id: 'd1', kind: 'approval', answer: { feedback: 'use the clean script' } },
    ]);
    await m.unmount();
  });

  it('a diff-shaped preview draws as a diff; a bash one as text', async () => {
    const edit = await mount({
      kind: 'approval',
      tool: 'edit',
      subject: 'a.ts',
      preview: '- old\n+ new',
      startLine: 4,
    });
    expect(edit.container.querySelector('.diff-row--added')).not.toBeNull();
    await edit.unmount();
    const bash = await mount(approval);
    expect(bash.container.querySelector('pre.dialog-preview')).not.toBeNull();
    await bash.unmount();
  });

  it('says what will happen: the command and where, or the file with its +/- count', async () => {
    const bash = await mount(approval);
    expect(bash.container.querySelector('.dialog-title')!.textContent).toBe(
      'Run a commandin /repo',
    );
    expect(bash.container.querySelector('.dialog-kicker')!.textContent).toBe('Approval needed');
    await bash.unmount();
    const edit = await mount({
      kind: 'approval',
      tool: 'edit',
      subject: 'src/a.ts',
      preview: '  keep\n- old\n+ new\n+ more',
    });
    expect(edit.container.querySelector('.dialog-title')!.textContent).toBe('Editsrc/a.ts+2 −1');
    await edit.unmount();
  });

  it('a double click answers once', async () => {
    const m = await mount(approval, { hold: true });
    await m.click('Yes');
    await m.click('Yes');
    await m.click('No');
    expect(m.sent).toHaveLength(1);
    expect(m.button('Yes').disabled).toBe(true);
    await act(async () => m.pending[0]!.resolve({ kind: 'ok' }));
    await m.unmount();
  });

  it('a conflict says another tab answered and keeps the buttons off', async () => {
    const m = await mount(approval, {
      reply: { kind: 'conflict', error: 'no open approval dialog d1' },
    });
    await m.click('Yes');
    expect(m.container.textContent).toContain(ANSWERED_ELSEWHERE);
    expect(m.button('No').disabled).toBe(true);
    await m.unmount();
  });

  it('another failure shows its text and leaves the dialog answerable', async () => {
    const m = await mount(approval, {
      reply: { kind: 'failed', status: 400, error: 'bad answer' },
    });
    await m.click('Yes');
    expect(m.container.textContent).toContain('bad answer');
    expect(m.button('Yes').disabled).toBe(false);
    await m.unmount();
  });

  it('a digit picks a numbered row, but not from a text field', async () => {
    const m = await mount(approval);
    await m.key('3', m.container.querySelector('input')!);
    expect(m.sent).toEqual([]);
    await m.key('1');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'approval', answer: true }]);
    await m.unmount();
  });
});

describe('question', () => {
  const question: WireDialog = {
    kind: 'question',
    question: 'Which one?',
    options: [
      { label: 'A', description: 'the first' },
      { label: 'B', recommended: true },
    ],
  };

  it('an option, a typed answer and cancel', async () => {
    let m = await mount(question);
    expect(m.container.textContent).toContain('the first');
    expect(m.container.textContent).toContain('Recommended');
    await m.click('B');
    expect(m.sent).toEqual([
      { type: 'answer', id: 'd1', kind: 'question', answer: { text: 'B', index: 1 } },
    ]);
    await m.unmount();
    m = await mount(question);
    await m.type('neither');
    await m.click('Send answer');
    expect(m.sent).toEqual([
      { type: 'answer', id: 'd1', kind: 'question', answer: { text: 'neither' } },
    ]);
    await m.unmount();
    m = await mount(question);
    await m.click('Skip question');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'question', answer: null }]);
    await m.unmount();
  });
});

describe('confirm, model and session', () => {
  it('confirm picks a row or aborts, with the initial row marked', async () => {
    const d: WireDialog = {
      kind: 'confirm',
      title: 'Skill',
      subtitle: '/review — review a PR',
      details: ['matched: review'],
      options: ['Send as typed', 'Apply /review'],
      accept: 'apply',
      initial: 1,
    };
    let m = await mount(d);
    expect(m.button('Apply /review').className).toContain('dialog-button--current');
    expect(m.container.textContent).toContain('matched: review');
    await m.click('Send as typed');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'confirm', choice: 0 }]);
    await m.unmount();
    m = await mount(d);
    await m.click('Don’t send');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'confirm', choice: 'abort' }]);
    expect(m.restored).toBe(1);
    await m.unmount();
  });

  it('model picks a target by name or cancels', async () => {
    const d: WireDialog = {
      kind: 'model',
      targets: [
        {
          name: 'default',
          model: 'local',
          baseURL: 'http://127.0.0.1:1/v1',
          kind: 'profile',
          active: true,
        },
        {
          name: 'big',
          model: 'big-model',
          baseURL: 'http://127.0.0.1:2/v1',
          kind: 'profile',
          active: false,
        },
      ],
    };
    let m = await mount(d);
    await m.click('big');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'model', name: 'big' }]);
    await m.unmount();
    m = await mount(d);
    await m.click('Cancel');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'model', name: null }]);
    await m.unmount();
  });

  it('session picks an entry by id or cancels', async () => {
    const d: WireDialog = {
      kind: 'session',
      heading: 'Sessions in this project',
      entries: [
        {
          id: 's1.jsonl',
          title: 'Fix the parser',
          savedAt: '2026-11-01 10:00',
          messageCount: 12,
        },
      ],
    };
    let m = await mount(d);
    expect(m.container.textContent).toContain('12 msgs');
    await m.click('Fix the parser');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'session', session: 's1.jsonl' }]);
    await m.unmount();
    m = await mount(d);
    await m.click('Cancel');
    expect(m.sent).toEqual([{ type: 'answer', id: 'd1', kind: 'session', session: null }]);
    await m.unmount();
  });
});
