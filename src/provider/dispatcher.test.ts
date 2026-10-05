import { afterEach, describe, expect, it } from 'vitest';
import {
  agentConstructor,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isStreamTimeout,
  requestTimeoutMs,
  resetStreamDispatcher,
  streamDispatcher,
  streamTimeoutMessage,
} from './dispatcher.js';

const PRIOR = process.env.REIKA_REQUEST_TIMEOUT_MS;

function setTimeoutEnv(v: string | undefined): void {
  if (v === undefined) delete process.env.REIKA_REQUEST_TIMEOUT_MS;
  else process.env.REIKA_REQUEST_TIMEOUT_MS = v;
  resetStreamDispatcher();
}

afterEach(() => setTimeoutEnv(PRIOR));

describe('requestTimeoutMs', () => {
  // Issue #382: a model streamed off SSD can sit silent for longer than any cap we'd pick, and
  // Esc already covers a server that really is hung — so the default is no stream timeout at all.
  it('defaults to no timeout when unset or blank', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(0);
    setTimeoutEnv(undefined);
    expect(requestTimeoutMs()).toBe(0);
    setTimeoutEnv('   ');
    expect(requestTimeoutMs()).toBe(0);
  });

  it('honors an explicit value, including 0 (wait indefinitely)', () => {
    setTimeoutEnv('90000');
    expect(requestTimeoutMs()).toBe(90_000);
    setTimeoutEnv('0');
    expect(requestTimeoutMs()).toBe(0);
  });

  // A typo must not turn into an instant-abort: the failure mode this whole file exists to fix.
  it('falls back to the default on garbage or a negative value', () => {
    setTimeoutEnv('soon');
    expect(requestTimeoutMs()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    setTimeoutEnv('-1');
    expect(requestTimeoutMs()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});

describe('streamDispatcher', () => {
  it('builds a dispatcher from the running undici and memoizes it', async () => {
    setTimeoutEnv(undefined);
    const a = await streamDispatcher();
    expect(a).toBeDefined();
    expect(typeof (a as { dispatch: unknown }).dispatch).toBe('function');
    expect(await streamDispatcher()).toBe(a);
  });

  it('names REIKA_REQUEST_TIMEOUT_MS and the configured seconds in the failure message', async () => {
    setTimeoutEnv('45000');
    await streamDispatcher();
    const msg = streamTimeoutMessage();
    expect(msg).toContain('REIKA_REQUEST_TIMEOUT_MS');
    expect(msg).toContain('45s');
  });
});

// The symbols are process-global, so each case stashes and restores both slots rather than
// trusting whichever Node runs the suite to exercise the layout under test.
describe('agentConstructor', () => {
  const V2 = Symbol.for('undici.globalDispatcher.2');
  const V1 = Symbol.for('undici.globalDispatcher.1');
  const g = globalThis as unknown as Record<symbol, unknown>;
  // An instance whose constructor carries `name`, which is all the resolver reads.
  function named(name: string): object {
    const ctor = { [name]: class {} }[name];
    return new ctor();
  }

  // undici defines both slots non-configurable (writable, not deletable), so an absent slot is
  // written as undefined, which is what the resolver's optional chaining reads it as anyway.
  async function withSlots(
    slots: { v2?: object; v1?: object },
    run: () => Promise<void>,
  ): Promise<void> {
    const saved = [g[V2], g[V1]];
    g[V2] = slots.v2;
    g[V1] = slots.v1;
    try {
      await run();
    } finally {
      g[V2] = saved[0];
      g[V1] = saved[1];
    }
  }

  it('takes the Agent off .2 on undici 8, past the .1 compatibility wrapper', async () => {
    const agent = named('Agent');
    await withSlots({ v2: agent, v1: named('Dispatcher1Wrapper') }, async () => {
      expect(await agentConstructor()).toBe(agent.constructor);
    });
  });

  it('takes the Agent off .1 on a pre-8 undici (Node 22/24)', async () => {
    const agent = named('Agent');
    await withSlots({ v1: agent }, async () => {
      expect(await agentConstructor()).toBe(agent.constructor);
    });
  });

  // A pre-8 `setGlobalDispatcher(new ProxyAgent(...))` writes .1 only; cloning .2's Agent would
  // drop the user's proxy, so this falls open like any non-Agent global.
  it('falls open when .1 was replaced by something other than the stock pair', async () => {
    await withSlots({ v2: named('Agent'), v1: named('ProxyAgent') }, async () => {
      expect(await agentConstructor()).toBeNull();
    });
  });

  it('falls open when the global dispatcher is not a plain Agent', async () => {
    await withSlots({ v2: named('MockAgent') }, async () => {
      expect(await agentConstructor()).toBeNull();
    });
  });
});

describe('isStreamTimeout', () => {
  it('recognizes undici header and body timeouts, wrapped or bare', () => {
    expect(
      isStreamTimeout(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' })),
    ).toBe(true);
    expect(isStreamTimeout(Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }))).toBe(
      true,
    );
    const wrapped = new TypeError('fetch failed');
    (wrapped as { cause?: unknown }).cause = Object.assign(new Error('t'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    expect(isStreamTimeout(wrapped)).toBe(true);
  });

  it('does not claim unrelated failures', () => {
    expect(isStreamTimeout(new Error('ECONNREFUSED'))).toBe(false);
    expect(isStreamTimeout(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }))).toBe(false);
    expect(isStreamTimeout(undefined)).toBe(false);
  });
});
