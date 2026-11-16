import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import type { Message } from '../types.js';
import { clearIdentity, setIdentity } from '../ui/identity.js';
import { scrubDisplay, scrubOutput } from '../ui/scrub.js';
import type { WireDialog, WireState } from './protocol.js';
import {
  createStreamScrubber,
  scrubCompletion,
  scrubDialog,
  scrubMessage,
  scrubState,
  UNSCRUBBED_KEYS,
} from './scrubwire.js';

const HOME = homedir();
const CWD = `${HOME}/proj`;
// A home path outside the project, the identity and a secret, in one string.
const LEAK = `see ${HOME}/notes/x.md by Mona Lisa <octocat@example.com>`;

afterEach(() => clearIdentity());

function anon(): void {
  setIdentity({ names: ['Mona Lisa', 'octocat'], emails: ['octocat@example.com'] });
}

type Role<R extends Message['role']> = Required<Extract<Message, { role: R }>>;

// Every field of every role, each string holding the leak. A field added to Message fails to
// compile here until it is listed, and then the test below holds it to the scrub.
const user: Role<'user'> = {
  role: 'user',
  content: LEAK,
  display: LEAK,
  nested: false,
  meta: false,
  harness: false,
  mode: 'agent',
  skill: LEAK,
};
const assistant: Role<'assistant'> = {
  role: 'assistant',
  content: `${LEAK}\n\n---\nnote ${LEAK}`,
  toolCalls: [{ id: 'c1', name: 'read', args: { path: LEAK, deep: { at: [LEAK] } } }],
  reasoning: LEAK,
  durationMs: 1,
  sources: [LEAK],
  nested: false,
  compactionNote: false,
  discarded: 'stream',
  harnessStop: 'loop',
  planFinal: true,
  planChecks: { at: LEAK.length, missing: [LEAK], deadUrls: [{ url: LEAK, error: LEAK }] },
  reasoningAged: false,
  continuationTail: false,
};
const tool: Role<'tool'> = {
  role: 'tool',
  callId: 'c1',
  summary: LEAK,
  payload: LEAK,
  payloadId: LEAK,
  aged: false,
  rendered: LEAK,
  diff: { text: `+ ${LEAK}\n- ${LEAK}`, path: LEAK, added: 1, removed: 1, startLine: 1 },
  command: { text: LEAK, outputTail: LEAK, outputTruncated: false },
  changes: {
    files: [
      {
        path: LEAK,
        kind: 'modified',
        hunks: [{ text: `+ ${LEAK}`, startLine: 1, oldStartLine: 1 }],
        added: 1,
        removed: 0,
        omitted: 0,
      },
    ],
    more: 0,
  },
  exitCode: 0,
  durationMs: 1,
  nested: false,
};
const error: Role<'error'> = { role: 'error', content: LEAK, nested: false };
const system: Role<'system'> = {
  role: 'system',
  content: LEAK,
  tone: 'info',
  emphasis: 'line',
  nested: false,
  planWaived: [1],
  skipAutosave: false,
};
const compaction: Role<'compaction'> = { role: 'compaction', content: LEAK, nested: false };
const shell: Role<'shell'> = { role: 'shell', command: LEAK, output: LEAK, nested: false };

const ALL: Message[] = [user, assistant, tool, error, system, compaction, shell];

function leaves(value: unknown, key = ''): { key: string; text: string }[] {
  if (typeof value === 'string') return [{ key, text: value }];
  if (Array.isArray(value)) return value.flatMap(v => leaves(v, key));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, k));
}

const leaked = (text: string): boolean =>
  text.includes(HOME) ||
  text.includes('Mona Lisa') ||
  text.includes('octocat') ||
  text.includes(`${HOME.split('/').at(-1)}/`);

