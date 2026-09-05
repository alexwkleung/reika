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

describe('formatExperimentFlags', () => {
  // Written after an A/B was lost to an arm run from a build that did not contain the feature: the
  // flag it set was read by nothing, and by filename the two arms looked like a clean on/off pair.
  const clear = (): void => {
    for (const k of Object.keys(process.env)) if (k.startsWith('REIKA_')) delete process.env[k];
  };

  it('reports numeric flag values verbatim, sorted, so two logs diff cleanly', async () => {
    clear();
    process.env.REIKA_PREFIX_STABLE = '1';
    process.env.REIKA_DROPPED_LEDGER = '0';
    process.env.REIKA_CONTEXT_WINDOW = '16384';
    const { formatExperimentFlags } = await freshDebug();
    const line = formatExperimentFlags();
    expect(line).toContain('context-window=16384');
    expect(line).toContain('dropped-ledger=0');
    expect(line).toContain('prefix-stable=1');
    expect(line.indexOf('context-window')).toBeLessThan(line.indexOf('dropped-ledger'));
  });

  // #253: a fraction-valued tuning flag rendered as `set` makes the two arms of an A/B on that very
  // value indistinguishable in their own logs — the mislabel this line exists to prevent.
  it('reports a decimal tuning value verbatim, not as `set`', async () => {
    clear();
    process.env.REIKA_AGE_LOW_FRACTION = '0.5';
    const { formatExperimentFlags } = await freshDebug();
    expect(formatExperimentFlags()).toContain('age-low-fraction=0.5');
  });

  it('never writes a non-numeric value — keys, URLs and home paths stay out of the log', async () => {
    clear();
    process.env.REIKA_DEBUG_FILE = '/Users/someone/private/on.log';
    process.env.REIKA_SEARXNG_URL = 'http://localhost:8888';
    const { formatExperimentFlags } = await freshDebug();
    const line = formatExperimentFlags();
    expect(line).toContain('debug-file=set');
    expect(line).toContain('searxng-url=set');
    expect(line).not.toContain('/Users/someone');
    expect(line).not.toContain('localhost:8888');
  });

  it('says so when nothing is set, rather than emitting a bare line', async () => {
    clear();
    const { formatExperimentFlags } = await freshDebug();
    expect(await freshDebug().then(m => m.formatExperimentFlags())).toContain('(none set)');
    expect(formatExperimentFlags()).toContain('version=');
  });
});
