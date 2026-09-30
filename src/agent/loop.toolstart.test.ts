import ignore from 'ignore';
import { describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';

// The live in-flight row (#509). `onToolStart` is the only signal that spans a call which emits
// nothing while it runs — the UI's `↳ Running…` row — so what matters is its lifetime, not just that
// it fires: once per executed call, in dispatch order, before that call's result commits, and never
// for a call that runs nothing. Driven through the real runTurn.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');

function makeBundle(): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd: '/tmp',
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 10,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    bashIdleMs: 5000,
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

const inert = (name: string): Tool => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  run: async () => ({ summary: name }),
});

// One timeline of both signals, so the interleaving is what is asserted rather than two counts.
async function timeline(spec: { tools: Tool[]; rounds: ModelResponse[] }): Promise<string[]> {
  h.scripted.length = 0;
  h.scripted.push(...spec.rounds);
  const events: string[] = [];
  await runTurn({
    userInput: 'go',
    history: [],
    bundle: makeBundle(),
    config: makeConfig(),
    tools: spec.tools,
    payloads: new PayloadStore(),
    onToolStart: name => events.push(`start:${name}`),
    onMessage: m => {
      if (m.role === 'tool') events.push(`result:${m.summary}`);
    },
  });
  return events;
}

describe('runTurn — onToolStart (#509)', () => {
  it('announces each call before its own result, in dispatch order', async () => {
    const events = await timeline({
      tools: [inert('probe'), inert('other')],
      rounds: [
        {
          content: '',
          toolCalls: [
            { id: 'p1', name: 'probe', args: {} },
            { id: 'o1', name: 'other', args: {} },
          ],
        },
        { content: 'done', toolCalls: undefined },
      ],
    });
    expect(events).toEqual(['start:probe', 'result:probe', 'start:other', 'result:other']);
  });

  // The row exists to cover a call that is slow *and silent* — the ordinary tools never call
  // onProgress, so the announcement cannot be hung off the first output chunk.
  it('announces a call that emits no progress at all', async () => {
    const events = await timeline({
      tools: [inert('read')],
      rounds: [
        { content: '', toolCalls: [{ id: 'r1', name: 'read', args: { path: '/tmp/x' } }] },
        { content: 'done', toolCalls: undefined },
      ],
    });
    expect(events).toEqual(['start:read', 'result:read']);
  });

  // A call that resolves to no tool runs nothing, so a row for it would name work that never
  // happens. Same for the gated shapes around it (refused, held, bounced): all of them skip the
  // run and land on their own summary line.
  it('stays silent for a call that runs nothing', async () => {
    const events = await timeline({
      tools: [inert('probe')],
      rounds: [
        { content: '', toolCalls: [{ id: 'u1', name: 'nosuchtool', args: {} }] },
        { content: 'done', toolCalls: undefined },
      ],
    });
    expect(events).toEqual(['result:Unknown tool: nosuchtool']);
  });
});

// The committed half of the same chip (#585). `App`/`Scrollback` draw ` · 2m 05s` on the `↳ Ran:`
// row from `Message['tool'].durationMs` — and from nothing else. Where that number lives is the
// whole design: the summary is model-facing (it is what an aged result serializes into the request,
// what compaction counts and what `repeatKey` hashes to spot a repeated call), so a duration put in
// the text would make two identical commands look like different calls and spend context on every
// bash call forever.
async function toolMessages(spec: {
  tools: Tool[];
  rounds: ModelResponse[];
}): Promise<Array<Extract<Message, { role: 'tool' }>>> {
  h.scripted.length = 0;
  h.scripted.push(...spec.rounds);
  const out: Array<Extract<Message, { role: 'tool' }>> = [];
  await runTurn({
    userInput: 'go',
    history: [],
    bundle: makeBundle(),
    config: makeConfig(),
    tools: spec.tools,
    payloads: new PayloadStore(),
    onMessage: m => {
      if (m.role === 'tool') out.push(m);
    },
  });
  return out;
}

describe('runTurn — the call’s duration rides the message (#585)', () => {
  it('stamps the duration and leaves the summary bytes untouched', async () => {
    const summary = 'Ran: build (12 bytes output)';
    const tool: Tool = {
      name: 'bash',
      description: 'bash',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        await new Promise(r => setTimeout(r, 30));
        return { summary };
      },
    };
    const [msg] = await toolMessages({
      tools: [tool],
      rounds: [
        { content: '', toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'build' } }] },
        { content: 'done', toolCalls: undefined },
      ],
    });
    // Byte-identical: the timer is a field on the message, not text in the result.
    expect(msg.summary).toBe(summary);
    expect(msg.durationMs).toBeGreaterThanOrEqual(25);
  });

  // A call that never runs has no span to report — the same shape the in-flight row skips, so the
  // committed row shows nothing there either.
  it('stamps nothing on a call that runs nothing', async () => {
    const [msg] = await toolMessages({
      tools: [inert('probe')],
      rounds: [
        { content: '', toolCalls: [{ id: 'u1', name: 'nosuchtool', args: {} }] },
        { content: 'done', toolCalls: undefined },
      ],
    });
    expect(msg.durationMs).toBeUndefined();
  });
});