describe('scrubMessage', () => {
  it.each(ALL.map(m => [m.role, m] as const))(
    'leaves no home path or identity in a %s message',
    (_role, msg) => {
      anon();
      const wire = scrubMessage(msg, CWD);
      const raw = leaves(wire).filter(l => leaked(l.text));
      expect(raw.filter(l => !(UNSCRUBBED_KEYS as readonly string[]).includes(l.key))).toEqual([]);
    },
  );

  it('folds the user display into content and sends no display', () => {
    const wire = scrubMessage({ role: 'user', content: '<file>big</file> hi', display: 'hi' }, CWD);
    expect(wire).toEqual({ role: 'user', content: 'hi' });
  });

  it('sends the prose before planChecks.at alone, with at at its end', () => {
    const prose = `edit ${CWD}/src/a.ts`;
    const wire = scrubMessage(
      {
        role: 'assistant',
        content: `${prose}\n\n---\nNot found: ${HOME}/x`,
        planChecks: { at: prose.length, missing: [`${HOME}/x`], deadUrls: [] },
      },
      CWD,
    );
    expect(wire).toMatchObject({
      content: 'edit src/a.ts',
      planChecks: { at: 'edit src/a.ts'.length, missing: ['~/x'] },
    });
  });

  it('drops the args no row draws', () => {
    const wire = scrubMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c', name: 'write', args: { path: `${CWD}/a.ts`, content: 'the whole file' } },
        ],
      },
      CWD,
    );
    expect(wire).toMatchObject({ toolCalls: [{ id: 'c', name: 'write', args: { path: 'a.ts' } }] });
  });

  it('scrubs every leaf of a tool’s args, whatever its keys are called', () => {
    // An MCP server's schema is not ours: `name`, `id` and `kind` here are paths, not enums.
    const wire = scrubMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'c',
            name: 'mcp__fs__open',
            args: { name: `${HOME}/a.md`, id: `${HOME}/b`, nested: { kind: `${HOME}/c` } },
          },
        ],
      },
      CWD,
    );
    const args = (wire as { toolCalls: { args: Record<string, unknown> }[] }).toolCalls[0].args;
    expect(JSON.stringify(args)).not.toContain(HOME);
    expect(args.name).toBe('~/a.md');
  });

  it('keeps a diff its row count', () => {
    const text = `  a\n- ${HOME}/x\n+ ${HOME}/y`;
    const wire = scrubMessage(
      {
        role: 'tool',
        callId: 'c',
        summary: 'Edited',
        diff: { text, path: 'a', added: 1, removed: 1 },
      },
      CWD,
    );
    expect(wire).toMatchObject({ diff: { text: '  a\n- ~/x\n+ ~/y' } });
  });

  it('leaves the model history object alone', () => {
    const msg: Message = { role: 'error', content: LEAK };
    scrubMessage(msg, CWD);
    expect(msg.content).toBe(LEAK);
  });
});

const state = (over: Partial<WireState> = {}): WireState =>
  ({
    error: null,
    cwd: CWD,
    queue: [],
    pr: { number: 7, url: 'https://github.com/octocat/reika/pull/7' },
    ...over,
  }) as WireState;

describe('scrubState', () => {
  it('shows the cwd as the TUI does and scrubs the error and queue', () => {
    const out = scrubState(
      state({ error: `failed: ${HOME}/x`, queue: [{ content: `${CWD}/a.ts`, images: 0 }] }),
    );
    expect(out).toMatchObject({
      cwd: '~/proj',
      error: 'failed: ~/x',
      queue: [{ content: 'a.ts' }],
    });
  });

  it('drops the PR link under /anon, whose href names the owner', () => {
    expect(scrubState(state()).pr).toEqual({
      number: 7,
      url: 'https://github.com/octocat/reika/pull/7',
    });
    anon();
    expect(scrubState(state()).pr).toEqual({ number: 7 });
  });
});

