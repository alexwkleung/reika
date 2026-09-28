import chalk, { type ForegroundColorName } from 'chalk';
import hljs from 'highlight.js';

type Paint = (text: string) => string;

// A clean, dark-background syntax theme in reika's own pastel family (#93).
// The previous values were lifted straight from One Dark, which read as "Atom
// theme" rather than reika. These tones sit at the same soft saturation/
// lightness band as theme.ts (orchid accent, plan teal, vibe periwinkle, shell
// green, warning yellow), so code blocks feel continuous with the rest of the
// UI — still saturated enough to stay legible over the diff's red/green line
// backgrounds and to survive 256-color terminals.
const ORCHID = '#d68cd6'; // keywords, control flow — echoes theme.accent
const PERIWINKLE = '#b4aee0'; // functions, sections — echoes theme.modeVibe
const TEAL = '#8fd0c8'; // built-ins, regexp, escapes — echoes theme.modePlan
const GREEN = '#9fd49f'; // strings — echoes theme.modeShell
const APRICOT = '#e0b48f'; // numbers, literals, constants
const YELLOW = '#e5d49a'; // types, class names — echoes theme.warning
const ROSE = '#db9499'; // variables, tag names
const GRAY = '#7f848e'; // comments, meta

// On a 16-color terminal every tone above but GRAY downsamples to white, which is no highlighting
// at all; each gets the named color nearest its role instead.
const ANSI16: Record<string, ForegroundColorName> = {
  [ORCHID]: 'magentaBright',
  [PERIWINKLE]: 'blueBright',
  [TEAL]: 'cyan',
  [GREEN]: 'green',
  [APRICOT]: 'yellow',
  [YELLOW]: 'yellowBright',
  [ROSE]: 'redBright',
  [GRAY]: 'gray',
};
const tone = (hex: string) => (chalk.level === 1 ? chalk[ANSI16[hex]] : chalk.hex(hex));

// Keyed by highlight.js 11 scope, dotted for sub-scopes (`title.function`). A scope with no entry
// falls back to its parent (`title.class.inherited` → `title.class` → `title`), and one with none
// at all is left unstyled, so its nested spans keep their own colors. Rebuilt when chalk.level
// changes: it is decided after import in tests.
let cachedTheme: { level: number; theme: Record<string, Paint> } | null = null;
function codeTheme(): Record<string, Paint> {
  if (cachedTheme?.level !== chalk.level) {
    cachedTheme = { level: chalk.level, theme: buildCodeTheme() };
  }
  return cachedTheme.theme;
}

function buildCodeTheme(): Record<string, Paint> {
  return {
    keyword: tone(ORCHID),
    built_in: tone(TEAL),
    type: tone(YELLOW),
    literal: tone(APRICOT), // true/false/null
    number: tone(APRICOT),
    string: tone(GREEN),
    regexp: tone(TEAL),
    // `${...}` regions inside template strings. Nested tokens keep their own
    // colors; the delimiters and unclassified identifiers inside read as
    // variables instead of dropping to plain white mid-string.
    subst: tone(ROSE),
    symbol: tone(APRICOT),
    'char.escape': tone(TEAL),
    title: tone(PERIWINKLE),
    'title.class': tone(YELLOW),
    // Call sites, which highlight.js 10 never classified: same color as the definition.
    'title.function.invoke': tone(PERIWINKLE),
    comment: tone(GRAY).italic,
    doctag: tone(GRAY),
    // Annotations, preprocessor, shebang. Its keyword and string are nested spans in 11.
    meta: tone(GRAY),
    section: tone(PERIWINKLE),
    tag: tone(ROSE), // html/xml angle brackets
    name: tone(ROSE), // html/xml tag names
    attr: tone(APRICOT), // object keys, html attributes
    attribute: tone(GREEN),
    variable: tone(ROSE),
    'variable.language': tone(ORCHID), // this, self
    'variable.constant': tone(APRICOT),
    bullet: tone(APRICOT),
    code: tone(GREEN), // ```markdown fences: indented/inline code
    formula: tone(TEAL),
    emphasis: chalk.italic,
    strong: chalk.bold,
    link: tone(PERIWINKLE).underline,
    quote: tone(GRAY),
    'selector-tag': tone(ROSE),
    'selector-id': tone(PERIWINKLE),
    'selector-class': tone(APRICOT),
    'selector-attr': tone(APRICOT),
    'selector-pseudo': tone(TEAL),
    'template-tag': tone(GRAY),
    'template-variable': tone(ROSE),
    addition: tone(GREEN),
    deletion: tone(ROSE),
  };
}

// `hljs-title function_ invoke__` → `title.function.invoke`: highlight.js writes the first scope
// part prefixed and each further part with one more trailing underscore than the last.
function scopeOf(classAttr: string): string {
  return classAttr
    .split(' ')
    .map(part => part.replace(/^hljs-/, '').replace(/_+$/, ''))
    .join('.');
}

function paintFor(scope: string, theme: Record<string, Paint>): Paint | undefined {
  for (let s = scope; s; s = s.slice(0, Math.max(0, s.lastIndexOf('.')))) {
    if (theme[s]) return theme[s];
  }
  return undefined;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
};

// highlight.js escapes every text run and emits nothing but `<span class="…">` and `</span>`
// around them, so its HTML is regular enough to walk with one regex — no HTML parser. Each span
// paints its already-painted children, so an outer color resumes after a nested one closes.
function htmlToAnsi(html: string): string {
  const theme = codeTheme();
  const stack: { paint?: Paint; out: string }[] = [{ out: '' }];
  const token = /<span class="([^"]*)">|<\/span>|[^<]+/g;
  for (const [piece, classAttr] of html.matchAll(token)) {
    if (classAttr !== undefined) {
      stack.push({ paint: paintFor(scopeOf(classAttr), theme), out: '' });
    } else if (piece === '</span>') {
      const span = stack.pop()!;
      stack[stack.length - 1].out += span.paint ? span.paint(span.out) : span.out;
    } else {
      stack[stack.length - 1].out += piece.replace(/&(?:amp|lt|gt|quot|#x27);/g, e => ENTITIES[e]);
    }
  }
  return stack[0].out;
}

// highlight.js console.error()s a "Could not find the language" warning *before*
// throwing on an unregistered language, and Ink folds console output into the
// rendered frame — so an unknown language must never reach the highlighter.
// Unsupported names (```astro, ```svelte) become plaintext; getLanguage is alias-aware.
// So does no name at all, rather than auto-detection: that runs every grammar on each
// render of a streaming block, and guesses wrong on the short snippets an unlabeled
// fence usually holds (logs, trees, command output — `SELECT * FROM t;` came back CSS).
export function resolveLanguage(language: string | undefined): string {
  return language && hljs.getLanguage(language) ? language : 'plaintext';
}

// Single entry point for syntax highlighting across the UI (diffs, approvals,
// markdown code fences). Returns the input unchanged on empty/illegal input so
// callers never have to guard.
export function highlightCode(code: string, language: string): string {
  const lang = resolveLanguage(language);
  if (!code.trim() || chalk.level === 0 || lang === 'plaintext') return code;
  try {
    return htmlToAnsi(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return code;
  }
}
