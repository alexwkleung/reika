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
  userDisplay?: string;
  history: Message[];
  config: Config;
  tools: Tool[];
  promptMode?: string;
  prefixTrace?: unknown;
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

// Mirrors the real loop's contract: it pushes each committed message onto `opts.history` AND emits
// it, and reports the learned numbers through the callbacks.
const runTurn = vi.fn(async (opts: TurnOpts) => {
  calls.push(opts);
  const n = calls.length;
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

const { createSession } = await import('./session.js');

const text = (m: Message | undefined): string | undefined =>
  m && 'content' in m ? (m.content ?? undefined) : undefined;

beforeEach(() => {
  calls.length = 0;
  probes.length = 0;
  planWrites = true;
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

    it('does not ask again when the server answered without a window', async () => {
      probes.push({ reached: true });
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      await s.submit('hi', { mode: 'agent' });
      expect(probeModelLimits).toHaveBeenCalledTimes(1);
      expect(s.limitsNotice).toBeUndefined();
    });

    it('reports what the startup probe found', async () => {
      probes.push({ reached: true, window: 32000, windowSource: 'catalog' });
      const s = await createSession({ cwd: '/repo', config: CONFIG });
      expect(s.config.contextWindow).toBe(32000);
      expect(s.limitsNotice).toMatch(/from the models.dev catalog/);
    });
  });
});
