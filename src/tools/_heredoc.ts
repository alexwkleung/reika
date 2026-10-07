// Heredocs, as one notion shared by the three questions that ask about them. Two of those pull in
// opposite directions, and the disagreement was a bug (#685), so the operator is defined once here.
//
//   stripHeredocs / expandingHeredocBodies — where a heredoc body STARTS and ENDS, so its lines can
//     be cut before the shell parses them as commands: the verb read in `networkDecision` (#163,
//     `gh issue comment --body-file - <<EOF …`) and the write-target fallback in `_writetargets.ts`
//     (#278).
//
//   hasHeredocOperator — may this text hold a heredoc body at all? `maskSingleQuotedData`
//     (`_readonly.ts`) asks it before trusting a quote mask: a body is not quote-parsed, so an
//     apostrophe in one pairs with the next and blanks a `$(…)` that really runs.
//
// `hasHeredocOperator` is the conservative SUPERSET of the detector: wherever `HEREDOC_RE` matches,
// this is true. It used to be `command.includes('<<')`, which is true far more often — a git
// conflict-marker pattern (`git grep -c '^<<<<<<<'`) refused the mask, the raw fallback then read a
// backtick inside single quotes as a substitution, and the whole compound lost its network.
//
// Both agree on WHERE the operator is, and that is the part that has to be exact: the shell's
// heredoc operator is a run of exactly two `<`. A third `<` makes a here-string (`cat <<< x`), whose
// operand IS quote-parsed like any other word — so the mask is trustworthy there and a blanket
// refusal was the wrong answer — and a longer run is a conflict-marker pattern, or a syntax error.
// The lookbehind keeps `HEREDOC_RE` off a `<<` that is the tail of a longer run, so the detector can
// never name an operator this guard denies; `bash.ts`'s `HEREDOC_IN_SUBSTITUTION_RE` spells the same
// flanking guards (`(?:^|[^<])<<(?!<)`) for its own question.
const HEREDOC_OPERATOR_RE = /(?<!<)<{2}(?!<)/;

export function hasHeredocOperator(command: string): boolean {
  return HEREDOC_OPERATOR_RE.test(command);
}

// The delimiter forms the shell accepts after the operator, and the quoting is what decides whether
// the body expands. `(['"]?)(\w+)\1` read only the bare and quote-flanked-word shapes, so `<<\EOF`
// (POSIX's own spelling) and `<<'A B'` were read as prose and their bodies stayed in the text,
// which is how a `<<` the detector could not name came to be a reason the mask had to be refused.
// Measured against `sh`, `bash`, `dash` and `zsh`: each opens a heredoc for both forms, and the
// terminator is the delimiter with its quotes removed (`EOF`, and `A B`). Empty quoted delimiters
// (`<<''`) are deliberately unmatched — a missing form fails closed, and a delimiter that is an
// empty line is nobody's shape.
const HEREDOC_RE = /(?<!<)<<-?\s*(?:\\([\w.-]+)|'([^']+)'|"([^"]+)"|(\w+))/;

// Which delimiter a match named, and whether it was quoted — the body is literal only when the
// DELIMITER was, which is the whole distinction `expandingHeredocBodies` exists to draw.
//
// The backslash form is the one place this reads the shell conservatively rather than exactly: all
// four shells above treat `\E` as quoting a character of the delimiter word, so a `<<\EOF` body is
// LITERAL (measured: `cat <<\EOF` with `$(echo X)` in the body prints it verbatim, where `<<EOF`
// expands it). Reporting it as expanding anyway costs a `<<\EOF` body a network allow it did not
// need — the verbs that reach here on a literal body are local reads (`git apply -`,
// `hash-object --stdin`) — while reading it as literal would hand a `$(…)` in such a body the
// network if any shell disagreed about the quoting. A wrong `true` there is the guarantee; the
// issue's own regression case is this exact shape (#685).
function heredocDelimiter(m: RegExpExecArray): { delimiter: string; quoted: boolean } {
  const quoted = m[2] !== undefined || m[3] !== undefined;
  return { delimiter: m[1] ?? m[2] ?? m[3] ?? m[4], quoted };
}

// The delimiter is matched as a literal LINE, so its own metacharacters must not become pattern
// syntax: `<<'E.O.F'` ends at `E.O.F`, not at every line of three characters.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Also read by the sandbox's network classifier (#163): a heredoc body's lines would otherwise
// split into segments whose "verb" is prose, denying `gh issue comment --body-file - <<EOF …`.
export function stripHeredocs(command: string): string {
  let s = command;
  for (let m = HEREDOC_RE.exec(s); m; m = HEREDOC_RE.exec(s)) {
    const bodyStart = s.indexOf('\n', m.index);
    if (bodyStart === -1) break;
    const endRe = new RegExp(`^\\s*${escapeRe(heredocDelimiter(m).delimiter)}\\s*$`, 'm');
    const rest = s.slice(bodyStart + 1);
    const end = endRe.exec(rest);
    const bodyEnd = end ? bodyStart + 1 + end.index + end[0].length : s.length;
    // Keep the `<<` operator text off the next pass by cutting it out with the body.
    s = s.slice(0, m.index) + s.slice(bodyEnd);
  }
  return s;
}

// The heredoc bodies the shell EXPANDS, which `stripHeredocs` deliberately cuts away with the rest:
// `$…` and a backtick in a body are only data when the DELIMITER was quoted, so `<<EOF` runs what
// `<<'EOF'` pastes. Dropping them answers the verb question correctly ("what commands does this
// line run" — a body's prose runs nothing) and the substitution question wrongly, because a `$(…)`
// in an expanding body DOES run, with whatever network the line's `git`/`gh` verb was granted.
// Walked exactly like `stripHeredocs` — each body cut before the next match — so prose inside one
// can never be read as a heredoc operator of its own. A backslash-escaped delimiter (`<<\EOF`) is
// read as unquoted, deliberately, so its body is re-read even though the shells measured paste it:
// see `heredocDelimiter`.
export function expandingHeredocBodies(command: string): string[] {
  const bodies: string[] = [];
  let s = command;
  for (let m = HEREDOC_RE.exec(s); m; m = HEREDOC_RE.exec(s)) {
    const { delimiter, quoted } = heredocDelimiter(m);
    const bodyStart = s.indexOf('\n', m.index);
    if (bodyStart === -1) break;
    const endRe = new RegExp(`^\\s*${escapeRe(delimiter)}\\s*$`, 'm');
    const rest = s.slice(bodyStart + 1);
    const end = endRe.exec(rest);
    const bodyEnd = end ? bodyStart + 1 + end.index + end[0].length : s.length;
    // An unterminated heredoc swallows the rest, which is what the shell does with it too. The
    // newline before the delimiter line terminates the body rather than belonging to it.
    if (!quoted) bodies.push(rest.slice(0, end ? end.index : rest.length).replace(/\n$/, ''));
    s = s.slice(0, m.index) + s.slice(bodyEnd);
  }
  return bodies;
}
