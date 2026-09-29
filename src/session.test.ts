import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, ContextBundle, Message, Tool } from './types.js';
import type { ModelLimitsProbe } from './provider/modellimits.js';

const CONFIG: Config = {
  baseURL: 'http://127.0.0.1:1/v1',
  apiKey: 'test',
  model: 'test-model',
  models: ['test-model'],
  maxTurns: 10,
  repoMapBudget: 1000,
  autoApprove: 'off',
  subagentMaxTurns: 5,
  profiles: {
    default: { model: 'test-model', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' },
  },
  minGenTokens: 512,
  reasoningRounds: 1,
  maxSearchesPerTurn: 3,
  maxFetchesPerTurn: 3,
  bashTimeoutMs: 1000,
  bashIdleMs: 1000,
  pasteFetch: 'off',
  skillAuto: 'off',
  anon: false,
  sandbox: false,
};

const BUNDLE: ContextBundle = {
  projectSummary: '',
  repoMap: '',
  instructions: '',
  cwd: '/repo',
  hash: 'deadbeef',
  fileIndex: [],
  ignore: { ignores: () => false } as unknown as ContextBundle['ignore'],
  skills: [],
};

vi.mock('./context/bootstrap.js', () => ({ bootstrap: async () => BUNDLE }));
vi.mock('./tools/_net.js', async importActual => ({
  ...(await importActual<object>()),
  isOffline: () => false,
}));

const probes: ModelLimitsProbe[] = [];
const probeModelLimits = vi.fn(async () => probes.shift() ?? { reached: true });
vi.mock('./provider/modellimits.js', async importActual => ({
  ...(await importActual<object>()),
  probeModelLimits: () => probeModelLimits(),
}));

type TurnOpts = {
  userInput: string;
  manualCompact?: boolean;
  userDisplay?: string;
  history: Message[];
  config: Config;
  tools: Tool[];
  promptMode?: string;
  prefixTrace?: unknown;
  signal?: AbortSignal;
  bundle?: ContextBundle;
  nativeImages?: unknown[];
  priorCalibration?: number;
  priorPrefillRate?: number;
  priorDecodeRate?: number;
  priorShrink?: { sheds: number; folds: number };
  onMessage: (m: Message) => void;
  onCalibration?: (f: number) => void;
  onPrefillRate?: (r: number) => void;
  onDecodeRate?: (r: number | undefined) => void;
  onShrink?: (e: unknown, c: { sheds: number; folds: number }) => void;
  onUsage?: (u: { promptTokens: number; completionTokens: number }) => void;
};

const calls: TurnOpts[] = [];
// Whether the next plan-mode turn commits a plan (planFinal) or dead-ends.
let planWrites = true;
// Set to make the next turn throw, as a failed chat call does.
let throwNext: Error | null = null;

// Mirrors the real loop's contract: it pushes each committed message onto `opts.history` AND emits
// it, and reports the learned numbers through the callbacks.
const runTurn = vi.fn(async (opts: TurnOpts) => {
  calls.push(opts);
  const n = calls.length;
  if (throwNext) {
    const e = throwNext;
    throwNext = null;
    throw e;
  }
  // A manual compaction (#481) pushes no user turn and runs no reply round — the note request is
  // the only model call, and the loop emits harness notices instead of a user/assistant pair.
  if (opts.manualCompact) {
    opts.onMessage({
      role: 'system',
      content:
        'Context compacted (fold 1) — folded 3 earlier messages into a 0.5k-char recap (older tool output still re-readable).',
    });
    return;
  }
  const user: Message = { role: 'user', content: opts.userInput };
  opts.history.push(user);
  opts.onMessage(user);
  const reply: Message =
    opts.promptMode === 'plan'
      ? planWrites
        ? { role: 'assistant', content: '1. edit a.ts', planFinal: true }
        : { role: 'assistant', content: 'still looking' }
      : { role: 'assistant', content: 'done' };
  opts.history.push(reply);
  opts.onMessage(reply);
  opts.onCalibration?.(1 + n / 10);
  opts.onPrefillRate?.(100 * n);
  opts.onDecodeRate?.(10 * n);
  opts.onShrink?.({}, { sheds: n, folds: 0 });
  opts.onUsage?.({ promptTokens: 100, completionTokens: 10 });
});
vi.mock('./agent/loop.js', async importActual => ({
  ...(await importActual<object>()),
  runTurn: (opts: TurnOpts) => runTurn(opts),
}));

const { createSession, noWindowNotice } = await import('./session.js');

const text = (m: Message | undefined): string | undefined =>
  m && 'content' in m ? (m.content ?? undefined) : undefined;

beforeEach(() => {
  calls.length = 0;
  probes.length = 0;
  planWrites = true;
  throwNext = null;
  runTurn.mockClear();
  probeModelLimits.mockClear();
});

describe('createSession', () => {
  it('threads history, the prefix trace and every learned number from one turn to the next', async () => {
    const s = await createSession({ cwd: '/repo', config: CONFIG });
    await s.submit('first', { mode: 'agent' });
    await s.submit('second', { mode: 'agent' });

    const [a, b] = calls;
    expect(b.history).toBe(a.history);
    expect(b.prefixTrace).toBe(a.prefixTrace);
    expect(a.priorCalibration).toBeUndefined();
    expect(b.priorCalibration).toBe(1.1);
    expect(b.priorPrefillRate).toBe(100);
    expect(b.priorDecodeRate).toBe(10);
    expect(b.priorShrink).toEqual({ sheds: 1, folds: 0 });
    expect(s.shrink).toEqual({ sheds: 2, folds: 0 });
    expect(s.totals).toEqual({ promptTokens: 200, completionTokens: 20 });
    expect(s.history.map(text)).toEqual(['first', 'done', 'second', 'done']);
  });

  it('forwards the wrapped callbacks to the consumer after recording them', async () => {
    const onCalibration = vi.fn();
    const onMessage = vi.fn();
    const s = await createSession({
      cwd: '/repo',
      config: CONFIG,
      events: { onCalibration, onMessage },
    });
    await s.submit('hi', { mode: 'agent' });
    expect(onCalibration).toHaveBeenCalledWith(1.1);
    expect(onMessage.mock.calls.map(([m]) => m.content)).toEqual(['hi', 'done']);
  });

  it('tags each user message with the mode it was submitted under', async () => {
    const s = await createSession({ cwd: '/repo', config: CONFIG });
    const out = await s.submit('look around', { mode: 'plan' });
    expect(out[0]).toMatchObject({ role: 'user', mode: 'plan' });
  });

  it('offers no ask_user in any mode when nobody can answer', async () => {
    const s = await createSession({ cwd: '/repo', config: CONFIG, canAsk: false });
    for (const list of Object.values(s.lists)) {
      expect(list.map(t => t.name)).not.toContain('ask_user');
    }
    const asking = await createSession({ cwd: '/repo', config: CONFIG });
    expect(asking.lists.agent.map(t => t.name)).toContain('ask_user');
  });

  it("uses a submit's tool override over the mode's list", async () => {
    const s = await createSession({ cwd: '/repo', config: CONFIG });
    await s.submit('find it', { mode: 'agent', tools: s.lists.plan });
    expect(calls[0].tools).toBe(s.lists.plan);
    expect(calls[0].promptMode).toBe('agent');
  });

  // #290: plan mode's list is built from the config, not a constant — the one wiring step that would
  // silently drop `search` back out of the mode while every planTools test stayed green.
  it('builds the plan list with the configured search provider', async () => {
    const s = await createSession({ cwd: '/repo', config: CONFIG });
    const names = s.lists.plan.map(t => t.name);
    expect(names).toContain('fetch_url');
    expect(names).not.toContain('search');
    const withSearch = await createSession({
      cwd: '/repo',
      config: { ...CONFIG, searxngUrl: 'http://localhost:8888' },
    });
    expect(withSearch.lists.plan.map(t => t.name)).toContain('search');
  });

  describe('vibe', () => {
    it('runs the implement prompt as an agent turn after a written plan', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const out = await s.submit('add a flag', { mode: 'vibe' });
      expect(calls.map(c => c.promptMode)).toEqual(['plan', 'agent']);
      expect(calls[1].userDisplay).toBe('/implement (vibe)');
      expect(out.filter(m => m.role === 'user').map(m => m.mode)).toEqual(['vibe', 'vibe']);
    });

    it('skips implementation, and says so, when the plan phase wrote no plan', async () => {
      planWrites = false;
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const out = await s.submit('add a flag', { mode: 'vibe' });
      expect(calls).toHaveLength(1);
      expect(out.at(-1)).toMatchObject({ role: 'system' });
      expect(text(out.at(-1))).toMatch(/without a written plan/);
      expect(s.transcript.at(-1)).toBe(out.at(-1));
    });
  });

  describe('window probe', () => {
    it('asks again at the next submit when startup reached no server, notice after the echo', async () => {
      probes.push({ reached: false }, { reached: true, window: 24000, windowSource: 'endpoint' });
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      expect(s.config.contextWindow).toBeUndefined();

      const out = await s.submit('hi', { mode: 'agent' });
      expect(probeModelLimits).toHaveBeenCalledTimes(2);
      expect(calls[0].config.contextWindow).toBe(24000);
      expect(out.map(m => m.role)).toEqual(['user', 'system', 'assistant']);
      expect(text(out[1])).toMatch(/Context window of 24k tokens, from the endpoint/);

      await s.submit('again', { mode: 'agent' });
      expect(probeModelLimits).toHaveBeenCalledTimes(2);
    });

    it('lands the receipt after the opening line even on a /compact turn, which has no echo', async () => {
      probes.push(
        { reached: false },
        { reached: false },
        { reached: true, window: 24000, windowSource: 'endpoint' },
      );
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      await s.submit('hi', { mode: 'agent' });
      const out = await s.submit('compact', { mode: 'agent', manualCompact: true });
      expect(out.map(m => m.role)).toEqual(['system', 'system']);
      expect(text(out[0])).toMatch(/Context compacted/);
      expect(text(out[1])).toMatch(/Context window of 24k tokens, from the endpoint/);
    });

    it('does not ask again when the server answered without a window', async () => {
      probes.push({ reached: true });
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      await s.submit('hi', { mode: 'agent' });
      expect(probeModelLimits).toHaveBeenCalledTimes(1);
      expect(s.limitsNotice).toBeUndefined();
      expect(s.windowNotice).toMatch(/No context window known for test-model/);
    });

    it('warns after the retry when the server comes up without a window', async () => {
      probes.push({ reached: false }, { reached: true });
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      expect(s.windowNotice).toBeUndefined();
      const out = await s.submit('hi', { mode: 'agent' });
      const warn = out.find(m => m.role === 'system');
      expect(text(warn)).toMatch(/Set REIKA_CONTEXT_WINDOW/);
      expect(warn && 'tone' in warn ? warn.tone : undefined).toBe('warn');
    });

    it('warns only when a reached server left the window unknown', () => {
      const p = { model: 'm', baseURL: 'x', apiKey: 'k' };
      expect(noWindowNotice({ reached: true }, p)).toMatch(/No context window known for m/);
      expect(noWindowNotice({ reached: false }, p)).toBeUndefined();
      expect(noWindowNotice({ reached: true, window: 8000 }, p)).toBeUndefined();
      expect(noWindowNotice({ reached: true }, { ...p, contextWindow: 8000 })).toBeUndefined();
    });

    it('reports what the startup probe found', async () => {
      probes.push({ reached: true, window: 32000, windowSource: 'catalog' });
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      expect(s.config.contextWindow).toBe(32000);
      expect(s.limitsNotice).toMatch(/from the models.dev catalog/);
    });
  });

  describe('per-turn hooks', () => {
    it("brackets each of vibe's two turns, each with its own abort signal", async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const log: string[] = [];
      const signals: AbortSignal[] = [];
      await s.submit('add a flag', {
        mode: 'vibe',
        nativeImages: [{ marker: '[Image 1]', bytes: new Uint8Array(), mime: 'image/png' }],
        onTurnStart: () => {
          log.push('start');
          const c = new AbortController();
          signals.push(c.signal);
          return c.signal;
        },
        onTurnEnd: () => log.push('end'),
      });
      expect(log).toEqual(['start', 'end', 'start', 'end']);
      expect(calls.map(c => c.signal)).toEqual(signals);
      // The image rides the turn the user pasted into; the implement phase gets history's note.
      expect(calls[0].nativeImages).toHaveLength(1);
      expect(calls[1].nativeImages).toBeUndefined();
    });

    it('reports a failed turn and carries on — vibe then skips implementation', async () => {
      throwNext = new Error('connection refused');
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const errors: string[] = [];
      const out = await s.submit('add a flag', {
        mode: 'vibe',
        onTurnError: e => errors.push(e.message),
      });
      expect(errors).toEqual(['connection refused']);
      expect(calls).toHaveLength(1);
      expect(text(out.at(-1))).toMatch(/without a written plan/);
    });

    it('throws a failed turn when nobody handles it', async () => {
      throwNext = new Error('connection refused');
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      await expect(s.submit('hi', { mode: 'agent' })).rejects.toThrow('connection refused');
    });

    it("prefers a submit's own events over the session's", async () => {
      const sessionMessage = vi.fn();
      const submitMessage = vi.fn();
      const s = await createSession({
        cwd: '/repo',
        config: CONFIG,
        events: { onMessage: sessionMessage },
      });
      await s.submit('hi', { mode: 'agent', events: { onMessage: submitMessage } });
      expect(submitMessage).toHaveBeenCalledTimes(2);
      expect(sessionMessage).not.toHaveBeenCalled();
    });

    it('records the prompt as `recordAs` when it runs as something else', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const out = await s.submit('implement it', { mode: 'agent', recordAs: 'vibe' });
      expect(out[0]).toMatchObject({ role: 'user', mode: 'vibe' });
      expect(calls[0].promptMode).toBe('agent');
    });
  });

  describe('profiles', () => {
    const TWO: Config = {
      ...CONFIG,
      profiles: {
        ...CONFIG.profiles,
        vl: { model: 'vl-model', baseURL: 'http://127.0.0.1:2/v1', apiKey: 'k' },
      },
    };

    it('switches, tells subscribers, runs the next turn on it, and forgets the decode rate', async () => {
      const s = await createSession({ cwd: '/repo', config: TWO });
      await s.submit('warm up', { mode: 'agent' });
      expect(s.decodeRate).toBe(10);
      const heard = vi.fn();
      s.subscribe(heard);
      await s.setProfile('vl');
      expect(heard).toHaveBeenCalled();
      expect(s.getSnapshot().profile).toBe('vl');
      expect(s.decodeRate).toBeUndefined();
      await s.submit('hi', { mode: 'agent' });
      expect(calls[1].config.model).toBe('vl-model');
      expect(calls[1].priorDecodeRate).toBeUndefined();
    });

    it('returns what the probe learned, and asks again at submit when it reached nothing', async () => {
      const s = await createSession({ cwd: '/repo', config: TWO });
      probes.push({ reached: true, window: 32000, windowSource: 'endpoint' });
      expect((await s.setProfile('vl')).map(text)).toEqual([
        expect.stringMatching(/Context window of 32k tokens/),
      ]);
      expect(s.config.contextWindow).toBe(32000);

      const other = await createSession({ cwd: '/repo', config: TWO });
      probes.push({ reached: false }, { reached: true, window: 16000, windowSource: 'endpoint' });
      expect(await other.setProfile('vl')).toEqual([]);
      await other.submit('hi', { mode: 'agent' });
      expect(calls.at(-1)?.config.contextWindow).toBe(16000);
    });

    it('ignores an unknown profile', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      await s.setProfile('nope');
      expect(s.profile).toBe('default');
    });

    it('registers an ad-hoc profile that can be switched to at once', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      s.addProfile('adhoc', { model: 'try-me', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test' });
      await s.setProfile('adhoc');
      expect(s.config.model).toBe('try-me');
    });
  });

  describe('conversation state', () => {
    it('keeps chat history apart and restores each side on the way back', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      await s.submit('agent work', { mode: 'agent' });
      const agentHistory = s.history;
      s.switchSide('chat');
      expect(s.history).toEqual([]);
      await s.submit('a question', { mode: 'chat' });
      s.switchSide('agent');
      expect(s.history).toBe(agentHistory);
      s.switchSide('chat');
      expect(s.history.map(text)).toEqual(['a question', 'done']);
    });

    it('loads a resumed conversation into the active side and stashes the other', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const active: Message[] = [{ role: 'user', content: 'resumed agent' }];
      const other: Message[] = [{ role: 'user', content: 'resumed chat' }];
      s.loadHistory(active, other);
      expect(s.history).toBe(active);
      s.switchSide('chat');
      expect(s.history).toBe(other);
    });

    it('reset drops the conversation but keeps what it learned; relearn forgets that too', async () => {
      const TWO: Config = {
        ...CONFIG,
        profiles: { ...CONFIG.profiles, vl: { model: 'vl', baseURL: 'x', apiKey: 'k' } },
      };
      const s = await createSession({ cwd: '/repo', config: TWO });
      await s.setProfile('vl');
      await s.submit('hi', { mode: 'agent' });
      const trace = calls[0].prefixTrace;

      s.reset();
      expect(s.history).toEqual([]);
      expect(s.transcript).toEqual([]);
      expect(s.totals).toEqual({ promptTokens: 0, completionTokens: 0 });
      expect(s.shrink).toEqual({ sheds: 0, folds: 0 });
      expect(s.calibration).toBe(1.1);
      expect(s.profile).toBe('vl');
      await s.submit('again', { mode: 'agent' });
      expect(calls[1].prefixTrace).not.toBe(trace);
      expect(calls[1].priorCalibration).toBe(1.1);

      s.reset({ relearn: true });
      expect(s.calibration).toBeUndefined();
      expect(s.decodeRate).toBeUndefined();
      expect(s.profile).toBe('default');
    });

    it('updates the bundle and tells subscribers only when it changed', async () => {
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      const heard = vi.fn();
      s.subscribe(heard);
      s.updateBundle(b => b);
      expect(heard).not.toHaveBeenCalled();
      s.updateBundle(b => ({ ...b, fileIndex: ['new.ts'] }));
      expect(heard).toHaveBeenCalledTimes(1);
      expect(s.getSnapshot().bundle.fileIndex).toEqual(['new.ts']);
      await s.submit('hi', { mode: 'agent' });
      expect(calls[0].bundle?.fileIndex).toEqual(['new.ts']);
    });
  });
});

