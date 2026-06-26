import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ToolContext } from '../types.js';

// Deps are a blackbox to the model in a way local files aren't: grep/glob/list all skip
// node_modules (see _walk.ts), so the model can't *discover* a dependency's real API and
// falls back on stale/assumed knowledge — the "assumed the shape" hallucination. This
// surfaces the *installed* type surface of any dependency a write/edit imports, so the
// model grounds on the real signatures instead of guessing. Local imports are deliberately
// excluded: they're discoverable, mutable mid-turn, and covered by typecheck.

// Cap packages surfaced per call so a file importing a dozen deps doesn't dump a dozen
// surfaces on one edit — bounded bloat for small-context models.
const MAX_PACKAGES = 3;
// Cap a single package's surface. Long .d.ts files collapse to their `export` lines (names
// + signature heads); the model can `read` the file in full when it needs the bodies.
const MAX_SURFACE_LINES = 60;
// When the types entry is a barrel (just re-exports from sibling files), follow at most this
// many of those re-exports one hop to reach the real declarations. One hop only — no
// recursion, so no cycle risk and deep barrels (zod, rxjs) stop at the first layer, which is
// fine: those are popular libs the model already knows. The shared MAX_SURFACE_LINES budget
// still bounds the total, so a barrel package surfaces no more than a flat one.
const MAX_FOLLOW = 3;

// Bare import specifiers from JS/TS: `import/export … from 'x'`, side-effect `import 'x'`,
// `require('x')`, and dynamic `import('x')`. Relative ('./x') and absolute ('/x') specifiers
// are dropped — those are local files the model can already read. Builtins fall out for free
// because they have no node_modules/<name> directory to resolve against.
const SPEC_RE =
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function extractPackageNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || spec.startsWith('.') || isAbsolute(spec) || spec.startsWith('node:')) continue;
    const name = toPackageName(spec);
    if (name) names.add(name);
  }
  return [...names];
}

// 'zod/v4' -> 'zod', '@scope/pkg/sub' -> '@scope/pkg'. The package directory is what types
// resolve against; subpath exports still live under it.
function toPackageName(spec: string): string | null {
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

type Pkg = { name: string; relPath: string; surface: string };

async function resolvePackageSurface(cwd: string, name: string): Promise<Pkg | null> {
  const dir = join(cwd, 'node_modules', name);
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null; // not installed here (builtin, absent devDep, hoisted) — skip silently
  }
  const typesRel = pickTypesEntry(pkg);
  if (!typesRel) return null; // ships no types — nothing to ground on
  let text: string;
  try {
    text = await readFile(join(dir, typesRel), 'utf8');
  } catch {
    return null;
  }
  const cleanRel = typesRel.replace(/^\.\//, '');
  return {
    name,
    relPath: `node_modules/${name}/${cleanRel}`,
    surface: await buildSurface(dir, text),
  };
}

// Lines that look like exported declarations — the "shape" signal.
function exportLines(text: string): string[] {
  return text.split('\n').filter(l => /^\s*export\b/.test(l));
}

// Relative re-export targets in a barrel: `export * from './x'`, `export * as ns from './x'`,
// `export { a, b } from './x'`. Only relative specifiers — a barrel re-exporting another
// package is out of scope.
const REEXPORT_RE = /export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*['"](\.[^'"]+)['"]/g;

function reexportTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REEXPORT_RE)) out.push(m[1]);
  return out;
}

// Map a re-export specifier to a declaration file and read it. .d.ts re-exports cite runtime
// extensions ('./x.js', './x.cjs'), so map those to their declaration counterparts; an
// extensionless specifier tries the usual declaration shapes including a directory index.
async function readRelativeDts(dir: string, rel: string): Promise<string | null> {
  const base = join(dir, rel);
  const mapped = base
    .replace(/\.js$/, '.d.ts')
    .replace(/\.cjs$/, '.d.cts')
    .replace(/\.mjs$/, '.d.mts');
  const candidates =
    mapped !== base
      ? [mapped]
      : [`${base}.d.ts`, `${base}.d.cts`, `${base}.d.mts`, join(base, 'index.d.ts')];
  for (const c of candidates) {
    const text = await readFile(c, 'utf8').catch(() => null);
    if (text != null) return text;
  }
  return null;
}

