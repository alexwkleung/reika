import chalk from 'chalk';
import { highlight, plain, supportsLanguage, type Theme } from 'cli-highlight';

// A clean, dark-background syntax theme. cli-highlight's DEFAULT_THEME leans on
// raw ANSI red/blue/green (strings AND regexps in pure red, keywords in pure
// blue), which reads as noisy. These tones follow the well-loved One Dark
// palette — saturated enough to stay legible over the diff's red/green line
// backgrounds and to survive 256-color terminals, but harmonious like the
// themes in Claude/opencode.
const PURPLE = '#c678dd'; // keywords, control flow
const BLUE = '#61afef'; // functions, built-ins
const CYAN = '#56b6c2'; // regexp, symbols, escapes
const GREEN = '#98c379'; // strings
const ORANGE = '#d19a66'; // numbers, literals, constants
const YELLOW = '#e5c07b'; // types, class names
const RED = '#e06c75'; // variables, tag names
const GRAY = '#7f848e'; // comments, meta

export const codeTheme: Theme = {
  keyword: chalk.hex(PURPLE),
  built_in: chalk.hex(CYAN),
  type: chalk.hex(YELLOW),
  literal: chalk.hex(ORANGE), // true/false/null
  number: chalk.hex(ORANGE),
  string: chalk.hex(GREEN),
  regexp: chalk.hex(CYAN),
  subst: plain,
  symbol: chalk.hex(ORANGE),
  class: chalk.hex(YELLOW),
  function: chalk.hex(BLUE),
  title: chalk.hex(BLUE),
  params: plain,
  comment: chalk.hex(GRAY).italic,
  doctag: chalk.hex(GRAY),
  meta: chalk.hex(GRAY), // annotations, preprocessor, shebang
  'meta-keyword': chalk.hex(PURPLE),
  'meta-string': chalk.hex(GREEN),
  section: chalk.hex(BLUE),
  tag: chalk.hex(RED), // html/xml angle brackets
  name: chalk.hex(RED), // html/xml tag names
  'builtin-name': chalk.hex(CYAN),
  attr: chalk.hex(ORANGE), // object keys, html attributes
  attribute: chalk.hex(GREEN),
  variable: chalk.hex(RED),
  bullet: chalk.hex(ORANGE),
  emphasis: chalk.italic,
  strong: chalk.bold,
  link: chalk.hex(BLUE).underline,
  quote: chalk.hex(GRAY),
  'selector-tag': chalk.hex(RED),
  'selector-id': chalk.hex(BLUE),
  'selector-class': chalk.hex(ORANGE),
  'selector-attr': chalk.hex(ORANGE),
  'selector-pseudo': chalk.hex(CYAN),
  'template-tag': chalk.hex(GRAY),
  'template-variable': chalk.hex(RED),
  addition: chalk.hex(GREEN),
  deletion: chalk.hex(RED),
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
