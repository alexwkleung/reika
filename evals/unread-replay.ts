#!/usr/bin/env tsx
// Measures #828's proposed reader check offline, before any gate is built: for a diff, what did it
// introduce that nothing reads? Two kinds, both read by regex rather than the TS compiler:
//
// - a new function or module-level const with no reader outside its own declaration (same file for
//   a module-local one; for an export, a non-test file that names it and imports its module)
// - a new parameter on an existing function that no non-test call site passes
//
// New fields on a type are NOT covered: a field is read by name (`.profile`), and a common name is
// read somewhere for an unrelated reason, so a regex either flags everything or nothing.
//
// Two corpora. Patch files (a bench run's diff.patch) applied onto `--base`, which is the hit rate;
// and reika's own first-parent merges, which are correct, accepted diffs, so every flag there is a
// false positive or a deliberate placeholder.
//
// Usage:
//   npx tsx evals/unread-replay.ts [--merges=200] [--base=<rev> patch ...] [--quiet]
//
// Result on 2026-10-27 (main at c574eab): the 18 non-empty T2 bench diffs on 5a311d0 gave 6 flags,
// every one a real unwired piece (LFM rf-1 and rf-3 among them; rf-2's leftover is a field). The
// last 200 merges gave 6 flags in 3 PRs, every one a symbol or parameter only tests read.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

type Tree = Map<string, string>;
type Flag = { kind: 'symbol' | 'param'; file: string; name: string; detail: string };

const repoRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (k: string) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const mergeCount = Number(opt('merges') ?? 200);
const base = opt('base');
const quiet = args.includes('--quiet');
const patches = args.filter(a => !a.startsWith('--'));

const SOURCE = /\.(ts|tsx|mts|js|mjs|cjs|vue)$/;
const TEST = /\.test\.|\.spec\.|__tests__\//;
const SKIP_DIR = /(^|\/)(node_modules|dist)\//;

function git(argv: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  return execFileSync('git', argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
    input,
  });
}

function loadTree(rev: string): Tree {
  const paths = git(['ls-tree', '-r', '--name-only', rev])
    .split('\n')
    .filter(p => p && SOURCE.test(p) && !SKIP_DIR.test(p));
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
    input: paths.map(p => `${rev}:${p}`).join('\n') + '\n',
  });
  const tree: Tree = new Map();
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(' ')[2]);
    tree.set(p, out.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    at = nl + 1 + size + 1;
  }
  return tree;
}

// Blanks comments, keeping strings intact (a `'**/*.ts'` glob must not open a block comment) and
// every newline, so line numbers still match the source.
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && !(c !== '`' && src[j] === '\n'))
        j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = (end < 0 ? src.length : end) - 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out;
}

const DECL_RE =
  /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:])/gm;

function declarations(src: string): Map<string, { exported: boolean; line: number }> {
  const out = new Map<string, { exported: boolean; line: number }>();
  for (const m of stripComments(src).matchAll(DECL_RE)) {
    const name = m[2] ?? m[3];
    const line = src.slice(0, m.index).split('\n').length;
    out.set(name, { exported: !!m[1], line });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[$]/g, '\\$');
}

function occurrences(src: string, name: string): number {
  return (
    stripComments(src).match(
      new RegExp(`(?<![\\w$])(?<!(?:^|[^.])\\.)${escapeRe(name)}(?![\\w$])`, 'g'),
    ) ?? []
  ).length;
}

function importsModule(src: string, file: string): boolean {
  const stem = basename(file).replace(SOURCE, '');
  return new RegExp(`['"][^'"]*/${escapeRe(stem)}(\\.(js|ts|tsx|mjs))?['"]`).test(src);
}

function hasReader(tree: Tree, file: string, name: string, exported: boolean): boolean {
  if (occurrences(tree.get(file) ?? '', name) > 1) return true;
  if (!exported) return false;
  for (const [p, src] of tree) {
    if (p === file || TEST.test(p)) continue;
    if (occurrences(src, name) > 0 && importsModule(src, file)) return true;
  }
  return false;
}

// Top-level commas in a bracketed list starting at `open` (the index of `(`). `angle` counts `<>`
// too, for a signature's generic types; a call's args leave it off, where `<` is a comparison.
function listArity(
  src: string,
  open: number,
  angle: boolean,
): { count: number; spread: boolean } | null {
  let depth = 0;
  let count = 0;
  let sawToken = false;
  let spread = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) return null;
      i = end;
      sawToken = true;
      continue;
    }
    if (c === '=' && src[i + 1] === '>') {
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{' || (angle && c === '<')) {
      if (depth >= 1) sawToken = true;
      depth++;
    } else if (c === ')' || c === ']' || c === '}' || (angle && c === '>')) {
      depth--;
      if (depth === 0) return { count: sawToken ? count + 1 : count, spread };
    } else if (depth === 1) {
      if (c === ',') {
        count++;
        sawToken = false;
        continue;
      }
      if (c === '.' && src.startsWith('...', i)) spread = true;
      if (!/\s/.test(c)) sawToken = true;
    }
  }
  return null;
}

