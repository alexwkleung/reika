import { afterEach, describe, expect, it } from 'vitest';
import {
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
  it('defaults when unset or blank', () => {
    setTimeoutEnv(undefined);
    expect(requestTimeoutMs()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    setTimeoutEnv('   ');
    expect(requestTimeoutMs()).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
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
