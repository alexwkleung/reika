import { hasHeredocOperator } from './_heredoc.js';

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
// `sed 's/a/b/w f'`) or shell out (`awk 'BEGIN{system("…")}'`). Spotting every write in a
// Turing-complete program is a losing game, so plan mode refuses awk outright and admits sed only
// through `sedSegmentIsReadOnly`'s positive grammar, below. `tree` is absent for a smaller version of
// the same reason — its `-o` writes the listing to a file, and `ls`/`find` already cover it.
//
// The LADDER still needs them. `sed -n '1,50p' f`, `awk '{print $1}' f` and `tree src` are exactly
// the shapes a withdrawn model routes to, and they were refusable before #109 split these questions
// apart. Recognizing them here is not a claim that they are safe to RUN — only that they are the
// model reading instead of working, which is the ladder's whole question.
const INSPECTION_ALSO = new Set(['sed', 'awk', 'tree']);

// The allowlist, rendered for the model. Derived rather than restated so the tool description cannot
// drift from the set actually enforced.
export const READ_ONLY_COMMAND_LIST = [...READ_ONLY_COMMANDS].join(', ');

// `gh` reads, for plan mode only. `/issue` and `/review` open on a `gh` fetch, and a plan grounded
// in the issue it answers needs the same. Stricter than `_danger.ts`'s GH_READ_VERBS on purpose:
// that table asks "does this act on GitHub as the user", this one "does it touch anything at all",
// so `pr checkout`, `repo clone`, `run download` (local writes) and `run watch` (never exits) are
// out. The ladder does not recognize `gh`: a withdrawn model re-fetching an issue is circling, but
// refusing a fetch it has not made yet is the expensive direction there.
const GH_PLAN_READS: Record<string, readonly string[]> = {
  pr: ['view', 'list', 'diff', 'checks', 'status'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list'],
  run: ['view', 'list'],
  workflow: ['view', 'list'],
  release: ['view', 'list'],
  label: ['list'],
  search: ['issues', 'prs', 'repos', 'code', 'commits'],
};

// Rendered for the tool description, like READ_ONLY_COMMAND_LIST.
export const GH_PLAN_READ_LIST = Object.entries(GH_PLAN_READS)
  .map(([noun, verbs]) => `gh ${noun} ${verbs.join('|')}`)
  .concat('gh api (GET)')
  .join(', ');

const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
// `--web` opens the user's browser and `--watch` never exits; neither is a read the model can use.
// A short cluster carrying `w` is refused with them (pflag accepts `-wc`).
const GH_REFUSED_FLAG_RE = /^(?:--web|--watch)(?:=|$)|^-[a-zA-Z]*w[a-zA-Z]*$/;
// Every way `gh api` is told to send a body or a non-GET method. A field alone flips it to POST.
const GH_API_WRITE_FLAG_RE = /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)|^-[fF]./;

function ghSegmentIsReadOnly(args: string[]): boolean {
  const sub: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (GH_REFUSED_FLAG_RE.test(a)) return false;
    if (a.startsWith('-')) {
      if (GH_VALUE_FLAGS.has(a) && sub.length < 2) i++;
      continue;
    }
    if (sub.length < 2) sub.push(a);
  }
  const [noun, verb] = sub;
  if (noun === 'api') return ghApiIsGet(args.slice(args.indexOf('api') + 1));
  return !!verb && (GH_PLAN_READS[noun]?.includes(verb) ?? false);
}

// GET only, derived rather than read off `-X`: a field makes it a POST with no `-X` in sight.
// `graphql` is refused whole — a mutation is a query string, and no flag says which one it is. A
// method-override header is refused for the same reason `-X` is.
function ghApiIsGet(args: string[]): boolean {
  let endpoint: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (GH_API_WRITE_FLAG_RE.test(a)) return false;
    if (a === '-X' || a === '--method') {
      if (args[++i]?.toUpperCase() !== 'GET') return false;
    } else if (/^(?:-X|--method=)/.test(a)) {
      if (a.replace(/^(?:-X|--method=)/, '').toUpperCase() !== 'GET') return false;
    } else if (a === '-H' || a === '--header') {
      if (/override/i.test(args[++i] ?? '')) return false;
    } else if (/^(?:-H|--header=)/.test(a)) {
      if (/override/i.test(a)) return false;
    } else if (!a.startsWith('-') && endpoint === undefined) {
      endpoint = a;
    }
  }
  return !!endpoint && endpoint !== 'graphql';
}

// Substitution runs a nested command the allowlist would never see. `$(…)` and a backtick execute
// inside DOUBLE quotes as well as bare, so those stay tested; inside single quotes every character is
// literal, and blanking that region first is what stops `grep -c '```'` and `grep -n '$(dirname' src/`
// reading as substitutions the model never wrote. That retires the blanket trade this rule used to
// make — the context is answerable now, in `maskSingleQuotedData` below.
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;

