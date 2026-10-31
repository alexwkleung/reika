import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type * as nodeOs from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// homedir() is mocked so the per-session logs land in a temp dir instead of the real
// ~/.config/reika/logs.
let fakeHome: string;
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof nodeOs>();
  return { ...os, homedir: () => fakeHome };
});

// The session stem and the once-per-process header live in module state, so each test imports a
// fresh copy of the module.
async function freshDebug() {
  vi.resetModules();
  return import('./debug.js');
}

const logsDir = (): string => join(fakeHome, '.config', 'reika', 'logs');

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

describe('per-session debug log (#761)', () => {
  it('writes one file per session under logs/, named by the session stem', async () => {
    const { debugLog, debugLogPath, processSessionStem } = await freshDebug();
    debugLog('line one');
    debugLog('line two');

    expect(debugLogPath()).toBe(join(logsDir(), `${processSessionStem()}.log`));
    expect(processSessionStem()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}$/);
    const lines = readFileSync(debugLogPath(), 'utf8').split('\n');
    expect(lines[0]).toMatch(new RegExp(`^\\[reika:debug\\] session pid=${process.pid} version=`));
    expect(lines.slice(1)).toEqual(['line one', 'line two', '']);
  });

  it('leaves the previous session alone and repoints latest.log at the new one', async () => {
    const first = await freshDebug();
    first.debugLog('session one');
    const firstPath = first.debugLogPath();
    const second = await freshDebug();
    second.debugLog('session two');

    expect(second.debugLogPath()).not.toBe(firstPath);
    expect(readFileSync(firstPath, 'utf8')).toContain('session one');
    const latest = join(logsDir(), 'latest.log');
    expect(lstatSync(latest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(latest)).toBe(`${second.processSessionStem()}.log`);
    expect(readFileSync(latest, 'utf8')).toContain('session two');
    expect(readdirSync(logsDir()).filter(n => n.startsWith('.'))).toEqual([]);
  });

  it('pairs the auto-save file with the log through the shared stem', async () => {
    const { processSessionStem } = await freshDebug();
    const { newSessionPath } = await import('./store/sessions.js');
    expect(newSessionPath('/h/p', new Date(), processSessionStem())).toBe(
      `/h/p/${processSessionStem()}.jsonl`,
    );
  });

  it('appends to an explicit REIKA_DEBUG_FILE with no header and no latest.log', async () => {
    const path = join(fakeHome, 'experiment.log');
    process.env.REIKA_DEBUG_FILE = path;
    writeFileSync(path, 'run 1\n');

    const { debugLog, debugLogPath } = await freshDebug();
    debugLog('run 2');

    expect(debugLogPath()).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('run 1\nrun 2\n');
    expect(() => readdirSync(logsDir())).toThrow();
  });

  it('writes nothing when REIKA_DEBUG is unset', async () => {
    delete process.env.REIKA_DEBUG;
    const { debugLog } = await freshDebug();
    debugLog('should be dropped');
    expect(() => readdirSync(logsDir())).toThrow();
  });
});

describe('sweepDebugLogs (#761)', () => {
  const NOW = Date.parse('2026-10-19T12:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  let n = 0;

  // A log `ageDays` old of `size` bytes, owned by `pid` when given. Names sort by creation order,
  // but the sweep must order by mtime, so they are deliberately unrelated to age.
  function log(ageDays: number, size = 10, pid?: number): string {
    mkdirSync(logsDir(), { recursive: true });
    const path = join(
      logsDir(),
      `2026-10-01T00-00-00-000Z-${(n++).toString(16).padStart(6, '0')}.log`,
    );
    const header = pid === undefined ? '' : `[reika:debug] session pid=${pid} version=0\n`;
    writeFileSync(path, header + 'x'.repeat(Math.max(0, size - header.length)));
    const t = (NOW - ageDays * DAY) / 1000;
    utimesSync(path, t, t);
    return path;
  }

  // A pid that cannot be running: past any default pid_max.
  const DEAD_PID = 2 ** 22 + 12345;

  it('removes logs past the age limit and keeps younger ones', async () => {
    const { sweepDebugLogs } = await freshDebug();
    const old = log(15);
    const young = log(13);
    expect(await sweepDebugLogs(logsDir(), NOW)).toEqual([old]);
    expect(readdirSync(logsDir())).toEqual([young.split('/').pop()]);
  });

  it('drops oldest first until the total is under the size limit', async () => {
    const { sweepDebugLogs, LOG_MAX_TOTAL_BYTES } = await freshDebug();
    const third = Math.floor(LOG_MAX_TOTAL_BYTES / 3);
    const newest = log(1, third);
    const oldest = log(3, third);
    const middle = log(2, third);
    const extra = log(0, third);
    expect(await sweepDebugLogs(logsDir(), NOW)).toEqual([oldest]);
    expect(readdirSync(logsDir()).sort()).toEqual(
      [newest, middle, extra].map(p => p.split('/').pop()).sort(),
    );
  });

  it("keeps a running session's log at any age, and reaps a dead owner's", async () => {
    const { sweepDebugLogs } = await freshDebug();
    const live = log(100, 64, process.pid);
    const dead = log(100, 64, DEAD_PID);
    expect(await sweepDebugLogs(logsDir(), NOW)).toEqual([dead]);
    expect(readFileSync(live, 'utf8')).toContain(`pid=${process.pid}`);
  });

  it('never touches latest.log, other names, or a REIKA_DEBUG_FILE target', async () => {
    const { debugLog, sweepDebugLogs } = await freshDebug();
    const target = join(logsDir(), 'experiment.log');
    mkdirSync(logsDir(), { recursive: true });
    writeFileSync(target, 'run\n');
    utimesSync(target, 0, 0);
    debugLog('current');
    const old = log(30);
    expect(await sweepDebugLogs(logsDir(), NOW + 365 * DAY)).toEqual([old]);
    expect(readdirSync(logsDir())).toContain('experiment.log');
    expect(readdirSync(logsDir())).toContain('latest.log');
  });

  it('is a no-op when the directory does not exist', async () => {
    const { sweepDebugLogs } = await freshDebug();
    expect(await sweepDebugLogs(join(fakeHome, 'nope'), NOW)).toEqual([]);
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

describe('formatEndpointLine (#868)', () => {
  it('names the profile, model and host, never the path or key', async () => {
    const { formatEndpointLine } = await freshDebug();
    expect(
      formatEndpointLine('default', 'qwen3.8-27b', 'https://user:secret@api.example.com/v1?k=x'),
    ).toBe('[reika:debug] endpoint profile=default model=qwen3.8-27b host=api.example.com');
  });

  it('keeps a hub-style id whole', async () => {
    const { formatEndpointLine } = await freshDebug();
    expect(formatEndpointLine('kimi', 'Qwen/Qwen3-30B', 'http://localhost:8080/v1')).toBe(
      '[reika:debug] endpoint profile=kimi model=Qwen/Qwen3-30B host=localhost',
    );
  });

  // llama.cpp names a model by the file it loaded, often an absolute path under the home dir.
  it('cuts a filesystem-path model id to its basename', async () => {
    const { formatEndpointLine } = await freshDebug();
    expect(formatEndpointLine('default', '/repo/models/q.gguf', 'http://127.0.0.1:8080/v1')).toBe(
      '[reika:debug] endpoint profile=default model=q.gguf host=127.0.0.1',
    );
    expect(formatEndpointLine('default', '~/models/q.gguf', 'not a url')).toBe(
      '[reika:debug] endpoint profile=default model=q.gguf host=?',
    );
  });
});
