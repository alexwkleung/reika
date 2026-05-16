import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const MAX_FILE_BYTES = 200_000;
const DEFAULT_BUDGET = 3200;

const EXPORT_PATTERNS: RegExp[] = [
  /^export\s+default\s+(?:async\s+)?function\s+(\w+)/gm,
  /^export\s+default\s+class\s+(\w+)/gm,
  /^export\s+(?:async\s+)?function\s+(\w+)/gm,
  /^export\s+(?:const|let|var)\s+(\w+)/gm,
  /^export\s+class\s+(\w+)/gm,
  /^export\s+type\s+(\w+)/gm,
  /^export\s+interface\s+(\w+)/gm,
  /^export\s+enum\s+(\w+)/gm,
];

const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;

type FileEntry = {
  path: string;
  content: string;
  symbols: string[];
};

export async function buildRepoMap(cwd: string, budget: number = DEFAULT_BUDGET): Promise<string> {
  const files: FileEntry[] = [];
  await walk(cwd, cwd, files);

  const symbolToFiles = new Map<string, Set<string>>();
  for (const f of files) {
    for (const s of f.symbols) {
      let set = symbolToFiles.get(s);
      if (!set) {
        set = new Set();
        symbolToFiles.set(s, set);
      }
      set.add(f.path);
    }
  }

  const scores = new Map<string, number>();
  for (const f of files) {
    if (f.symbols.length > 0) scores.set(f.path, 0);
  }

  for (const f of files) {
    let m: RegExpExecArray | null;
    NAMED_IMPORT_RE.lastIndex = 0;
    while ((m = NAMED_IMPORT_RE.exec(f.content)) !== null) {
      const names = m[1].split(',').map(parseImportName).filter(Boolean);
      for (const name of names) {
        const definers = symbolToFiles.get(name);
        if (!definers) continue;
        for (const def of definers) {
          if (def === f.path) continue;
          scores.set(def, (scores.get(def) ?? 0) + 1);
        }
      }
    }
  }

  const ranked = files
    .filter(f => f.symbols.length > 0)
    .sort((a, b) => {
      const sa = scores.get(a.path) ?? 0;
      const sb = scores.get(b.path) ?? 0;
      if (sb !== sa) return sb - sa;
      return a.path.localeCompare(b.path);
    });

  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const f of ranked) {
    const line = `${f.path}: ${f.symbols.join(', ')}`;
    if (used + line.length + 1 > budget) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted > 0) {
    lines.push(`(${omitted} more files omitted)`);
  }
  return lines.join('\n');
}

async function walk(dir: string, root: string, out: FileEntry[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!items) return;
  for (const entry of items) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTS.has(extname(entry.name))) continue;
    const full = join(dir, entry.name);
    const st = await stat(full).catch(() => null);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    const text = await readFile(full, 'utf8').catch(() => null);
    if (text === null) continue;
    out.push({ path: relative(root, full), content: text, symbols: extractSymbols(text) });
  }
}

function extractSymbols(text: string): string[] {
  const seen = new Set<string>();
  for (const re of EXPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) seen.add(m[1]);
    }
  }
  return Array.from(seen);
}

function parseImportName(raw: string): string {
  const trimmed = raw.trim();
  const asMatch = /^(.+?)\s+as\s+/.exec(trimmed);
  return asMatch ? asMatch[1].trim() : trimmed;
}
