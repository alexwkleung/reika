import { appendFileSync, mkdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from './version.js';

// REIKA_DEBUG diagnostics must NOT go to stderr while the Ink TUI owns the terminal: render() runs
// with default options, which patch console.* but not raw `process.stderr.write`, so a direct fd-2
// write lands inside Ink's repainted live region and surfaces as stray blank rows between tool
// results. Write to a file instead, where the data stays grep-able instead of scrollback noise.
export function debugEnabled(): boolean {
  return !!process.env.REIKA_DEBUG;
}

// The name a session's files share: its debug log here, its auto-save under history/ (#761), so a
// log found after the fact pairs with the transcript of the run that wrote it.
export function sessionStem(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

// One per process: reika is one process per session. The first auto-save of the process takes it
// too; a /new afterwards starts a transcript of its own, and the log records the switch.
let processStem: string | undefined;

export function processSessionStem(): string {
  return (processStem ??= sessionStem(new Date()));
}

// Under ~/.config/reika beside history/, never cwd-relative: a log inside the target repo is
// surprising and easy to grep in the wrong place.
export function debugLogDir(): string {
  return join(homedir(), '.config', 'reika', 'logs');
}

export const LATEST_LOG = 'latest.log';

// One file per session (#761). The old default was one file truncated at each launch (#114), so a
// spill or a slowdown nobody planned to debug was gone by the next start, and with small models a
// reproduction is a different run. REIKA_DEBUG_FILE is an explicit collection target instead —
// appended to across runs and never swept — which is what multi-run A/B analyses point at.
export function debugLogPath(): string {
  return process.env.REIKA_DEBUG_FILE || join(debugLogDir(), `${processSessionStem()}.log`);
}

let sessionStarted = false;

// The first line of a per-session log names its owner, so the startup sweep can tell a running
// session's file from an abandoned one at any age; `latest.log` keeps the one stable path to the
// current session that the single-file default used to give.
function openSessionLog(path: string): void {
  const dir = debugLogDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, `[reika:debug] session pid=${process.pid} version=${VERSION}\n`);
  const tmp = join(dir, `.latest-${process.pid}`);
  try {
    symlinkSync(`${processSessionStem()}.log`, tmp);
    renameSync(tmp, join(dir, LATEST_LOG));
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing was created.
    }
  }
}

export function debugLog(line: string): void {
  if (!debugEnabled()) return;
  const path = debugLogPath();
  const text = line.endsWith('\n') ? line : `${line}\n`;
  try {
    if (!sessionStarted && !process.env.REIKA_DEBUG_FILE) openSessionLog(path);
    sessionStarted = true;
    appendFileSync(path, text);
  } catch {
    // Best-effort: diagnostics must never break a turn.
  }
}

// --- Retention (#761) -----------------------------------------------------------------------
//
// Swept at startup, fire-and-forget, the way spill directories are (#224): oldest first, until
// what is left is both younger than the age limit and under the size limit. Both numbers are a
// first guess — the largest log measured was 238KB (a 1,380-round grind run), typical 20–100KB.
// Runs whether or not REIKA_DEBUG is set, so turning debug off does not strand the logs it wrote.
// Only names this module writes are touched: latest.log, and any REIKA_DEBUG_FILE target, never.
export const LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const LOG_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const SESSION_LOG_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}\.log$/;

const OWNER_RE = /^\[reika:debug\] session pid=(\d+)/;

// Signal 0 probes without delivering anything; EPERM means alive and somebody else's. Same check
// as the spill sweep's (`_spill.ts`), kept local rather than coupling the debug log to a tool.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ownerPid(path: string): Promise<number | null> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(128);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const m = OWNER_RE.exec(buf.subarray(0, bytesRead).toString('utf8'));
      return m ? Number(m[1]) : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

// Returns the paths removed, for tests and diagnostics. `dir` and `now` are seams for tests.
export async function sweepDebugLogs(
  dir: string = debugLogDir(),
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter(n => SESSION_LOG_RE.test(n));
  } catch {
    return removed;
  }
  const own =
    process.env.REIKA_DEBUG_FILE || processStem === undefined
      ? undefined
      : join(dir, `${processStem}.log`);
  const logs: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (s.isFile()) logs.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // Gone already.
    }
  }
  logs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = logs.reduce((sum, l) => sum + l.size, 0);
  for (const log of logs) {
    if (now - log.mtimeMs <= LOG_MAX_AGE_MS && total <= LOG_MAX_TOTAL_BYTES) break;
    if (log.path === own) continue;
    const pid = await ownerPid(log.path);
    if (pid !== null && pid > 0 && pidAlive(pid)) continue;
    try {
      await rm(log.path, { force: true });
      removed.push(log.path);
      total -= log.size;
    } catch {
      // Not ours to remove after all; the next startup tries again.
    }
  }
  return removed;
}

// One self-describing line per session, so a log says which build and which experiment flags
// produced it. Written after a lost A/B: an arm was run from a branch that did not contain the
// feature at all, the flag it set was read by nothing, and the two arms — which looked like a
// clean on/off pair by filename — were the same configuration. A log that states its own config
// makes that mislabel impossible to carry all the way to a conclusion.
//
// Enumerated from the environment rather than a hand-maintained list: a hardcoded list is exactly
// the incomplete enumeration that goes stale the next time a flag is added. Values are rendered
// numerically or as `set` — never verbatim — so keys, URLs and home paths cannot land in a log
// that gets pasted around. Decimals count as numeric: a fraction-valued tuning flag
// (REIKA_AGE_LOW_FRACTION) rendered as `set` would make the two arms of an A/B *on that value*
// indistinguishable in their own logs, which is the exact mislabel this line exists to prevent.
export function formatExperimentFlags(): string {
  const flags = Object.keys(process.env)
    .filter(k => k.startsWith('REIKA_'))
    .sort()
    .map(k => {
      const v = process.env[k] ?? '';
      return `${k.slice('REIKA_'.length).toLowerCase().replace(/_/g, '-')}=${/^\d+(\.\d+)?$/.test(v) ? v : v === '' ? "''" : 'set'}`;
    });
  return `[reika:debug] flags version=${VERSION} ${flags.join(' ') || '(none set)'}`;
}
