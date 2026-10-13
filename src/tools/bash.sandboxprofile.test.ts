import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bashTool } from './bash.js';

// #707's other half: a profile that really does fail to load still fails OPEN — the command is
// re-run unsandboxed, once, with the warn that says so.
//
// Only the GENERATOR is stubbed (breaking it needs a source change, not a test), and the broken
// profile goes to the real `sandbox-exec`: the 65 this drives is the real binary refusing a profile,
// and the probe is the real probe. That is also why it needs no working sandbox — a profile is
// parsed BEFORE it is applied, so the same 65 arrives nested inside another seatbelt sandbox, where
// no command would otherwise run at all.
vi.mock('./_sandbox.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  sandboxPlan: () => ({ args: ['-p', '(version 1'] }),
}));

const hasSandboxExec = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

describe('bashTool — sandbox profile failure (#707)', () => {
  it.skipIf(!hasSandboxExec)('re-runs the command unsandboxed, once, and says so', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-profile-'));
    try {
      const r = await bashTool.run(
        {
          command:
            'echo run >> runs.txt; echo "sandbox-exec: syntax error: expecting \')\'"; exit 65',
        },
        { cwd: dir },
      );
      expect(r.notice?.tone).toBe('warn');
      expect(r.notice?.content).toContain('re-ran unsandboxed');
      expect(r.exitCode).toBe(65);
      // The command ran, and NOTHING the sandboxed attempt produced is in here: a profile that fails
      // to parse runs nothing, so both of these are the retry's.
      expect(await readFile(join(dir, 'runs.txt'), 'utf8')).toBe('run\n');
      expect(r.payload).toContain('sandbox-exec: syntax error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
