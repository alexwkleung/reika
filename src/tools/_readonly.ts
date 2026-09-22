// Shell commands that only READ — asked as TWO questions, because the two callers pull in opposite
// directions and collapsing them costs whichever one is on the losing side.
//
//   isProvablyReadOnly — plan mode's permission gate (#109). `true` ADMITS the command, so a wrong
//     `true` is a write that escaped plan mode's read-only guarantee. It must UNDER-allow: anything
//     it cannot prove safe is refused.
//
//   isInspectionEscape — the loop's withdrawal ladder. `true` REFUSES the call, as the bash-shaped
//     escape a withdrawn model routes to when read/grep/glob/list are pulled. A wrong `true` refuses
//     a real build mid-loop (the expensive mistake); a wrong `false` lets the model keep circling,
//     which is the failure the whole subsystem exists to break. It must OVER-detect inspection.
//
// One predicate cannot serve both: `sed -n '1,50p' f` is a line-range read the ladder MUST catch and
// plan mode must NOT admit. So the two share every rule below and differ only in which command names
// they recognize.
//
// An allowlist, not a denylist: an unrecognized command is never read-only, so `rm`/`sudo`/`npm` are
// excluded by construction rather than by pattern. Everything after it covers what an allowlist alone
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

// `awk` and `sed` are absent from the set above despite being read-only in their common uses. Both
// take a PROGRAM as an argument, and from inside it can write a file (`awk '{print > "f"}'`,
// `sed 's/a/b/w f'`) or shell out (`awk 'BEGIN{system("…")}'`). Validating a Turing-complete program
// by regex is a losing game, so plan mode refuses them; `read` with offset/limit, `head`/`tail` and
// `grep` cover the inspection they were reached for. `tree` is absent for a smaller version of the
// same reason — its `-o` writes the listing to a file, and `ls`/`find` already cover it.
//
// The LADDER still needs them. `sed -n '1,50p' f`, `awk '{print $1}' f` and `tree src` are exactly
// the shapes a withdrawn model routes to, and they were refusable before #109 split these questions
// apart. Recognizing them here is not a claim that they are safe to RUN — only that they are the
// model reading instead of working, which is the ladder's whole question.
const INSPECTION_ALSO = new Set(['sed', 'awk', 'tree']);

// The allowlist, rendered for the model. Derived rather than restated so the tool description cannot
// drift from the set actually enforced.
export const READ_ONLY_COMMAND_LIST = [...READ_ONLY_COMMANDS].join(', ');

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

// The recognized commands that can still be asked to WRITE, and the argument that asks. Enumerated
// per command rather than globally because the same spelling reads elsewhere — `grep -o` is
// only-matching, `sort -o` is an output file. `sort`'s short flag is matched anywhere in a combined
// cluster (`sort -no out` is `-n -o`), which denies more of `sort` than strictly needed: over-denying
// a listed command costs one refusal, under-denying it costs the guarantee.
//
// `sed`/`tree` appear here for the LADDER's sake only (plan mode never recognizes them at all): an
// in-place `sed -i` is real work, and refusing it mid-loop is the expensive mistake the ladder is
// built to avoid. `awk`'s write surface lives inside its program argument and cannot be spotted by
// flag, which is precisely why plan mode does not admit it.
const WRITE_FLAGS: Record<string, RegExp> = {
  // GNU/BSD `find`'s write-and-exec surface. Prefix-matched so `-fprintf`/`-fprint0` are covered;
  // `-printf` (stdout) deliberately is not.
  find: /^-(?:exec|ok|delete|fprint|fls)/,
  sort: /^-[^-]*o|^--output/,
  sed: /^-[^-]*i|^--in-place/,
  tree: /^-[^-]*o$|^--output/,
};

// `uniq [input [output]]` writes its SECOND operand — a write with no flag to spot. Reading stdin in
// a pipeline (no operands) and reading one named file both stay allowed.
const MAX_OPERANDS: Record<string, number> = { uniq: 1 };

