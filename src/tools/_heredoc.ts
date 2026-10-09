// Heredocs, as one notion shared by every question that asks about them (#685). The readers used to
// be three regexes (here, `_markdown.ts`, `bash.ts`), each with its own idea of where an operator
// is and where a body ends, and every disagreement between a regex and the shell was a hole in
// whichever direction the caller was not guarding: a body read too SHORT leaves its lines to be
// parsed as commands (over-denies), a body read too LONG hides the real commands after it — and for
// the verb readers (`networkDecision`, `detectDangerousPatterns`) a hidden command is one that
// keeps the network or skips its prompt. So this is a lexer, not a pattern: it walks the command the
// way `/bin/sh` does, far enough to know which `<<` the shell parses as an operator and which lines
// it then reads as body.
//
//   stripHeredocs / expandingHeredocBodies — the text with every body cut, for the verb readers, and
//     the bodies the shell still expands, for the substitution question (#163, #278).
//   hasHeredocOperator — may this text hold a heredoc body at all? `maskSingleQuotedData` asks it
//     before trusting a quote mask: a body is not quote-parsed, so an apostrophe in one pairs with
//     the next and blanks a `$(…)` that really runs.
//   scanHeredocs — the spans themselves, for `_markdown.ts` (which blanks bodies in place) and the
//     `bash.ts` hint (which asks whether one sits inside a `$(…)`).
//   scanQuotes — the quoting REGIONS of the same walk, for `_readonly.ts`'s two masks (#695). It is
//     the same read of the same text: what the shell calls quoted data here is what the heredoc
//     readers skip as text there, which is why it is one walk and not a second idea of quoting.
//
// What the lexer follows, each one a way a regex had disagreed with the shell:
//   - quoting and escapes: a `<<` inside quotes is text, and `\<<<EOF` is a literal `<` and then a
//     real `<<EOF` — the operator is a run of `<` the shell itself splits, never a substring;
//   - the run: exactly two `<` open a heredoc, three a here-string (whose operand IS quote-parsed),
//     and a longer run is a syntax error, which nothing runs past;
//   - the delimiter is the whole shell WORD after the operator, with its quotes and backslashes
//     removed (`<<"EOF"x` ends at `EOFx`, `<<END-X` at `END-X`);
//   - the terminator is a line that is EXACTLY the delimiter — leading tabs allowed only for `<<-`,
//     trailing whitespace never — plus bash's own extension inside a `$(…)`, where `EOF)` closes
//     both (macOS `/bin/sh` is bash 3.2; zsh and dash reject that shape);
//   - comments, `$((…))` and `((…))`: a `<<` in a comment is text, and in arithmetic it is a shift.
//
// Anything the lexer cannot read exactly sets `uncertain`, and every export fails closed on it: the
// guard fires, nothing is stripped (body lines stay in front of the verb readers, which over-deny),
// and the whole command counts as an expanding body (which the raw substitution test then reads).

export interface Heredoc {
  // The first `<` of the operator, and the end of its delimiter word.
  opAt: number;
  wordEnd: number;
  // The body is [bodyStart, bodyEnd); [bodyStart, end) also takes the terminator line and its
  // newline. Unterminated, all three run to the end of the command, which is what the shell does.
  bodyStart: number;
  bodyEnd: number;
  end: number;
  delimiter: string;
  // Whether the shell pastes the body without expanding it. A quote in the delimiter makes it
  // literal; a backslash alone is deliberately read as expanding — see `readDelimiterWord`.
  literal: boolean;
  // Inside a `$(…)`, a backtick or a process substitution, where macOS `/bin/sh` mis-parses an
  // apostrophe in the body (`heredocSubstitutionHint` in `bash.ts`).
  inSubstitution: boolean;
}

export interface HeredocScan {
  heredocs: Heredoc[];
  // Every region the shell reads as quoted DATA, in the order the lexer closes it — a `'…'` inside a
  // `$(…)` inside a `"…"` is two spans, innermost recorded first. See `scanQuotes`.
  quotes: QuoteSpan[];
  // The walk stopped at a quote it could not close. An unterminated quote is a syntax error, so
  // nothing after it runs — but nothing after it was read either, which the mask callers must know.
  unclosedQuote: boolean;
  // A `$'…'` that bash and dash close at different quotes (an escaped `'` inside it). The spans
  // follow bash, so a mask built from them would blank text dash runs as a command.
  ambiguousQuote: boolean;
  uncertain: boolean;
}

