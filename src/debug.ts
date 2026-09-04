import { appendFileSync, writeFileSync } from 'node:fs';
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

// One stable path regardless of which project reika is pointed at. A cwd-relative default lands the
// log inside the target repo (surprising, and easy to grep in the wrong place); the home dir is
// always the same file, so runs across projects/models accumulate where you can find them.
// REIKA_DEBUG_FILE overrides it (e.g. an absolute path for a specific experiment).
export function debugLogPath(): string {
  return process.env.REIKA_DEBUG_FILE || join(homedir(), 'reika-debug.log');
}

// The default log holds one session: the first write of a process truncates it (#114 — sessions run
// thousands of lines, and append-forever bloats the file without bound). When you *want* runs to
// accumulate (the multi-run distribution analyses), point REIKA_DEBUG_FILE at an experiment file —
// an explicit collection target is never truncated.
let sessionStarted = false;

export function debugLog(line: string): void {
  if (!debugEnabled()) return;
  const path = debugLogPath();
  const text = line.endsWith('\n') ? line : `${line}\n`;
  try {
    if (sessionStarted || process.env.REIKA_DEBUG_FILE) {
      appendFileSync(path, text);
    } else {
      writeFileSync(path, text);
    }
    sessionStarted = true;
  } catch {
    // Best-effort: diagnostics must never break a turn.
  }
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
// that gets pasted around.
export function formatExperimentFlags(): string {
  const flags = Object.keys(process.env)
    .filter(k => k.startsWith('REIKA_'))
    .sort()
    .map(k => {
      const v = process.env[k] ?? '';
      return `${k.slice('REIKA_'.length).toLowerCase().replace(/_/g, '-')}=${/^\d+$/.test(v) ? v : v === '' ? "''" : 'set'}`;
    });
  return `[reika:debug] flags version=${VERSION} ${flags.join(' ') || '(none set)'}`;
}