// Flags that consume the NEXT word as their value, for the commands counting operands above. Without
// this, `uniq -f 2 file` reads as two operands (`2` and `file`) and is refused as a write — which
// over-denies a plain read on the plan side and, worse, hides it from the ladder, since a shape the
// ladder scores as "not inspection" is one it lets a withdrawn model keep circling on.
const VALUE_FLAGS: Record<string, Set<string>> = { uniq: new Set(['-f', '-s', '-w']) };

// Split into words the way the shell does, keeping a quoted run with spaces in it as ONE word, then
// drop the quote characters. Quoting changes nothing about how a command reads its own arguments, so
// `find . '-delete'` must be seen as the flag it is.
export const WORD_RE = /(?:[^\s'"]|'[^']*'|"[^"]*")+/g;

export function words(segment: string): string[] {
  return (segment.match(WORD_RE) ?? []).map(w => w.replace(/['"]/g, ''));
}

function segmentIsReadOnly(segment: string, recognized: Set<string>): boolean {
  const [name, ...args] = words(segment);
  if (!name || !recognized.has(name)) return false;
  const writeFlag = WRITE_FLAGS[name];
  if (writeFlag && args.some(a => writeFlag.test(a))) return false;
  const maxOperands = MAX_OPERANDS[name];
  if (maxOperands !== undefined) {
    const takesValue = VALUE_FLAGS[name] ?? new Set<string>();
    let operands = 0;
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        if (takesValue.has(args[i])) i++; // the next word is this flag's value, not an operand
        continue;
      }
      operands++;
    }
    if (operands > maxOperands) return false;
  }
  return true;
}

// Blank out quoted regions while preserving length, so a scan can tell syntax from data and a
// segment offset still indexes the raw command. An unbalanced quote masks nothing, leaving junk
// that fails the command-name test above → false.
export function maskQuoted(command: string): string {
  return command.replace(/"[^"]*"|'[^']*'/g, m => ' '.repeat(m.length));
}

// Cut the command at every separator that sits OUTSIDE quotes, returning each segment's RAW text —
// a search pattern like "a;b" carries separators that are data, not syntax, so the split walks the
// mask while the slices come from the original.
export function splitSegments(command: string, masked: string): string[] {
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

// The shared core. Every unknown resolves to false, so being wrong costs a refused inspection rather
// than an unnoticed write on the plan side, and a missed escape rather than a refused build on the
// ladder side. Pure.
function classify(command: string, recognized: Set<string>): boolean {
  const c = command.trim();
  if (!c || SUBSTITUTION_RE.test(c)) return false;
  const masked = maskQuoted(c);
  if (REDIRECT_RE.test(masked)) return false;
  const segments = splitSegments(c, masked);
  // Leading `cd <path>` hops (which the observed loops prefix) carry no read of their own; an empty
  // remainder is not read-only.
  const meaningful = segments.map(s => s.trim()).filter(s => s && !/^cd\s/.test(s));
  if (meaningful.length === 0) return false;
  return meaningful.every(s => segmentIsReadOnly(s, recognized));
}

// PLAN MODE's gate: true only when the command is PROVABLY pure read-only inspection.
export function isProvablyReadOnly(command: string): boolean {
  return classify(command, READ_ONLY_COMMANDS);
}

// Also read by the sandbox (#163): a pipeline of `gh`/`git` plus these keeps its network allow, since
// these are what a model pages remote output through (`gh pr diff | sed -n '1,300p'`).
export const INSPECTION_COMMANDS = new Set([...READ_ONLY_COMMANDS, ...INSPECTION_ALSO]);

// The LADDER's question: is this the model inspecting rather than working? A superset of the above —
// same write/substitution/separator rules, wider set of command names.
export function isInspectionEscape(command: string): boolean {
  return classify(command, INSPECTION_COMMANDS);
}
