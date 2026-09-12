import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Ignore } from 'ignore';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'coverage', 'out']);
// Go test files define only TestXxx/BenchmarkXxx, which pass the exported-name filter below
// and would crowd the map with names nothing references.
const SKIP_FILES = [/_test\.go$/];
const MAX_FILE_BYTES = 200_000;
const DEFAULT_BUDGET = 3200;
// A C header or Java class can carry hundreds of definitions; one such line would eat the whole
// budget and the map would name five files instead of thirty.
const MAX_SYMBOLS_PER_FILE = 24;

type Language = {
  exts: string[];
  // Each pattern's first capture group is the definition name; `gm` so ^ anchors per line.
  patterns: RegExp[];
  // Language-level "is this part of the file's surface" rule (Python's _private, Go's
  // lowercase). TS/JS get the same effect from matching only `export` lines.
  keep?: (name: string) => boolean;
};

// Line-anchored definition shapes only. Regex can't see nesting, so the rule per language is:
// capture what a reader skimming the file would call its API — top-level definitions, plus
// members only where the language marks them (`pub fn`, `public …(`, `fun`, `func`).
// Everything else (locals, calls, control flow) stays out by construction: a call site is
// indented and has no type/keyword before the name.
const LANGUAGES: Language[] = [
  {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    patterns: [
      /^export\s+default\s+(?:async\s+)?function\s+(\w+)/gm,
      /^export\s+default\s+class\s+(\w+)/gm,
      /^export\s+(?:async\s+)?function\s+(\w+)/gm,
      /^export\s+(?:const|let|var)\s+(?!enum\b)(\w+)/gm,
      /^export\s+(?:abstract\s+)?class\s+(\w+)/gm,
      /^export\s+type\s+(\w+)/gm,
      /^export\s+interface\s+(\w+)/gm,
      /^export\s+(?:const\s+)?enum\s+(\w+)/gm,
      /^exports\.(\w+)\s*=/gm,
    ],
  },
  {
    exts: ['.py', '.pyi'],
    patterns: [/^(?:async\s+)?def\s+(\w+)/gm, /^class\s+(\w+)/gm],
    keep: name => !name.startsWith('_'),
  },
  {
    exts: ['.go'],
    patterns: [
      /^func\s+(?:\([^)]*\)\s*)?(\w+)/gm,
      /^type\s+(\w+)/gm,
      /^\t(\w+)\s+(?:struct|interface)\s*\{/gm,
      /^(?:var|const)\s+(\w+)/gm,
    ],
    keep: name => /^[A-Z]/.test(name),
  },
  {
    exts: ['.rs'],
    patterns: [
      /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern\s+"C")\s+)*(?:fn|struct|enum|trait|type|const|static|union)\s+(\w+)/gm,
      /^\s+pub(?:\([^)]*\))?\s+(?:(?:async|unsafe|const)\s+)*fn\s+(\w+)/gm,
      /^macro_rules!\s+(\w+)/gm,
    ],
  },
  {
    exts: ['.java', '.cs'],
    patterns: [
      /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|non-sealed|partial|readonly|strictfp)\s+)*(?:class|interface|enum|record|struct|@interface)\s+(\w+)/gm,
      /^\s+(?:public|protected)\s+(?:(?:static|final|abstract|synchronized|default|native|virtual|override|async|sealed)\s+)*(?:<[^>]+>\s+)?(?:[\w.<>[\],?\s]+?\s+)?(\w+)\s*\(/gm,
    ],
  },
  {
    exts: ['.kt', '.kts'],
    patterns: [
      /^\s*(?:(?:public|private|internal|protected|open|abstract|final|data|sealed|inner|enum|annotation|value|inline)\s+)*(?:class|interface|object)\s+(\w+)/gm,
      /^\s*(?:(?:public|private|internal|protected|open|override|suspend|inline|operator|infix|tailrec|external|actual|expect)\s+)*fun\s+(?:<[^>]*>\s+)?(?:[\w.<>?]+\.)?(\w+)\s*\(/gm,
      /^typealias\s+(\w+)/gm,
    ],
  },
  {
    exts: ['.swift'],
    patterns: [
      /^\s*(?:(?:public|private|internal|fileprivate|open|final|static|class|override|mutating|convenience|required|@\w+)\s+)*(?:func|class|struct|enum|protocol|extension|actor|typealias)\s+(\w+)/gm,
    ],
  },
  {
    exts: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx', '.m', '.mm'],
    patterns: [
      // Column 0 + a type before the name: a definition or prototype, never a call or macro use.
      // `(?!\s*[*(])` keeps `void (*cb)(int)` and `__attribute__((…))` from reading as names.
      /^[A-Za-z_][\w:<>*&\s,]*?[\s*&](?:\w+::)*(~?\w+)\s*\((?!\s*[*(])/gm,
      /^(?:typedef\s+)?(?:struct|class|enum(?:\s+class)?|union)\s+(\w+)\s*(?:\{|:|$)/gm,
      /^typedef\s+.*?\b(\w+);/gm,
      /^\}\s*(\w+);/gm,
    ],
    keep: name => !C_KEYWORDS.has(name),
  },
  {
    exts: ['.rb'],
    patterns: [/^\s*def\s+(?:self\.)?(\w+[?!=]?)/gm, /^\s*(?:class|module)\s+(\w+)/gm],
  },
  {
    exts: ['.php'],
    patterns: [
      /^\s*(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?(\w+)/gm,
      /^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/gm,
    ],
  },
  {
    exts: ['.lua'],
    patterns: [
      /^(?:local\s+)?function\s+(?:[\w.]+[.:])?(\w+)/gm,
      /^(?:local\s+)?(?:[\w.]+\.)?(\w+)\s*=\s*function\b/gm,
    ],
  },
  {
    exts: ['.sh', '.bash', '.zsh'],
    patterns: [/^(?:function\s+)?([\w-]+)\s*\(\)\s*\{?/gm, /^function\s+([\w-]+)/gm],
  },
];

const C_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'switch',
  'return',
  'sizeof',
  'alignof',
  'decltype',
  'noexcept',
  'static_assert',
  'catch',
  'new',
  'delete',
  'defined',
]);

const LANGUAGE_BY_EXT = new Map<string, Language>();
for (const lang of LANGUAGES) for (const ext of lang.exts) LANGUAGE_BY_EXT.set(ext, lang);

const IDENTIFIER_RE = /[A-Za-z_]\w*/g;

type FileEntry = {
  path: string;
  symbols: string[];
  identifiers: Set<string>;
};

export async function buildRepoMap(
  cwd: string,
  ig: Ignore,
  budget: number = DEFAULT_BUDGET,
): Promise<string> {
  const files: FileEntry[] = [];
  await walk(cwd, cwd, ig, files);

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

  // Rank by how many other files mention a file's symbols as whole words. Language-agnostic
  // where import parsing isn't: `pkg.Name`, `from m import name`, `use crate::name` and a bare
  // call all leave the identifier in the referencing file. Credit is df * log(N/df): a name
  // mentioned everywhere (`string`, `name`, `get`) carries no information about which file
  // matters, one mentioned nowhere else carries none either, and the peak is a name a good
  // share of the repo reaches for. Split across definers so a `new` in five files can't lift all
  // five above a file whose names are distinctive.
  const scores = new Map<string, number>();
  for (const f of files) {
    if (f.symbols.length > 0) scores.set(f.path, 0);
  }
  const mentioners = new Map<string, number>();
  for (const f of files) {
    for (const id of f.identifiers) {
      const definers = symbolToFiles.get(id);
      if (!definers || definers.has(f.path)) continue;
      mentioners.set(id, (mentioners.get(id) ?? 0) + 1);
    }
  }
  for (const [name, df] of mentioners) {
    const definers = symbolToFiles.get(name)!;
    const credit = (df * Math.log(files.length / df)) / definers.size;
    for (const def of definers) scores.set(def, (scores.get(def) ?? 0) + credit);
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
    const shown = f.symbols.slice(0, MAX_SYMBOLS_PER_FILE);
    const more = f.symbols.length - shown.length;
    const line = `${f.path}: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
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

async function walk(dir: string, root: string, ig: Ignore, out: FileEntry[]): Promise<void> {
  const items = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!items) return;
  for (const entry of items) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const subRel = relative(root, join(dir, entry.name));
      if (subRel.length > 0 && ig.ignores(subRel + '/')) continue;
      await walk(join(dir, entry.name), root, ig, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (!LANGUAGE_BY_EXT.has(ext)) continue;
    if (SKIP_FILES.some(re => re.test(entry.name))) continue;
    const full = join(dir, entry.name);
    const relPath = relative(root, full);
    if (ig.ignores(relPath)) continue;
    const st = await stat(full).catch(() => null);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    const text = await readFile(full, 'utf8').catch(() => null);
    if (text === null) continue;
    out.push({
      path: relPath,
      symbols: extractSymbols(text, ext),
      identifiers: new Set(text.match(IDENTIFIER_RE) ?? []),
    });
  }
}

export function extractSymbols(text: string, ext: string): string[] {
  const lang = LANGUAGE_BY_EXT.get(ext);
  if (!lang) return [];
  const seen = new Set<string>();
  for (const re of lang.patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (name && (!lang.keep || lang.keep(name))) seen.add(name);
    }
  }
  return Array.from(seen);
}
