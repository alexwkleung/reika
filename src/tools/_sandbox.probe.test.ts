import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_PROFILE_ERROR_CODE, resetSandboxCache, sandboxProfileLoads } from './_sandbox.js';

// #707: `bash.ts` re-runs a command unsandboxed only when this probe says the profile itself cannot
// load, so the probe's verdicts and its caching ARE the security boundary — and both are readable
// without a sandbox, since the spawn is what is stubbed here.
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<object>()),
  spawnSync: vi.fn(),
}));
const mockSpawn = spawnSync as unknown as ReturnType<typeof vi.fn>;

const ARGS = ['-p', '(version 1)(allow default)', '-D', 'WORKDIR=/repo/proj'];

describe('sandboxProfileLoads (#707)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetSandboxCache();
  });

  // The probe runs the profile and nothing else: `/usr/bin/true` writes nothing, reads nothing and
  // cannot print `sandbox-exec:` or exit 65, which is what makes a 65 from it proof of the generator
  // rather than of the command under it.
  it('runs the same profile against /usr/bin/true', () => {
    mockSpawn.mockReturnValue({ status: 0 });
    expect(sandboxProfileLoads(ARGS)).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/sandbox-exec', [...ARGS, '/usr/bin/true'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
  });

  // 65 is the profile — a syntax error, or a `(param …)` nothing bound. Everything else answers
  // "loads": 0 is a healthy profile, 71 is one that parses but cannot be applied (nested inside
  // another seatbelt sandbox), 1 is some other failure, and a spawn that never happened has no
  // status at all. The caller reads this function's `false` as "re-run the command unconfined", so
  // doubt has to fail closed.
  it('reads only the profile error code as a failure to load', () => {
    const cells: [number | null, boolean][] = [
      [0, true],
      [71, true],
      [1, true],
      [null, true],
      [SANDBOX_PROFILE_ERROR_CODE, false],
    ];
    for (const [status, loads] of cells) {
      mockSpawn.mockReturnValue({ status });
      resetSandboxCache();
      expect(sandboxProfileLoads(ARGS), `status=${status}`).toBe(loads);
    }
  });

  it('treats a probe that threw as no proof, not as a broken profile', () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('EAGAIN');
    });
    expect(sandboxProfileLoads(ARGS)).toBe(true);
  });

  // The cost the cache exists to bound: with a real generator bug EVERY command in the cwd exits 65,
  // so an uncached probe would spawn `/usr/bin/true` once per command.
  it('probes once per profile, not once per command', () => {
    mockSpawn.mockReturnValue({ status: SANDBOX_PROFILE_ERROR_CODE });
    expect(sandboxProfileLoads(ARGS)).toBe(false);
    expect(sandboxProfileLoads(ARGS)).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  // An unbound `(param …)` exits 65 as well, and the `-D` bindings are per cwd — so a cache keyed on
  // the profile text alone would carry one cwd's verdict into the next.
  it('keys the cache on the bindings as well as the profile', () => {
    mockSpawn.mockReturnValue({ status: 0 });
    expect(sandboxProfileLoads(ARGS)).toBe(true);
    expect(sandboxProfileLoads(['-p', ARGS[1], '-D', 'WORKDIR=/repo/other'])).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('clears with the rest of the sandbox caches, so each test starts from a clean probe', () => {
    mockSpawn.mockReturnValue({ status: 0 });
    sandboxProfileLoads(ARGS);
    resetSandboxCache();
    sandboxProfileLoads(ARGS);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});
