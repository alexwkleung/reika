import { homedir } from 'node:os';
import { redactSecrets } from './redact.js';
import { scrubPaths } from './paths.js';
import { scrubIdentity } from './identity.js';

// The single display-scrub entry point. Every render site and the transcript serializer go
// through this, so a new one cannot silently pick up two of the three layers — which is exactly
// how shell-mode messages ended up rendering with none of them while the bash tool had all three.
//
// ORDER IS LOAD-BEARING, not stylistic:
//
//   1. redactSecrets first. Its rules are key-anchored (`identity=<v>`, `--apple-id <v>`) and
//      expect raw values; rewriting a path or a name underneath one can break the anchor and
//      turn a redacted secret back into a visible one.
//   2. scrubPaths second. It matches the literal $HOME prefix — and $HOME CONTAINS the username.
//      Run identity substitution before this and `/home/mona/x` becomes `/home/<user>/x`, the
//      home literal stops matching, and paths quietly stop collapsing to `~` at all.
//   3. scrubIdentity last, on what's left: git author names/emails, remote account slugs.
//
// Display only. None of this touches what is sent to the model — tool args are serialized
// separately in provider/toolcall.ts — so it is not a privacy boundary against the provider.
export function scrubDisplay(s: string, cwd?: string): string {
  return scrubIdentity(scrubPaths(redactSecrets(s), cwd));
}

// A bare working directory shown as a label (the splash's `cwd:` row, the header line) rather
// than found inside a formatted string. Both used to carry their own copy of the home-collapsing
// logic, which meant the two surfaces that stay on screen for an entire screen recording were the
// two that never picked up any later scrub layer.
//
// scrubPaths matches `$HOME/`, with the separator — so it can't collapse a cwd that IS $HOME.
// That case is handled here rather than by loosening scrubPaths, where an unanchored `$HOME`
// match would rewrite a sibling `/home/monastery` into `~stery`.
export function displayCwd(cwd: string): string {
  const home = homedir();
  if (home && cwd === home) return scrubIdentity('~');
  // Scrubbed against itself: the cwd-prefix rule needs a trailing separator to fire, so it
  // can't empty the field, and what's left is the `~/…` form plus identity substitution.
  return scrubDisplay(cwd, cwd);
}