// A backslash-escaped `` ` `` or `$` is a literal character in every quoting context (single quotes
// make it literal anyway), so it can never open a substitution. Escaped backslashes go first so
// `\\`…`` — a literal backslash, then a real substitution — still reads as one. Observed: a
// markdown-table grep (`"^| \`REIKA"`) refused, a plan round lost.
function dropEscapedSubstitutionChars(raw: string): string {
  return raw.replace(/\\\\/g, '').replace(/\\[`$]/g, '');
}

// What a substitution check should actually read: the command with the regions where a `$(` or a
// backtick is DATA blanked out, length-preserving so any offset taken against it still lines up.
// Two contexts blank, one refuses to answer:
//
//   - inside SINGLE quotes (a `'` opens the run, the next `'` closes it): `grep -c '```'` is a
//     pattern, not a command. Double-quoted runs are skipped over rather than blanked, so an
//     apostrophe in prose (`echo "it's $(curl evil)"`) cannot be mistaken for an opening quote and
//     swallow the substitution beside it.
//   - NOTHING when a heredoc OPERATOR is in the text. A heredoc body is not quote-parsed at all —
//     its `$(…)` expands unless the delimiter was quoted — so an apostrophe inside one (`it's`)
//     would pair with the next and blank a command that runs. The delimiter's own quoting is what
//     decides, and that is `_heredoc.ts`'s question, not this one: an unclear heredoc means no
//     blanking, which the caller reads as "test the raw string" and denies as it does today.
//
// `hasHeredocOperator`, not `includes('<<')`: the guard fires on the operator, and on any delimiter
// form the detector cannot read — but a `<<` that is part of a longer run cannot open a heredoc at
// all, so it no longer refuses the mask. `git grep -c '^<<<<<<<' FETCH_HEAD` beside a quoted
// backtick lost its network to the blanket test (#685).
//
// Returns undefined when quoting cannot be closed (`echo don't` leaves a `'` open) — the same
// fallback, because a mask that guesses where a quote ends is how a substitution gets hidden.
export function maskSingleQuotedData(command: string): string | undefined {
  if (hasHeredocOperator(command)) return undefined;
  let out = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) return undefined;
      out += command.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return undefined;
      out += ' '.repeat(end + 1 - i);
      i = end + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// The one call a command line makes. `dropEscapedSubstitutionChars` first (a `\$(` is a literal),
// then the single-quote mask when it can be built; an unmaskable command keeps the raw test.
export function hasExecutableSubstitution(command: string): boolean {
  const escaped = dropEscapedSubstitutionChars(command);
  return SUBSTITUTION_RE.test(maskSingleQuotedData(escaped) ?? escaped);
}

// The same question about text whose quoting context is NOT a command line, so there is no mask to
// trust: the body of a heredoc the shell expands. Nothing there is quote-parsed — `it's` in a body is
// literal data, and pairing that apostrophe with the next one would blank a `$(…)` that really runs.
// The escape rule does apply: `\$(` in a body produces a literal `$`.
export function hasRawSubstitution(text: string): boolean {
  return SUBSTITUTION_RE.test(dropEscapedSubstitutionChars(text));
}

// Redirection is the one metacharacter that is routinely DATA (`grep ">" f`), so it alone is tested
// against the quote-masked view. `>>` and `2>&1` are subsumed.
const REDIRECT_RE = />/;

// The redirections that cannot write a file: discarding a stream (`2>/dev/null`, `&>/dev/null`) and
// duplicating a descriptor (`2>&1`, `>&2`). Blanked before the redirect test and the split, since
// `2>/dev/null` is how a model quiets a glob that may not match and refusing it cost a plan round,
// and `2>&1`'s `&` otherwise splits off a segment named `1`. Anchored so `>/dev/null.txt` is not one.
const HARMLESS_REDIRECT_RE = /(?:\d*|&)>>?\s*\/dev\/null(?=\s|$|[;&|])|\d*>&\d+(?=\s|$|[;&|])/g;

// Blank the same ranges in the raw command and its mask, so offsets still line up for the split.
function blankHarmlessRedirects(raw: string, masked: string): { raw: string; masked: string } {
  let r = raw;
  let m = masked;
  for (const hit of masked.matchAll(HARMLESS_REDIRECT_RE)) {
    const blank = ' '.repeat(hit[0].length);
    const at = hit.index ?? 0;
    r = r.slice(0, at) + blank + r.slice(at + blank.length);
    m = m.slice(0, at) + blank + m.slice(at + blank.length);
  }
  return { raw: r, masked: m };
}

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

// The carrier that bounds ONE command and changes nothing else about it, skipped so both readers see
// the command itself. `timeout 120 gh issue view 621 --json title,body` is the shape a model writes
// when GitHub is slow, and without this both readers answered about the wrapper: `timeout` is not a
// recognized command name, so the sandbox denied the read its network and plan mode refused it
// (#621) — while `_danger.ts`, which matches a command's own patterns through an unlisted carrier
// (`timeout 5 rm` still gates), saw the gh read and did not flag it. (`xargs` is the other carrier,
// read in `_sandbox.ts`'s verb reader, where the command it runs is known to be the argument.)
// Flags and the DURATION operand are skipped; `-s`/`-k` take the next word as their value,
// `--signal=KILL` does not.
const CARRIER_VALUE_FLAGS = new Set(['-s', '--signal', '-k', '--kill-after']);

export function dropCarriers(wordList: string[]): string[] {
  let i = 0;
  while (wordList[i] === 'timeout') {
    i++;
    while (wordList[i]?.startsWith('-')) {
      if (CARRIER_VALUE_FLAGS.has(wordList[i])) i++;
      i++;
    }
    i++; // the DURATION operand
  }
  return wordList.slice(i);
}

// Plan mode's sed: a line-range or pattern-range print (`sed -n '120,180p' f`,
// `sed -n '/## A/,/## B/p' f`) — the read models reach for most, refused before at a round's cost.
// An ALLOWLIST of script shapes, never a scan for writes: every command is `p`, `=` or `q` behind
// optional addresses, so `w`, `s///w`, GNU `e` and `r` cannot appear at all, and `-i`/`-f`/every
// other flag is refused. Regex addresses take only the `/` delimiter, since a custom one (`\%re%`)
// is where a hand-rolled parser starts to guess.
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/I?)`;
const SED_RANGE = String.raw`(?:${SED_ADDR}(?:\s*,\s*(?:${SED_ADDR}|[+~]\d+))?)`;
const SED_COMMAND = String.raw`\s*${SED_RANGE}?\s*!?\s*[p=q]\s*`;
const SED_SCRIPT_RE = new RegExp(String.raw`^${SED_COMMAND}(?:;${SED_COMMAND})*;?$`);
const SED_PRINT_FLAGS = /^-[nEr]+$|^--(?:quiet|silent|regexp-extended)$/;
const SED_SCRIPT_FLAG = /^-[nEr]*e$|^--expression$/;

function sedSegmentIsReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SED_SCRIPT_FLAG.test(a)) {
      if (i + 1 >= args.length) return false;
      scripts.push(args[++i]);
    } else if (a.startsWith('-')) {
      if (!SED_PRINT_FLAGS.test(a)) return false;
    } else {
      operands.push(a);
    }
  }
  // Without -e, the first operand is the script and the rest are the files it reads.
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) return false;
    scripts.push(script);
  }
  return scripts.every(sc => SED_SCRIPT_RE.test(sc));
}

function segmentIsReadOnly(segment: string, recognized: Set<string>, planReads: boolean): boolean {
  const [name, ...args] = dropCarriers(words(segment));
  if (name === 'gh' && planReads) return ghSegmentIsReadOnly(args);
  if (name === 'sed' && planReads) return sedSegmentIsReadOnly(args);
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
function classify(command: string, recognized: Set<string>, planReads = false): boolean {
  const trimmed = command.trim();
  if (!trimmed || hasExecutableSubstitution(trimmed)) return false;
  const { raw: c, masked } = blankHarmlessRedirects(trimmed, maskQuoted(trimmed));
  if (REDIRECT_RE.test(masked)) return false;
  const segments = splitSegments(c, masked);
  // Leading `cd <path>` hops (which the observed loops prefix) carry no read of their own; an empty
  // remainder is not read-only.
  const meaningful = segments.map(s => s.trim()).filter(s => s && !/^cd\s/.test(s));
  if (meaningful.length === 0) return false;
  return meaningful.every(s => segmentIsReadOnly(s, recognized, planReads));
}

// PLAN MODE's gate: true only when the command is PROVABLY pure read-only inspection.
export function isProvablyReadOnly(command: string): boolean {
  return classify(command, READ_ONLY_COMMANDS, true);
}

// Also read by the sandbox (#163): a pipeline of `gh`/`git` plus these keeps its network allow, since
// these are what a model pages remote output through (`gh pr diff | sed -n '1,300p'`).
export const INSPECTION_COMMANDS = new Set([...READ_ONLY_COMMANDS, ...INSPECTION_ALSO]);

// The LADDER's question: is this the model inspecting rather than working? A superset of the above —
// same write/substitution/separator rules, wider set of command names.
export function isInspectionEscape(command: string): boolean {
  return classify(command, INSPECTION_COMMANDS);
}
