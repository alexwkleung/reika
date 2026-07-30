import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type * as nodeOs from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// homedir() is mocked so the default-path truncation runs against a temp dir
// instead of the real ~/reika-debug.log.
let fakeHome: string;
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof nodeOs>();
  return { ...os, homedir: () => fakeHome };
});

// debugLog's once-per-process reset lives in module state, so each test imports
// a fresh copy of the module.
async function freshDebug() {
  vi.resetModules();
  return import('./debug.js');
}

describe('debugLog session reset (#114)', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'reika-debug-test-'));
    process.env.REIKA_DEBUG = '1';
    delete process.env.REIKA_DEBUG_FILE;
  });

  afterEach(() => {
    delete process.env.REIKA_DEBUG;
    delete process.env.REIKA_DEBUG_FILE;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('truncates the default log on the first write of a session', async () => {
    const path = join(fakeHome, 'reika-debug.log');
    writeFileSync(path, 'stale line from a previous session\n');

    const { debugLog } = await freshDebug();
    debugLog('first line of new session');

    expect(readFileSync(path, 'utf8')).toBe('first line of new session\n');
  });

  it('appends within the same session', async () => {
    const path = join(fakeHome, 'reika-debug.log');
    const { debugLog } = await freshDebug();
    debugLog('line one');
    debugLog('line two');

    expect(readFileSync(path, 'utf8')).toBe('line one\nline two\n');
  });

  it('never truncates an explicit REIKA_DEBUG_FILE', async () => {
    const path = join(fakeHome, 'experiment.log');
    process.env.REIKA_DEBUG_FILE = path;
    writeFileSync(path, 'run 1\n');

    const { debugLog } = await freshDebug();
    debugLog('run 2');

    expect(readFileSync(path, 'utf8')).toBe('run 1\nrun 2\n');
  });

  it('writes nothing when REIKA_DEBUG is unset', async () => {
    delete process.env.REIKA_DEBUG;
    const path = join(fakeHome, 'reika-debug.log');
    writeFileSync(path, 'untouched\n');

    const { debugLog } = await freshDebug();
    debugLog('should be dropped');

    expect(readFileSync(path, 'utf8')).toBe('untouched\n');
  });
});
