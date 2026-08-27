// Shell commands that only READ. Two callers with one question between them: the loop's withdrawal
// ladder refuses a read-only `bash` (the escape a withdrawn model routes to when read/grep/glob/list
// are pulled), and plan mode ADMITS one (#109). The polarities are opposite, so this must answer
// "provably read-only", not "probably" — a wrong `true` is a nudge misfire on one side and an escape
// from plan mode's read-only guarantee on the other.
//
// An allowlist, not a denylist: an unrecognized command is never read-only, so `rm`/`sudo`/`npm` are
// excluded by construction rather than by pattern. Everything below covers what an allowlist alone
// cannot see — a second command smuggled past the parse, or an allowlisted one asked to write.
const READ_ONLY_COMMANDS = new Set([
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'find',
  'sort',
  'uniq',
  'cut',
  'nl',
  'column',
  'stat',
  'basename',
  'dirname',
  'realpath',
  'which',
  'type',
  'pwd',
  'echo',
]);

// `awk` and `sed` are deliberately absent despite being read-only in their common uses. Both take a
// PROGRAM as an argument, and from inside it can write a file (`awk '{print > "f"}'`, `sed 's/a/b/w f'`)
// or shell out (`awk 'BEGIN{system("…")}'`). Validating a Turing-complete program by regex is a losing
// game, so they lose the allowlist instead; `read` with offset/limit, `head`/`tail` and `grep` cover
// the inspection they were reached for. `tree` is absent for a smaller version of the same reason —
// its `-o` writes the listing to a file, and `ls`/`find` already cover it.

// Substitution runs a nested command the allowlist would never see. Tested against the RAW string,
// not the quote-masked view, because `$(…)` inside double quotes still executes. Costs a false
// negative on a single-quoted literal `$(` in a search pattern — cheap, and it errs safe.
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;

// Redirection is the one metacharacter that is routinely DATA (`grep ">" f`), so it alone is tested
// against the quote-masked view. `>>` and `2>&1` are subsumed.
const REDIRECT_RE = />/;

// Every separator that starts a new command, including the ones the shell takes without surrounding
// whitespace: `;`, `&`, `|`, and a bare newline. A missing one lets a second command ride along.
const SEPARATOR_RE = /[;&|\r\n]+/g;

// The allowlisted commands that can still be asked to WRITE, and the argument that asks. Enumerated
// per command rather than globally because the same spelling reads elsewhere — `grep -o` is
// only-matching, `sort -o` is an output file. `sort`'s short flag is matched anywhere in a combined
// cluster (`sort -no out` is `-n -o`), which denies more of `sort` than strictly needed: over-denying
// a listed command costs one refusal, under-denying it costs the guarantee.
const WRITE_FLAGS: Record<string, RegExp> = {
  // GNU/BSD `find`'s write-and-exec surface. Prefix-matched so `-fprintf`/`-fprint0` are covered;
  // `-printf` (stdout) deliberately is not.
  find: /^-(?:exec|ok|delete|fprint|fls)/,
  sort: /^-[^-]*o|^--output/,
};

// `uniq [input [output]]` writes its SECOND operand — a write with no flag to spot. Reading stdin in
// a pipeline (no operands) and reading one named file both stay allowed.
const MAX_OPERANDS: Record<string, number> = { uniq: 1 };

// Split into words the way the shell does, keeping a quoted run with spaces in it as ONE word, then
// drop the quote characters. Quoting changes nothing about how a command reads its own arguments, so
// `find . '-delete'` must be seen as the flag it is.
const WORD_RE = /(?:[^\s'"]|'[^']*'|"[^"]*")+/g;

function words(segment: string): string[] {
  return (segment.match(WORD_RE) ?? []).map(w => w.replace(/['"]/g, ''));
}

function segmentIsReadOnly(segment: string): boolean {
  const [name, ...args] = words(segment);
  if (!name || !READ_ONLY_COMMANDS.has(name)) return false;
  const writeFlag = WRITE_FLAGS[name];
  if (writeFlag && args.some(a => writeFlag.test(a))) return false;
  const maxOperands = MAX_OPERANDS[name];
  if (maxOperands !== undefined && args.filter(a => !a.startsWith('-')).length > maxOperands) {
    return false;
  }
  return true;
}

// Cut the command into segments at every separator that sits OUTSIDE quotes, and return each segment's
// raw text. A search pattern like "a;b" carries separators that are data, not syntax, so the split
// runs over a length-preserving mask of the quoted regions — same offsets, so the raw slice lines up.
// An unbalanced quote masks nothing, leaving junk that fails the command-name test above → false.
function splitSegments(command: string): string[] {
  const masked = command.replace(/"[^"]*"|'[^']*'/g, m => ' '.repeat(m.length));
  if (REDIRECT_RE.test(masked)) return [];
  const segments: string[] = [];
  let start = 0;
  SEPARATOR_RE.lastIndex = 0;
  for (let m = SEPARATOR_RE.exec(masked); m; m = SEPARATOR_RE.exec(masked)) {
    segments.push(command.slice(start, m.index));
    start = m.index + m[0].length;
  }
  segments.push(command.slice(start));
  return segments;
}

// True only when a bash command is PROVABLY pure read-only inspection. Every unknown resolves to
// false, so being wrong costs a refused inspection, never an unnoticed write. Pure.
export function isReadOnlyShell(command: string): boolean {
  const c = command.trim();
  if (!c || SUBSTITUTION_RE.test(c)) return false;
  const segments = splitSegments(c);
  // Leading `cd <path>` hops (which the observed loops prefix) carry no read of their own; an empty
  // remainder is not read-only.
  const meaningful = segments.map(s => s.trim()).filter(s => s && !/^cd\s/.test(s));
  if (meaningful.length === 0) return false;
  return meaningful.every(segmentIsReadOnly);
}
