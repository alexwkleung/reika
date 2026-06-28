import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Ignore } from 'ignore';
import { shouldSkipDir } from '../tools/_walk.js';

// Plan→agent grounding check. Local models sometimes write a plan that references symbols or files
// that don't exist in the codebase (renamed, misremembered, or hallucinated) — the agent then loops
// hunting for them (0-match greps, edits whose old_string isn't in any file). This module extracts
// the concrete code references a plan names and verifies they exist, so the handoff can flag the
// unverified ones up front instead of the agent discovering them by looping. Deterministic and
// harness-owned. See loop.ts for the wiring (gated behind REIKA_PLAN_VERIFY).

// Cap how many references we check, so a long plan can't trigger an unbounded verification sweep or
// a wall of warnings. Newest-first isn't meaningful here; just bound the count.
const MAX_REFS = 20;
// Bound the verification walk so a genuinely-missing symbol on a huge repo can't make us scan
// forever. If the cap is hit with symbols still unconfirmed, they're left UNVERIFIED (not flagged) —
// the conservative direction: a missed warning beats a false one.
const MAX_SCAN_BYTES = 64_000_000;
const MAX_FILE_BYTES = 1_000_000;

export type PlanReferences = { symbols: string[]; paths: string[] };

// A backticked span that looks like a file path: has a directory separator and a file extension.
const PATH_LIKE = /^[\w./@~-]+\/[\w./@-]+\.\w+$/;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// "Code-y" identifier: camelCase / PascalCase-with-internal-cap / snake_case / $-form. This filters
// plain backticked English ("enabled", "true", "the panel") while keeping streamUnifiedAsk,
// forceWebSearch, WebSearchToggle, use_chat. Deliberately conservative — an all-lowercase single
// word like `tavily` is NOT treated as a symbol (we'd rather under-flag than warn on a real word).
function looksLikeSymbol(t: string): boolean {
  if (t.length < 3) return false;
  if (/[_$]/.test(t)) return true; // snake_case / $form
  if (/[a-z][A-Z]/.test(t)) return true; // camelCase or internal-cap PascalCase (webS, hT)
  return false;
}

// Extract the concrete references a plan names: file paths and code identifiers, taken ONLY from
// inline backtick spans (the reliable "this is code" signal). Triple-backtick code blocks are
// stripped first — they're example snippets full of incidental identifiers that would be noise.
// Pure and order-stable; deduped and capped. The fuzziness is intentional and one-directional:
// missing a reference is fine (no false warning), inventing one is not.
export function extractPlanReferences(planText: string): PlanReferences {
  const withoutFences = planText.replace(/```[\s\S]*?```/g, ' ');
  const symbols: string[] = [];
  const paths: string[] = [];
  const seenSym = new Set<string>();
  const seenPath = new Set<string>();
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    if (PATH_LIKE.test(span)) {
      if (!seenPath.has(span)) {
        seenPath.add(span);
        paths.push(span);
      }
      continue;
    }
    // Tokenize the span into identifiers (handles `obj.method()`, `foo(bar)` → foo, bar, etc.) and
    // keep the code-y ones. A plain prose span yields no symbols.
    for (const id of span.match(IDENT) ?? []) {
      if (looksLikeSymbol(id) && !seenSym.has(id)) {
        seenSym.add(id);
        symbols.push(id);
      }
    }
  }
  return { symbols: symbols.slice(0, MAX_REFS), paths: paths.slice(0, MAX_REFS) };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Verify which references actually exist in the codebase. Paths are checked by stat; symbols by a
// single bounded tree walk that short-circuits as soon as every symbol is found (so the common
// "everything exists" case is cheap). Returns the references NOT found. If the byte cap is hit with
// symbols still unconfirmed, they're treated as verified (dropped from missing) — under-flag, never
// over-flag.
export async function verifyPlanReferences(
  cwd: string,
  ignore: Ignore | undefined,
  refs: PlanReferences,
): Promise<{ missingSymbols: string[]; missingPaths: string[] }> {
  const missingPaths: string[] = [];
  for (const p of refs.paths) {
    const ok = await stat(resolve(cwd, p)).then(
      () => true,
      () => false,
    );
    if (!ok) missingPaths.push(p);
  }

  const remaining = new Map(refs.symbols.map(s => [s, new RegExp(`\\b${escapeRegExp(s)}\\b`)]));
  const budget = { bytes: 0 };
  if (remaining.size > 0) await scan(cwd, cwd, ignore, remaining, budget);
  // Anything still unmatched is missing — UNLESS we ran out of scan budget, in which case we can't
  // be sure, so don't flag. (budget.bytes < 0 is the sentinel for "cap hit".)
  const missingSymbols = budget.bytes < 0 ? [] : [...remaining.keys()];
  return { missingSymbols, missingPaths };
}

async function scan(
  dir: string,
  cwd: string,
  ig: Ignore | undefined,
  remaining: Map<string, RegExp>,
  budget: { bytes: number },
): Promise<void> {
  if (remaining.size === 0 || budget.bytes < 0) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  for (const entry of entries) {
    if (remaining.size === 0 || budget.bytes < 0) return;
    const full = join(dir, entry.name);
    const rel = relative(cwd, full);
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      if (ig && rel.length > 0 && ig.ignores(rel + '/')) continue;
      await scan(full, cwd, ig, remaining, budget);
    } else if (entry.isFile()) {
      if (ig && ig.ignores(rel)) continue;
      const st = await stat(full).catch(() => null);
      if (!st || st.size > MAX_FILE_BYTES) continue;
      budget.bytes += st.size;
      if (budget.bytes > MAX_SCAN_BYTES) {
        budget.bytes = -1; // cap hit — stop and mark unverified
        return;
      }
      const text = await readFile(full, 'utf8').catch(() => null);
      if (text === null || text.includes('\x00')) continue;
      for (const [sym, re] of remaining) if (re.test(text)) remaining.delete(sym);
    }
  }
}

// Build the advisory appended to a plan when references don't resolve. Returns '' when everything
// checks out (the common case), so the caller appends nothing. Framed as "verify, may be new" — a
// plan legitimately introduces new symbols, so this can never be a hard error, only a heads-up.
export function buildGroundingNote(missing: { missingSymbols: string[]; missingPaths: string[] }): string {
  const items = [...missing.missingPaths, ...missing.missingSymbols];
  if (items.length === 0) return '';
  // Backtick each item so markdown rendering in the TUI leaves it literal — an unbackticked
  // `__tests__` path otherwise renders as bold "tests", showing the user a mangled name.
  const list = items.map(s => `\`${s}\``).join(', ');
  return (
    '\n\n--- reika: plan grounding check (auto-generated) ---\n' +
    `These names in the plan were not found in the codebase: ${list}. ` +
    'They may be intended as NEW code, or renamed/misremembered. Before editing, confirm the real ' +
    'names against the actual files — do not loop searching for them if they are not there.'
  );
}
