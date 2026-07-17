import chalk from 'chalk';
import { highlight, plain, supportsLanguage, type Theme } from 'cli-highlight';

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

export const codeTheme: Theme = {
  keyword: chalk.hex(ORCHID),
  built_in: chalk.hex(TEAL),
  type: chalk.hex(YELLOW),
  literal: chalk.hex(APRICOT), // true/false/null
  number: chalk.hex(APRICOT),
  string: chalk.hex(GREEN),
  regexp: chalk.hex(TEAL),
  // `${...}` regions inside template strings. Nested tokens keep their own
  // colors; the delimiters and unclassified identifiers inside read as
  // variables instead of dropping to plain white mid-string.
  subst: chalk.hex(ROSE),
  symbol: chalk.hex(APRICOT),
  class: chalk.hex(YELLOW),
  // `function` is a container scope wrapping the whole signature (params,
  // return type). Painting it leaks onto unclassified tokens inside — custom
  // type names like `Promise<Round | null>` would render periwinkle. Leave it
  // plain; the function *name* is the nested `title` scope.
  function: plain,
  title: chalk.hex(PERIWINKLE),
  params: plain,
  comment: chalk.hex(GRAY).italic,
  doctag: chalk.hex(GRAY),
  meta: chalk.hex(GRAY), // annotations, preprocessor, shebang
  'meta-keyword': chalk.hex(ORCHID),
  'meta-string': chalk.hex(GREEN),
  section: chalk.hex(PERIWINKLE),
  tag: chalk.hex(ROSE), // html/xml angle brackets
  name: chalk.hex(ROSE), // html/xml tag names
  'builtin-name': chalk.hex(TEAL),
  attr: chalk.hex(APRICOT), // object keys, html attributes
  attribute: chalk.hex(GREEN),
  variable: chalk.hex(ROSE),
  bullet: chalk.hex(APRICOT),
  code: chalk.hex(GREEN), // ```markdown fences: indented/inline code
  formula: chalk.hex(TEAL),
  emphasis: chalk.italic,
  strong: chalk.bold,
  link: chalk.hex(PERIWINKLE).underline,
  quote: chalk.hex(GRAY),
  'selector-tag': chalk.hex(ROSE),
  'selector-id': chalk.hex(PERIWINKLE),
  'selector-class': chalk.hex(APRICOT),
  'selector-attr': chalk.hex(APRICOT),
  'selector-pseudo': chalk.hex(TEAL),
  'template-tag': chalk.hex(GRAY),
  'template-variable': chalk.hex(ROSE),
  addition: chalk.hex(GREEN),
  deletion: chalk.hex(ROSE),
  default: plain,
};

// highlight.js console.error()s a "Could not find the language" warning *before*
// throwing on an unregistered language, and Ink folds console output into the
// rendered frame — so an unknown language must never reach the highlighter.
// Unsupported names (```astro, ```svelte) become plaintext; empty stays empty so
// cli-highlight's auto-detection keeps handling unlabeled fences as before.
// supportsLanguage is alias-aware via hljs.getLanguage under the hood.
export function resolveLanguage(language: string | undefined): string {
  if (!language) return '';
  return supportsLanguage(language) ? language : 'plaintext';
}

// Single entry point for syntax highlighting across the UI (diffs, approvals,
// markdown code fences). Returns the input unchanged on empty/illegal input so
// callers never have to guard.
export function highlightCode(code: string, language: string): string {
  if (!code.trim()) return code;
  try {
    return highlight(code, {
      language: resolveLanguage(language),
      ignoreIllegals: true,
      theme: codeTheme,
    });
  } catch {
    return code;
  }
}