const SIG_RE =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/g;

function signatures(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const clean = stripComments(src);
  for (const m of clean.matchAll(SIG_RE)) {
    const open = m.index + m[0].length - 1;
    const r = listArity(clean, open, true);
    if (r) out.set(m[1], r.count);
  }
  return out;
}

function maxCallArity(tree: Tree, name: string): { calls: number; max: number } {
  let calls = 0;
  let max = -1;
  const re = new RegExp(
    `(?<![\\w$])(?<!(?:^|[^.])\\.)(?<!function\\s+)${escapeRe(name)}\\s*\\(`,
    'g',
  );
  for (const [p, src] of tree) {
    if (TEST.test(p)) continue;
    const clean = stripComments(src);
    for (const m of clean.matchAll(re)) {
      const r = listArity(clean, m.index + m[0].length - 1, false);
      if (!r) continue;
      calls++;
      max = Math.max(max, r.spread ? Infinity : r.count);
    }
  }
  return { calls, max };
}

function scan(before: Tree, after: Tree, changed: string[]): Flag[] {
  const flags: Flag[] = [];
  for (const file of changed) {
    if (TEST.test(file) || !SOURCE.test(file) || file.endsWith('.vue') || SKIP_DIR.test(file))
      continue;
    const now = after.get(file);
    if (now === undefined) continue;
    const prev = before.get(file);
    const had = declarations(prev ?? '');
    for (const [name, d] of declarations(now)) {
      if (had.has(name) || name === 'default') continue;
      if (!hasReader(after, file, name, d.exported)) {
        flags.push({
          kind: 'symbol',
          file,
          name,
          detail: `${d.exported ? 'exported' : 'module-local'}, line ${d.line}`,
        });
      }
    }
    if (prev === undefined) continue;
    const oldSigs = signatures(prev);
    for (const [name, n] of signatures(now)) {
      const o = oldSigs.get(name);
      if (o === undefined || n <= o) continue;
      const { calls, max } = maxCallArity(after, name);
      // No non-test caller at all is the symbol check's case, or an entry point's.
      if (calls > 0 && max < n) {
        flags.push({
          kind: 'param',
          file,
          name,
          detail: `${o}→${n} params, callers pass at most ${max}`,
        });
      }
    }
  }
  return flags;
}

function changedFiles(from: string, to: string): string[] {
  return git(['diff', '--name-only', '--diff-filter=AM', from, to]).split('\n').filter(Boolean);
}

function patchTree(baseRev: string, patch: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'unread-replay-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(['read-tree', baseRev], env);
    git(['apply', '--cached', patch], env);
    return git(['write-tree'], env).trim();
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function print(label: string, flags: Flag[]): void {
  console.log(`${label}: ${flags.length} flag(s)`);
  if (quiet) return;
  for (const f of flags) console.log(`  [${f.kind}] ${f.file} ${f.name} (${f.detail})`);
}

if (patches.length > 0) {
  if (!base) throw new Error('patch files need --base=<rev>');
  const baseTree = loadTree(base);
  console.log(`== patches on ${base}`);
  for (const patch of patches) {
    const tree = patchTree(base, resolve(patch));
    if (!tree) {
      console.log(`${patch}: does not apply`);
      continue;
    }
    print(patch, scan(baseTree, loadTree(tree), changedFiles(base, tree)));
  }
}

if (mergeCount > 0) {
  const merges = git([
    'log',
    '--first-parent',
    '--merges',
    `-n${mergeCount}`,
    '--format=%H %s',
    'main',
  ])
    .split('\n')
    .filter(Boolean);
  console.log(`== ${merges.length} merges on main`);
  let flagged = 0;
  let total = 0;
  for (const line of merges) {
    const [sha, ...subject] = line.split(' ');
    const changed = changedFiles(`${sha}^1`, sha);
    const flags = scan(loadTree(`${sha}^1`), loadTree(sha), changed);
    total += flags.length;
    if (flags.length > 0) {
      flagged++;
      print(`${sha.slice(0, 7)} ${subject.join(' ').slice(0, 70)}`, flags);
    }
  }
  console.log(`merges flagged: ${flagged}/${merges.length}, flags: ${total}`);
}