// Build a package's surface from its types entry. A flat entry condenses as-is. A barrel
// entry keeps its own real declarations (mixed files have some) and follows its relative
// re-exports one hop to reach the actual signatures, all within the shared line budget.
async function buildSurface(dir: string, entryText: string): Promise<string> {
  const targets = reexportTargets(entryText);
  if (targets.length === 0) return condense(entryText);

  // Drop the entry's own re-export lines (we're about to follow them); keep any real decls.
  const out = exportLines(entryText).filter(l => !/\bfrom\b/.test(l));
  let truncated = false;
  for (const rel of targets.slice(0, MAX_FOLLOW)) {
    if (out.length >= MAX_SURFACE_LINES) {
      truncated = true;
      break;
    }
    const text = await readRelativeDts(dir, rel);
    if (text == null) continue;
    const lines = exportLines(text);
    const room = MAX_SURFACE_LINES - out.length;
    if (lines.length > room) truncated = true;
    out.push(`// from ${rel}`, ...lines.slice(0, room));
  }
  if (truncated || targets.length > MAX_FOLLOW)
    out.push('// … (truncated; read the file for more)');
  // If following surfaced nothing useful, fall back to the raw entry.
  return out.length > 0 ? out.join('\n') : condense(entryText);
}

function pickTypesEntry(pkg: Record<string, unknown>): string | null {
  if (typeof pkg.types === 'string') return pkg.types;
  if (typeof pkg.typings === 'string') return pkg.typings;
  return typesFromExports(pkg.exports);
}

// `exports` can be a string, a conditions object, or a subpath map. We only want the root
// entry's types condition; descend through the common conditions to find a `types` string.
function typesFromExports(exp: unknown): string | null {
  if (!exp || typeof exp !== 'object') return null;
  const root = (exp as Record<string, unknown>)['.'] ?? exp;
  return findTypes(root);
}

function findTypes(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.types === 'string') return obj.types;
  for (const key of ['import', 'require', 'default', 'node']) {
    const sub = findTypes(obj[key]);
    if (sub) return sub;
  }
  return null;
}

// Short files pass through verbatim. Long ones reduce to their `export` lines — the names
// and signature heads, which is exactly the "what's the shape" signal — capped, with a
// pointer back to the file for the rest. Files with no `export` lines (e.g. `declare
// module`) fall back to a head slice.
function condense(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_SURFACE_LINES) return text.trimEnd();
  const exports = exportLines(text);
  if (exports.length === 0) {
    return lines.slice(0, MAX_SURFACE_LINES).join('\n').trimEnd() + '\n// … truncated';
  }
  const kept = exports.slice(0, MAX_SURFACE_LINES);
  const more = exports.length - kept.length;
  return kept.join('\n').trimEnd() + (more > 0 ? `\n// … +${more} more export lines` : '');
}

// Resolve the type surface for any dependency imported in `newText` that hasn't been
// surfaced yet this turn, returning a payload block for the tool result (or undefined when
// there's nothing new to ground). Marks every candidate seen — resolved or not — so a dep
// with no local types isn't re-probed on every subsequent edit.
export async function surfaceImportedDeps(
  ctx: ToolContext,
  newText: string,
): Promise<string | undefined> {
  const seen = ctx.resolvedDeps;
  const candidates = extractPackageNames(newText).filter(n => !seen?.has(n));
  if (candidates.length === 0) return undefined;

  const resolved: Pkg[] = [];
  for (const name of candidates) {
    if (resolved.length >= MAX_PACKAGES) break;
    const pkg = await resolvePackageSurface(ctx.cwd, name);
    seen?.add(name);
    if (pkg) resolved.push(pkg);
  }
  if (resolved.length === 0) return undefined;

  const blocks = resolved.map(
    p => `### ${p.name} — installed type surface (${p.relPath})\n\`\`\`ts\n${p.surface}\n\`\`\``,
  );
  return (
    'Grounding — actual API of the dependencies imported in this change, read from ' +
    'node_modules. Use these real signatures instead of assuming; `read` the listed file ' +
    'for full detail.\n\n' +
    blocks.join('\n\n')
  );
}