// One quoting region, `[start, end)` in the command. `kind` is which of the shell's three forms
// opened it, because the two masks built from these disagree about the double-quoted one: a `$(…)`
// RUNS inside `"…"` (so `maskSingleQuotedData` leaves that text alone) while a `;` does not.
export interface QuoteSpan {
  start: number;
  end: number;
  kind: 'single' | 'ansi' | 'double';
}

export interface QuoteScan {
  spans: QuoteSpan[];
  // True when the text could not be read exactly and the spans are therefore not to be trusted.
  uncertain: boolean;
}

type FrameKind = 'top' | 'sub' | 'tick' | 'dq' | 'arith';

interface Frame {
  kind: FrameKind;
  // Unclosed `(` inside this frame, so a subshell's `)` does not close the `$(` around it.
  parens: number;
  // A `double` frame's opening quote, so the region it spans can be recorded in `quotes` when it
  // closes — the one span whose start is behind the lexer by the time it is known.
  quoteAt?: number;
}

interface Pending {
  opAt: number;
  wordEnd: number;
  delimiter: string;
  literal: boolean;
  dash: boolean;
  inSubstitution: boolean;
  // What closes the innermost substitution around the operator, if any: bash ends the body at a
  // line that is the delimiter followed directly by it (`EOF)`, `EOF\``).
  closer: ')' | '`' | undefined;
  depth: number;
}

// What ends an unquoted shell word — and so also what lets a `#` after it open a comment.
const WORD_END_RE = /[\s;&|<>()]/;

export function scanHeredocs(command: string): HeredocScan {
  const heredocs: Heredoc[] = [];
  const quotes: QuoteSpan[] = [];
  let unclosedQuote = false;
  let ambiguousQuote = false;
  let uncertain = false;
  const stack: Frame[] = [{ kind: 'top', parens: 0 }];
  let pending: Pending[] = [];
  const n = command.length;
  let i = 0;

  const innermostCloser = (): Pending['closer'] => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].kind === 'sub') return ')';
      if (stack[k].kind === 'tick') return '`';
    }
    return undefined;
  };

  while (i < n) {
    const frame = stack[stack.length - 1];
    const ch = command[i];

    if (frame.kind === 'dq') {
      if (ch === '\\') i += 2;
      else if (ch === '"') {
        stack.pop();
        if (frame.quoteAt !== undefined) {
          quotes.push({ start: frame.quoteAt, end: i + 1, kind: 'double' });
        }
        i++;
      } else if (ch === '`') {
        stack.push({ kind: 'tick', parens: 0 });
        i++;
      } else if (ch === '$' && command[i + 1] === '(') {
        const arith = command[i + 2] === '(';
        stack.push({ kind: arith ? 'arith' : 'sub', parens: 0 });
        i += arith ? 3 : 2;
      } else i++;
      continue;
    }

    if (frame.kind === 'arith') {
      // A shift, not an operator — but `$((` can also be a `$(` holding a subshell, and the lexer
      // does not decide which, so a `<<` here is the one thing it cannot read exactly.
      if (ch === '<' && command[i + 1] === '<') {
        uncertain = true;
        i += 2;
      } else if (ch === '(') {
        frame.parens++;
        i++;
      } else if (ch === ')') {
        if (frame.parens > 0) {
          frame.parens--;
          i++;
        } else {
          stack.pop();
          i += command[i + 1] === ')' ? 2 : 1;
        }
      } else i++;
      continue;
    }

    // A command context: the top level, a `$(…)`, a backtick or a process substitution.
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) {
        // An unterminated quote is a syntax error: nothing runs. The lexer stops with it, and says
        // so — the mask callers must not fill in the rest by guessing.
        unclosedQuote = true;
        break;
      }
      quotes.push({ start: i, end: close + 1, kind: 'single' });
      i = close + 1;
      continue;
    }
    if (ch === '$' && command[i + 1] === "'") {
      // ANSI-C quoting, the one single-quoted form a backslash escapes inside.
      let j = i + 2;
      while (j < n && command[j] !== "'") j += command[j] === '\\' ? 2 : 1;
      // dash, `/bin/sh` on Debian/Ubuntu, has no `$'…'`: it reads `$` and then a plain `'…'`
      // closed by the FIRST `'`. Where an escaped quote makes the two closes differ, the text after
      // it is a command in one shell and data in the other, and `bash` runs `/bin/sh -c`.
      if (command.indexOf("'", i + 2) !== (j < n ? j : -1)) {
        ambiguousQuote = true;
        uncertain = true;
      }
      if (j >= n) {
        unclosedQuote = true;
        break;
      }
      quotes.push({ start: i, end: j + 1, kind: 'ansi' });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      stack.push({ kind: 'dq', parens: 0, quoteAt: i });
      i++;
      continue;
    }
    if (ch === '`') {
      if (frame.kind === 'tick') stack.pop();
      else stack.push({ kind: 'tick', parens: 0 });
      i++;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const arith = command[i + 2] === '(';
      stack.push({ kind: arith ? 'arith' : 'sub', parens: 0 });
      i += arith ? 3 : 2;
      continue;
    }
    if (ch === '#' && (i === 0 || WORD_END_RE.test(command[i - 1]))) {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (ch === '(') {
      if (command[i + 1] === '(' && (i === 0 || WORD_END_RE.test(command[i - 1]))) {
        stack.push({ kind: 'arith', parens: 0 });
        i += 2;
      } else {
        frame.parens++;
        i++;
      }
      continue;
    }
    if (ch === ')') {
      if (frame.parens > 0) frame.parens--;
      else if (frame.kind === 'sub') stack.pop();
      i++;
      continue;
    }
    if ((ch === '<' || ch === '>') && command[i + 1] === '(') {
      // Process substitution runs a command of its own, with its own heredocs.
      stack.push({ kind: 'sub', parens: 0 });
      i += 2;
      continue;
    }
    if (ch === '<') {
      let run = 0;
      while (command[i + run] === '<') run++;
      if (run === 3) {
        i += 3;
        continue;
      }
      if (run !== 2) {
        // `<` is a redirect; four or more is a syntax error the lexer does not try to split.
        if (run > 3) uncertain = true;
        i += run;
        continue;
      }
      let j = i + 2;
      const dash = command[j] === '-';
      if (dash) j++;
      while (command[j] === ' ' || command[j] === '\t') j++;
      const word = readDelimiterWord(command, j);
      if (!word) {
        uncertain = true;
        i = j;
        continue;
      }
      pending.push({
        opAt: i,
        wordEnd: word.end,
        delimiter: word.delimiter,
        literal: word.literal,
        dash,
        inSubstitution: innermostCloser() !== undefined,
        closer: innermostCloser(),
        depth: stack.length,
      });
      i = word.end;
      continue;
    }
    if (ch === '\n' && pending.length > 0) {
      let pos = i + 1;
      for (const p of pending) {
        if (p.depth !== stack.length) uncertain = true;
        const body = readBody(command, pos, p);
        heredocs.push({
          ...pendingFields(p),
          bodyStart: pos,
          bodyEnd: body.bodyEnd,
          end: body.end,
        });
        pos = body.end;
      }
      pending = [];
      i = pos;
      continue;
    }
    i++;
  }
  // An operator whose line never ended has no body — the shell reads none — but it is still an
  // operator, so the guard fires on it and the strip still takes its delimiter word.
  for (const p of pending) heredocs.push({ ...pendingFields(p), bodyStart: n, bodyEnd: n, end: n });
  // A double quote still open at the end never closed. The other frames (`$(…)`, a backtick,
  // arithmetic) do not matter here: the text inside them is quote-parsed the same way whether or not
  // the `)` ever arrives, so the spans read there are good either way.
  if (stack.some(f => f.kind === 'dq')) unclosedQuote = true;
  return { heredocs, quotes, unclosedQuote, ambiguousQuote, uncertain };
}

