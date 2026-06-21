import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// REIKA_DEBUG diagnostics must NOT go to stderr while the Ink TUI owns the terminal: render() runs
// with default options, which patch console.* but not raw `process.stderr.write`, so a direct fd-2
// write lands inside Ink's repainted live region and surfaces as stray blank rows between tool
// results. Append to a file instead. As a bonus this makes the data grep-able across runs — the
// form the multi-run read-trace distribution analysis actually wants, instead of scrollback noise.
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

export function debugLog(line: string): void {
  if (!debugEnabled()) return;
  const path = debugLogPath();
  try {
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // Best-effort: diagnostics must never break a turn.
  }
}
