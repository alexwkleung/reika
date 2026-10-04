// Text on a command line that ends up in Markdown, and therefore never runs. The danger scan
// (`_danger.ts`) matches the literal command text, which is exactly what makes it hard to fool —
// and exactly why it fires on prose: `gh pr create --body "$(cat <<'EOF' … we run rm -rf / … EOF)"`
// reports "Recursive force delete" for a sentence, and `cat > CHANGELOG.md <<'EOF'` prompts under
// `safe` for a changelog entry that merely *mentions* a destructive command. The user then reads a
// dialog recommending they consider an rm they are not being asked to run, which is the reflexive
// approval this gate cannot afford (see AGENTS.md, "Approval gate").
//
// So this file answers one question — which stretches of a command are Markdown DATA — and blanks
// them, length-preserving, before the patterns run. Two producers, and only the ones a model
// actually reaches for:
//
//   - a shell text writer (`cat`, `tee`, `printf`, `echo`) whose redirect target or operand is a
//     Markdown path: `cat > CHANGELOG.md <<'EOF'`. The extension is the whole claim — `cat > run.sh`
//     is a script and stays flagged, which is the undershoot that keeps this honest.
//   - a `gh` segment carrying one of the flags whose value GitHub renders as Markdown (`--body`,
//     `--title`, `--notes`, and the `-file` forms), including the heredoc a `--body-file -` reads.
//
// What it deliberately does NOT blank is anything the shell still EXECUTES inside that text: a
// substitution runs in a body whose delimiter was unquoted (`<<EOF`) and in any double-quoted or
// bare argument, so `$(…)` and backticks inside those are kept verbatim and the ordinary scan still
// answers for them. That is the same rule `_sandbox.ts` applies to heredoc bodies (data for the verb
// question, re-read for the substitution one), narrowed here to text we can name as Markdown.
import { maskQuoted } from './_readonly.js';

