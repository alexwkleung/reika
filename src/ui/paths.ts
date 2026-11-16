import { homedir } from 'node:os';
import { bumpScrubGeneration } from './identity.js';

// Display-only path scrubbing. These helpers rewrite absolute paths for the
// scrollback/summary UI; they NEVER touch the args sent to the model (those are
// serialized separately in provider/toolcall.ts). Paths under the project root
// collapse to a cwd-relative form; anything else under $HOME collapses to ~.
//
// We operate on whole formatted strings (not just known path fields) so paths
// embedded mid-string — bash commands, grep patterns — get scrubbed too. The
// cwd prefix is replaced before the home prefix so the more specific, longer
// match wins.
const HOME = homedir();

// The session's cwd, not process.cwd(): `/cd` re-bootstraps without a chdir, so the process cwd
// goes stale and project-relative shortening with it (#1015).
let sessionRoot: string | null = null;

export function setDisplayRoot(cwd: string): void {
  if (cwd === sessionRoot) return;
  sessionRoot = cwd;
  bumpScrubGeneration();
}

export function displayRoot(): string {
  return sessionRoot ?? process.cwd();
}

export function scrubPaths(s: string, cwd: string = displayRoot()): string {
  let out = s;
  if (cwd) out = out.split(cwd + '/').join('');
  if (HOME) out = out.split(HOME + '/').join('~/');
  return out;
}
