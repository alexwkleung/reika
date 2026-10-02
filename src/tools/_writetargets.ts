import { resolve } from 'node:path';
import { WORD_RE, maskQuoted, splitSegments } from './_readonly.js';

// The files a shell command names as things it will write — the fallback change detector for a
// project with no git (#278). Best-effort by construction: it sees the shapes a model reaches for
// when it edits through the shell (a heredoc or `echo` into a redirect, `sed -i`, `tee`, `cp`/`mv`,
// `rm`) and cannot see a formatter or a script that writes wherever it likes. Inside a repo git is
// the detector and this is never consulted; see _treediff.ts.
//
// Pure: absolute paths out, resolved against `cwd` with any leading `cd` hops applied.

const MAX_TARGETS = 20;

// `<<EOF … EOF`: the body is data, and its lines would otherwise parse as commands with redirects.
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1/;

export function writeTargets(command: string, cwd: string): string[] {
  const stripped = stripHeredocs(command);
  const out = new Set<string>();
  let dir = cwd;
  for (const raw of splitSegments(stripped, maskQuoted(stripped))) {
    // Raw words keep their quotes so a quoted `>` (grep's pattern) is data, not a redirect.
    const rawWords = raw.trim().match(WORD_RE) ?? [];
    const targets: string[] = [];
    const bare: string[] = [];
    for (let i = 0; i < rawWords.length; i++) {
      // Redirects are targets whatever the command: `> f`, `>> f`, `2> f`, `&> f`, attached or
      // not. `>&1`-style descriptor dups name no file.
      const m = REDIRECT_WORD_RE.exec(rawWords[i]);
      if (m) {
        const target = unquote(m[1] || rawWords[++i] || '');
        if (target && !target.startsWith('&')) targets.push(target);
        continue;
      }
      const w = unquote(rawWords[i]);
      if (w !== '') bare.push(w);
    }
    const [name, ...args] = bare;
    if (name === 'cd') {
      if (args[0]) dir = resolve(dir, args[0]);
      continue;
    }
    if (name) targets.push(...commandTargets(name, args));
    for (const t of targets) {
      if (t.startsWith('/dev/')) continue;
      out.add(resolve(dir, t));
      if (out.size >= MAX_TARGETS) return [...out];
    }
  }
  return [...out];
}

// `&` is a segment separator, so `&>f` arrives as a segment starting with `>f`.
const REDIRECT_WORD_RE = /^\d?>>?(.*)$/;

function unquote(word: string): string {
  return word.replace(/['"]/g, '');
}

// Files a command writes by its own convention, from its operands.
function commandTargets(name: string, args: string[]): string[] {
  const operands: string[] = [];
  let script: 'pending' | 'flagged' = 'pending';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) {
      operands.push(a);
      continue;
    }
    // sed/perl: the script rides a flag, so the first bare operand is a file, not the script.
    if ((name === 'sed' || name === 'perl') && /^(-e|-f|--expression|--file)$/.test(a)) {
      i++;
      script = 'flagged';
    }
  }
  switch (name) {
    case 'sed':
      if (!args.some(a => /^(-[a-zA-Z]*i|--in-place)/.test(a))) return [];
      if (script === 'pending') operands.shift();
      return operands;
    case 'perl':
      if (!args.some(a => /^-[a-zA-Z]*i/.test(a))) return [];
      if (script === 'pending') operands.shift();
      return operands;
    case 'tee':
    case 'rm':
    case 'touch':
      return operands;
    case 'cp':
    case 'mv':
      // The destination. When it's a directory the real target is inside it, which a snapshot of
      // the directory path itself can't diff — accepted; the common model shape names a file.
      return operands.length >= 2 ? [operands[operands.length - 1]] : [];
    default:
      return [];
  }
}

// Also read by the sandbox's network classifier (#163): a heredoc body's lines would otherwise
// split into segments whose "verb" is prose, denying `gh issue comment --body-file - <<EOF …`.
export function stripHeredocs(command: string): string {
  let s = command;
  for (let m = HEREDOC_RE.exec(s); m; m = HEREDOC_RE.exec(s)) {
    const bodyStart = s.indexOf('\n', m.index);
    if (bodyStart === -1) break;
    const endRe = new RegExp(`^\\s*${m[2]}\\s*$`, 'm');
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
// can never be read as a heredoc operator of its own.
export function expandingHeredocBodies(command: string): string[] {
  const bodies: string[] = [];
  let s = command;
  for (let m = HEREDOC_RE.exec(s); m; m = HEREDOC_RE.exec(s)) {
    const quoted = m[1] !== '';
    const bodyStart = s.indexOf('\n', m.index);
    if (bodyStart === -1) break;
    const endRe = new RegExp(`^\\s*${m[2]}\\s*$`, 'm');
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