describe('scrubDialog', () => {
  it('masks no secret in an approval preview, but scrubs its paths', () => {
    const dialog: WireDialog = {
      kind: 'approval',
      tool: 'bash',
      subject: `cat ${HOME}/x`,
      preview: `export TOKEN=ghp_${'a'.repeat(36)}\ncat ${HOME}/x`,
    };
    const out = scrubDialog(dialog, CWD);
    expect(out).toMatchObject({
      subject: 'cat ~/x',
      preview: `export TOKEN=ghp_${'a'.repeat(36)}\ncat ~/x`,
    });
  });

  it('scrubs question options and confirm details', () => {
    anon();
    const question = scrubDialog(
      { kind: 'question', question: 'Mona Lisa?', options: [{ label: `${HOME}/a` }] },
      CWD,
    );
    expect(question).toEqual({
      kind: 'question',
      question: '<user>?',
      options: [{ label: '~/a' }],
    });
  });
});

describe('scrubCompletion', () => {
  it('scrubs what an item shows and keeps what it inserts', () => {
    const out = scrubCompletion(
      {
        kind: 'file',
        partial: '@no',
        items: [{ value: `@${HOME}/notes`, display: `${HOME}/notes` }],
      },
      CWD,
    );
    expect(out?.items).toEqual([{ value: `@${HOME}/notes`, display: '~/notes' }]);
  });
});

// What a tab holds after folding the deltas.
function fold(chunks: string[], scrub = (s: string) => scrubOutput(s, CWD)) {
  const scrubber = createStreamScrubber(scrub);
  let shown = '';
  const sent: string[] = [];
  for (const chunk of chunks) {
    const out = scrubber.push(chunk);
    if (!out) continue;
    shown = shown.slice(0, shown.length - out.drop) + out.text;
    sent.push(shown);
  }
  return { shown, sent, scrubber };
}

describe('createStreamScrubber', () => {
  it('never paints part of a path split across deltas', () => {
    const whole = `ls ${HOME}/proj/a.ts\n`;
    const cuts = [5, HOME.length - 3, HOME.length + 4];
    const chunks = [whole.slice(0, cuts[0])];
    for (let i = 0; i < cuts.length; i++) chunks.push(whole.slice(cuts[i], cuts[i + 1]));
    const { shown, sent } = fold(chunks);
    for (const s of sent) expect(s).not.toContain(HOME.slice(0, 4) + HOME.slice(4, -2));
    expect(shown).toBe(scrubOutput(whole, CWD));
  });

  it('holds the trailing word until a space or break ends it', () => {
    const prose = (s: string) => scrubDisplay(s, CWD);
    const { shown, scrubber } = fold(['hello wor', 'ld'], prose);
    expect(shown).toBe('hello ');
    expect(scrubber.text()).toBe('hello ');
    expect(fold(['hello wor', 'ld '], prose).shown).toBe('hello world ');
  });

  it('takes back text a completed match replaces', () => {
    anon();
    const scrub = (s: string) => scrubDisplay(s, CWD);
    const { shown, sent } = fold(['by Mona ', 'Lisa today\n'], scrub);
    expect(sent[0]).toBe('by Mona ');
    expect(shown).toBe('by <user> today\n');
  });

  it('redraws a carriage-return progress line with drop', () => {
    const scrubber = createStreamScrubber(s => scrubOutput(s, CWD));
    scrubber.push('10% ');
    const out = scrubber.push('\r50% ');
    // Trailing blanks are not drawn, as a terminal shows them.
    expect(out).toEqual({ drop: 3, text: '50%' });
  });

  it('matches the whole text scrubbed at once, chunked at every offset', () => {
    const whole = `a ${HOME}/x b\n${CWD}/y.ts c\r\nd `;
    for (let at = 1; at < whole.length; at++) {
      expect(fold([whole.slice(0, at), whole.slice(at)]).shown).toBe(scrubOutput(whole, CWD));
    }
  });

  it('resets to a new text', () => {
    const scrubber = createStreamScrubber(s => scrubOutput(s, CWD));
    scrubber.push('one two ');
    scrubber.reset(`${HOME}/a b`);
    expect(scrubber.raw).toBe(`${HOME}/a b`);
    expect(scrubber.text()).toBe('~/a');
  });
});