// Matched exactly as `_writetargets.ts` matches it: `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`.
const HEREDOC_OP_RE = /<<-?\s*(['"]?)(\w+)\1/g;

// The extensions that make a written file Markdown. `mdx` rides along because it is read as
// Markdown with JSX in it; a component file is not what this is for, and a false negative there
// costs one missed label on an uncommon shape.
const MARKDOWN_PATH_RE = /\.(?:md|markdown|mdx)$/i;

// Words whose arguments are the text being written rather than a program being run. Short on
// purpose: `sed`, `awk` and `perl` take a PROGRAM as an argument, so their text is not data, and
// `git log > notes.md` writes a file whose arguments are flags — neither is this rule's case.
const TEXT_WRITERS = new Set(['cat', 'tee', 'printf', 'echo']);

// `gh`'s prose flags. Enumerated by flag rather than by noun/verb because it is the flag that says
// "this is text GitHub renders" — the same words on every verb that has them (`issue`/`pr`/`release`
// create|edit|comment|review, `gist create`), and a noun/verb table would need a new entry for each.
const GH_TEXT_FLAGS = new Set([
  '-b',
  '--body',
  '-F',
  '--body-file',
  '-t',
  '--title',
  '-n',
  '--notes',
  '--notes-file',
  '-d',
  '--desc',
  '--description',
]);

// A segment boundary: what starts a new command. Only the plain separators — never `(` or `$(`,
// because the segment holding a heredoc operator is the one whose WORDS name the Markdown producer,
// and `gh pr create --body "$(cat <<'EOF'` must read as one `gh` segment rather than as a bare `cat`.
const SEPARATOR_RE = /[;&|\r\n]+/g;

// `>f`, `>> f`, `2>f`, `&>f` — the same shape `_writetargets.ts` reads targets off.
const REDIRECT_WORD_RE = /^(?:\d+|&)?>>?(.*)$/;

interface Region {
  start: number;
  end: number;
  // Whether the shell still expands substitutions in this text: false for a quoted heredoc
  // (`<<'EOF'` pastes what is between the delimiters) and for a single-quoted argument.
  expands: boolean;
}

// Blank every Markdown-data region of `command`, preserving offsets and newlines. Length-preserving
// so a caller can keep indexing the original string, newline-preserving so every line-based parser
// downstream (`stripHeredocs`, `segmentsWithDir`, the segment splits) still sees the same shape.
export function maskMarkdownData(command: string): string {
  const regions = [...heredocRegions(command), ...argumentRegions(command)];
  // Outer first, so a nested heredoc's own verdict — which is the more precise one — is the one
  // that lands: `--body "$(cat <<'EOF' … EOF)"` is a text region (expands) with a quoted heredoc
  // inside it (does not), and the body must end up blanked.
  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  let masked = command;
  for (const r of regions) {
    const blanked = blankData(masked.slice(r.start, r.end), r.expands);
    masked = masked.slice(0, r.start) + blanked + masked.slice(r.end);
  }
  return masked;
}

// Heredoc bodies whose segment writes Markdown. The operator's own segment is what decides, not the
// line: two heredocs on one line are two different commands more often than they are one.
function heredocRegions(command: string): Region[] {
  const out: Region[] = [];
  // The operators are read from the RAW command, and the segments from the quote mask. That split is
  // forced: `gh pr create --body "$(cat <<'EOF' … EOF)"` puts the operator INSIDE the double-quoted
  // value, and the mask blanks the whole value — reading operators off the mask finds nothing and
  // turns this rule off for the most common shape there is (measured: that exact command stopped
  // being recognised the moment the operator scan switched to the mask). A `<<` inside a quoted
  // string that IS a heredoc's own body is skipped by the containment check below; a `<<` in some
  // other quoted string is a miss, in the direction that leaves a label on.
  const view = maskQuoted(command);
  // Compute every operator's body first, then cut them out together — back to front, so each cut
  // leaves the offsets of everything before it alone. `stripHeredocs` walks a shrinking tail instead,
  // which is the same answer, but the CUT bodies are not this function's output: it needs the
  // offsets, and a tail it mutates while another pass is still reading it is a bug waiting to
  // happen (a second heredoc's operator lands inside the first body's hole and the scan never
  // resumes — measured, and it silently turned the rule off for everything after the first heredoc).
  const spans: Array<{ start: number; end: number; opAt: number; quoted: boolean }> = [];
  for (const m of command.matchAll(HEREDOC_OP_RE)) {
    const bodyStart = command.indexOf('\n', m.index);
    if (bodyStart === -1) break;
    const endRe = new RegExp(`^\\s*${m[2]}\\s*$`, 'm');
    const rest = command.slice(bodyStart + 1);
    const end = endRe.exec(rest);
    spans.push({
      start: bodyStart + 1,
      end: bodyStart + 1 + (end ? end.index : rest.length),
      opAt: m.index,
      quoted: m[1] !== '',
    });
    if (spans.some(s2 => bodyStart + 1 > s2.start && bodyStart + 1 < s2.end)) break;
  }
  for (const span of spans) {
    const seg = segmentAt(command, view, span.opAt);
    if (!seg || !isMarkdownSegment(seg.text)) continue;
    out.push({ start: span.start, end: span.end, expands: !span.quoted });
  }
  return out;
}

// Shell words whose text is Markdown by the flag it rides or the file it lands in.
function argumentRegions(command: string): Region[] {
  const out: Region[] = [];
  const view = maskQuoted(command);
  // Every segment, including the last one — the common shape (`gh pr create --body "…"` with nothing
  // after it) ends at the end of the command rather than at a separator.
  const bounds: Array<{ start: number; end: number }> = [];
  let from = 0;
  SEPARATOR_RE.lastIndex = 0;
  for (let m = SEPARATOR_RE.exec(view); m; m = SEPARATOR_RE.exec(view)) {
    bounds.push({ start: from, end: m.index });
    from = m.index + m[0].length;
  }
  bounds.push({ start: from, end: view.length });
  for (const { start, end: segEnd } of bounds) {
    // Raw words, not the masked view's: the value of `--body "…"` and a quoted redirect target are
    // blanked in the view (that is the point of it), and their OFFSETS are what this pass needs.
    const seg = command.slice(start, segEnd);
    const words = shellWords(seg);
    const name = unquote(words[0]?.text ?? '');
    if (!name) continue;
    if (name === 'gh') {
      for (let i = 0; i < words.length; i++) {
        // The flag is what sits before the `=`, when there is one: `--body="…"` is `--body` with a
        // value, and comparing the whole word against the set missed exactly that spelling.
        const eq = words[i].text.indexOf('=');
        const flag = unquote(eq === -1 ? words[i].text : words[i].text.slice(0, eq));
        if (!GH_TEXT_FLAGS.has(flag)) continue;
        if (eq !== -1) {
          out.push({ start: start + words[i].at + eq + 1, end: segEnd, expands: true });
        } else if (words[i + 1]) {
          out.push({
            start: start + words[i + 1].at,
            end: segEnd,
            expands: words[i + 1].text[0] !== "'",
          });
        }
      }
      continue;
    }
    if (!TEXT_WRITERS.has(name)) continue;
    if (!writesMarkdown(words, name)) continue;
    // Everything after the command word is text it is writing: operands and the redirect clause
    // alike. `cat README.md` with no redirect is a read and is not this case.
    out.push({ start: start + words[0].at + words[0].text.length, end: segEnd, expands: true });
  }
  return out;
}

// Words split the way the shell splits them: a quoted run is ONE word (`--body="a b"` is a single
// argument, and splitting it on the space made the flag unreadable — measured, on the `--body=` form
// specifically). Offsets are preserved so a caller can cut the value back out of the original.
function shellWords(seg: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let i = 0;
  while (i < seg.length) {
    if (/\s/.test(seg[i])) {
      i++;
      continue;
    }
    const at = i;
    let text = '';
    while (i < seg.length && !/\s/.test(seg[i])) {
      const ch = seg[i];
      if (ch === '"' || ch === "'") {
        const close = seg.indexOf(ch, i + 1);
        if (close === -1) {
          text += seg.slice(i);
          i = seg.length;
          break;
        }
        text += seg.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      text += ch;
      i++;
    }
    out.push({ text, at });
  }
  return out;
}

function writesMarkdown(words: Array<{ text: string }>, name: string): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = unquote(words[i].text);
    const redirect = REDIRECT_WORD_RE.exec(w);
    if (redirect) {
      // `>f` carries the target in the same word; `> f` in the next one.
      const target = redirect[1] || unquote(words[i + 1]?.text ?? '');
      if (target && !target.startsWith('&') && MARKDOWN_PATH_RE.test(target)) return true;
      continue;
    }
    if (name === 'tee' && i > 0 && !w.startsWith('-') && MARKDOWN_PATH_RE.test(w)) return true;
  }
  return false;
}

// The segment an offset sits in: back to the previous separator, forward to the next one. The
// BOUNDARIES come from the quote-masked view, so a separator inside a quoted string is not one; the
// words come from the raw text, so a quoted target (`cat > "CHANGELOG.md"`) is still readable as the
// path it names — masking it away would silently turn this rule off for every quoted operand.
function segmentAt(command: string, view: string, at: number): { text: string } | undefined {
  const before = view.slice(0, at);
  const after = view.slice(at);
  let start = 0;
  for (const m of before.matchAll(SEPARATOR_RE)) start = (m.index ?? 0) + m[0].length;
  let last = 0;
  for (const m of after.matchAll(SEPARATOR_RE)) last = (m.index ?? 0) + m[0].length;
  const end = at + last;
  if (end <= start) return undefined;
  return { text: command.slice(start, end) };
}

function isMarkdownSegment(seg: string): boolean {
  const words = shellWords(seg);
  const name = unquote(words[0]?.text ?? '');
  // Same up-to-the-`=` reading as the argument pass: `--body="…"` has to count as a text flag or the
  // heredoc it carries is never recognised as Markdown.
  if (name === 'gh') {
    return words.some(w => {
      const eq = w.text.indexOf('=');
      return GH_TEXT_FLAGS.has(unquote(eq === -1 ? w.text : w.text.slice(0, eq)));
    });
  }
  if (!TEXT_WRITERS.has(name)) return false;
  return writesMarkdown(words, name);
}

function unquote(word: string): string {
  return word.replace(/['"]/g, '');
}

// Blank a stretch of data, keeping the newlines (so line-based parsers downstream see the same
// shape) and — only where the shell still expands them — the substitutions inside it.
function blankData(text: string, expands: boolean): string {
  const blank = text.replace(/[^\n]/g, ' ');
  if (!expands) return blank;
  const chars = [...blank];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '$' && ch !== '`') continue;
    let end = -1;
    if (ch === '`') end = text.indexOf('`', i + 1);
    else if (text[i + 1] === '(') end = matchParen(text, i + 1);
    if (end === -1) continue;
    // Keep the substitution, spaces elsewhere: it is the one part of this text that runs.
    for (let k = i; k <= end; k++) chars[k] = text[k];
    i = end;
  }
  return chars.join('');
}

// The `)` that closes the paren at `open`, or -1 when the text never closes it. Single- and
// double-quoted runs inside are skipped whole so a `)` in a string cannot close the span early —
// the early close is the direction that would restore text the shell does not run.
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) return -1;
      i = close;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}
