import { homedir } from 'node:os';

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

export function scrubPaths(s: string, cwd: string = process.cwd()): string {
  let out = s;
  if (cwd) out = out.split(cwd + '/').join('');
  if (HOME) out = out.split(HOME + '/').join('~/');
  return out;
}