// A one-line MCP server, spawned for real: this is the wiring claim — that a configured server's
// tools reach `lists.agent` (and only that list) and that a broken one is a notice, not a failure.
const MINI_SERVER = [
  "const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let b='';",
  "process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;",
  "while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);",
  "if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mini'}}});",
  "else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ping',description:'Ping',inputSchema:{type:'object',properties:{}}}]}});}});",
].join('');

describe('MCP servers (#265)', () => {
  it("puts a configured server's tools in the agent list only, and reports the connection", async () => {
    const s = await createSession({
      cwd: '/repo',
      config: {
        ...CONFIG,
        mcpServers: [{ name: 'mini', command: process.execPath, args: ['-e', MINI_SERVER] }],
      },
    });
    try {
      expect(s.lists.agent.map(t => t.name)).toContain('mcp__mini__ping');
      // Opaque to the harness, so plan/chat/minimal/grind — whose guarantees are structural — do
      // not get it.
      for (const list of [s.lists.plan, s.lists.chat, s.lists.minimal, s.lists.grind]) {
        expect(list.map(t => t.name)).not.toContain('mcp__mini__ping');
      }
      expect(s.mcpNotices).toEqual([
        'MCP: mini (1 tool) — 1 tool added in agent mode. /mcp lists them.',
      ]);
    } finally {
      s.mcp.close();
    }
  });

  it('reports a config error and a server that will not start, and opens the session anyway', async () => {
    const s = await createSession({
      cwd: '/repo',
      config: {
        ...CONFIG,
        mcpServers: [{ name: 'broken', command: 'reika-no-such-binary-xyz', args: [] }],
        mcpErrors: ['REIKA_MCP_SERVERS: invalid JSON: unexpected token'],
      },
    });
    expect(s.mcpNotices[0]).toBe('REIKA_MCP_SERVERS: invalid JSON: unexpected token');
    expect(s.mcpNotices[1]).toContain('MCP server "broken" unavailable');
    expect(s.lists.agent.map(t => t.name).some(n => n.startsWith('mcp__'))).toBe(false);
  });
});