function pendingFields(p: Pending) {
  return {
    opAt: p.opAt,
    wordEnd: p.wordEnd,
    delimiter: p.delimiter,
    literal: p.literal,
    inSubstitution: p.inSubstitution,
  };
}

// The delimiter WORD, with quote removal done the way the shell does it. `literal` is true only for a
// quote: all four shells measured (sh, bash, dash, zsh) also make a `<<\EOF` body literal, since a
// backslash quotes a character of the word, but reading it as expanding is the fail-closed side —
// it costs a local read (`git apply -`, `hash-object --stdin`) a network allow it did not need,
// where the other side would hand a `$(…)` in that body the network if any shell disagreed. A
// substitution in the word is not expanded by the shell either, but where its `)` falls is the
// lexer's guess, so that word is not read at all.
function readDelimiterWord(
  command: string,
  start: number,
): { delimiter: string; literal: boolean; end: number } | undefined {
  let delimiter = '';
  let literal = false;
  let j = start;
  while (j < command.length && !WORD_END_RE.test(command[j])) {
    const ch = command[j];
    if (ch === '\\') {
      if (j + 1 >= command.length || command[j + 1] === '\n') return undefined;
      delimiter += command[j + 1];
      j += 2;
    } else if (ch === "'") {
      const close = command.indexOf("'", j + 1);
      if (close === -1) return undefined;
      delimiter += command.slice(j + 1, close);
      literal = true;
      j = close + 1;
    } else if (ch === '"') {
      let k = j + 1;
      while (k < command.length && command[k] !== '"') {
        if (command[k] === '\\' && /["\\$`]/.test(command[k + 1] ?? '')) k++;
        delimiter += command[k];
        k++;
      }
      if (k >= command.length) return undefined;
      literal = true;
      j = k + 1;
    } else if (ch === '`' || (ch === '$' && command[j + 1] === '(')) {
      return undefined;
    } else {
      delimiter += ch;
      j++;
    }
  }
  if (j === start || delimiter === '') return undefined;
  return { delimiter, literal, end: j };
}

function readBody(command: string, start: number, p: Pending): { bodyEnd: number; end: number } {
  let pos = start;
  while (pos < command.length) {
    const nl = command.indexOf('\n', pos);
    const lineEnd = nl === -1 ? command.length : nl;
    const line = command.slice(pos, lineEnd);
    const tabs = p.dash ? (/^\t*/.exec(line)?.[0].length ?? 0) : 0;
    const text = line.slice(tabs);
    if (text === p.delimiter) return { bodyEnd: pos, end: nl === -1 ? lineEnd : nl + 1 };
    // bash closes a heredoc at `EOF)` inside a `$(…)` (and `EOF\`` inside backticks); the closer is
    // left for the lexer to close the substitution with.
    if (p.closer && text.startsWith(p.delimiter + p.closer)) {
      return { bodyEnd: pos, end: pos + tabs + p.delimiter.length };
    }
    pos = lineEnd + 1;
  }
  return { bodyEnd: command.length, end: command.length };
}

export function hasHeredocOperator(command: string): boolean {
  const scan = scanHeredocs(command);
  return scan.uncertain || scan.heredocs.length > 0;
}

// The quoting regions of a command, for the length-preserving masks in `_readonly.ts` (#695). Same
// walk as `scanHeredocs`, because the two questions are the same read: a region this call reports as
// quoted data is one the heredoc readers skip as text (`$'…'`, a quoted delimiter, prose in a
// double-quoted `--body`), and a region it reports nothing about is one the shell parses as commands.
//
// `uncertain` is the quoting walk's own doubt — an unterminated quote, or a `$'…'` bash and dash
// close at different quotes — not `HeredocScan.uncertain`. Everything that makes the heredoc half
// unsure (a `<<` in arithmetic, a run of four `<`, a delimiter word it cannot read) is about `<`, and
// folding it in would refuse the mask over a `<<` that has nothing to do with quoting. That is not a
// claim the walk reads such text correctly: after an unreadable delimiter it quote-parses a body the
// shell does not. What keeps that from hiding a command today is that a stray quote in the body
// leaves the walk unclosed, so the mask blanks nothing — a mask that trusted a partial walk would
// lose that.
export function scanQuotes(command: string): QuoteScan {
  const scan = scanHeredocs(command);
  return { spans: scan.quotes, uncertain: scan.unclosedQuote || scan.ambiguousQuote };
}

// The command with each heredoc's operator, delimiter word, body and terminator line cut, and the
// rest of the operator's line kept — `cat <<EOF > out.md` still writes `out.md`, and
// `… <<EOF && curl x` still runs `curl`, which a cut through to the body's end used to hide. Also
// read by the sandbox's network classifier (#163): a body's lines would otherwise split into
// segments whose "verb" is prose, denying `gh issue comment --body-file - <<EOF …`.
export function stripHeredocs(command: string): string {
  const scan = scanHeredocs(command);
  if (scan.uncertain) return command;
  const cuts = scan.heredocs.flatMap(h => [
    [h.opAt, h.wordEnd],
    [h.bodyStart, h.end],
  ]);
  cuts.sort((a, b) => b[0] - a[0]);
  let s = command;
  for (const [from, to] of cuts) s = s.slice(0, from) + s.slice(to);
  return s;
}

// The heredoc bodies the shell EXPANDS, which `stripHeredocs` cuts away with the rest: `$…` and a
// backtick in a body are only data when the delimiter was quoted, so `<<EOF` runs what `<<'EOF'`
// pastes. Cutting them answers the verb question correctly and the substitution question wrongly,
// because a `$(…)` in an expanding body DOES run, with whatever network the line's `git`/`gh` verb
// was granted — so the caller re-reads these. The newline before the terminator ends the body
// rather than belonging to it.
export function expandingHeredocBodies(command: string): string[] {
  const scan = scanHeredocs(command);
  if (scan.uncertain) return [command];
  return scan.heredocs
    .filter(h => !h.literal && h.bodyEnd > h.bodyStart)
    .map(h => command.slice(h.bodyStart, h.bodyEnd).replace(/\n$/, ''));
}
