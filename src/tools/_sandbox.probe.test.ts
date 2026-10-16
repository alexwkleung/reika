import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { profileLoadFailure, resetSandboxCache } from './_sandbox.js';

// #738: a failure here makes `sandboxPlan` run the command unsandboxed, so the probe's verdicts and
// its cache are the boundary. The spawn is stubbed, so this runs off macOS, unlike bash.test.ts.
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<object>()),
  spawnSync: vi.fn(),
}));
const mockSpawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const ARGS = ['-p', '(version 1)(allow default)', '-D', 'WORKDIR=/repo/proj'];

describe('profileLoadFailure (#738)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetSandboxCache();
  });

  it('probes the exact args against a shell that does nothing', () => {
    mockSpawn.mockReturnValue({ status: 0, stderr: '' });
    expect(profileLoadFailure(ARGS)).toBe(null);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/sandbox-exec',
      [...ARGS, '/bin/sh', '-c', ':'],
      expect.objectContaining({ timeout: 5_000 }),
    );
  });

  it('reports a non-zero exit with its code and the first stderr line', () => {
    mockSpawn.mockReturnValue({ status: 65, stderr: 'sandbox-exec: unbound param\nmore\n' });
    expect(profileLoadFailure(ARGS)).toBe(
      'the sandbox profile failed to load (sandbox-exec exit 65: sandbox-exec: unbound param)',
    );
  });

  // The direction that matters: reading doubt as a failure would let a swapping machine switch the
  // sandbox off, where reading it as loaded costs at worst a command that fails closed.
  it('reads a timeout, a spawn error or a throw as loaded', () => {
    const timedOut = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    mockSpawn.mockReturnValueOnce({ status: null, signal: 'SIGTERM', error: timedOut, stderr: '' });
    expect(profileLoadFailure(ARGS)).toBe(null);

    resetSandboxCache();
    mockSpawn.mockReturnValueOnce({ status: null, signal: 'SIGKILL', stderr: '' });
    expect(profileLoadFailure(ARGS)).toBe(null);

    resetSandboxCache();
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('EAGAIN');
    });
    expect(profileLoadFailure(ARGS)).toBe(null);
  });

  it('probes once per argv, and the bindings are part of the key', () => {
    mockSpawn.mockReturnValue({ status: 65, stderr: '' });
    expect(profileLoadFailure(ARGS)).not.toBe(null);
    expect(profileLoadFailure(ARGS)).not.toBe(null);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    profileLoadFailure(['-p', ARGS[1], '-D', 'WORKDIR=/repo/other']);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('clears with the other sandbox caches', () => {
    mockSpawn.mockReturnValue({ status: 0, stderr: '' });
    profileLoadFailure(ARGS);
    resetSandboxCache();
    profileLoadFailure(ARGS);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
