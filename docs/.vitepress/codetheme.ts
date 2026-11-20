import { palette } from '../../src/display/palette';

// The site's code blocks in Reika's own syntax tones, so code on the page reads as it does in the
// TUI (src/ui/highlight.ts) and the web UI (src/web/client/markdown.css). Six tones are palette
// slots; rose and gray are the web UI's own (app.css `--reika-syntax-*`, gray lifted from the TUI's
// for a browser background), and codetheme.test.ts holds them to that file.
//
// highlight.js scopes there, TextMate scopes here, so the mapping is by meaning: each rule below
// names the highlight.js scope it stands in for. Plain identifiers stay in the text color, as
// highlight.js leaves them unclassified.
export const syntaxTones = {
  orchid: palette.accent, // keyword
  teal: palette.modePlan, // built_in, regexp, escapes
  yellow: palette.warning, // type, title.class
  apricot: palette.subagent, // literal, number, attr
  green: palette.modeShell, // string, attribute
  periwinkle: palette.modeVibe, // title (functions), section, link
  rose: '#db9499', // variable, tag, name, subst
  gray: '#8b909a', // comment, meta
} as const;

const TEXT = '#e9e4ec';
const BACKGROUND = '#121014';

type Rule = { scope: string[]; settings: { foreground?: string; fontStyle?: string } };
const t = syntaxTones;

const rules: Rule[] = [
  // keyword; variable.language (this, self)
  {
    scope: [
      'keyword',
      'storage.type',
      'storage.modifier',
      'keyword.operator.new',
      'keyword.operator.expression',
      'variable.language',
    ],
    settings: { foreground: t.orchid },
  },
  // Operators highlight.js leaves alone. Punctuation is not listed: it takes its surroundings' tone,
  // so a string's quotes, a heading's `##` and a code span's backticks match their text.
  { scope: ['keyword.operator'], settings: { foreground: TEXT } },
  // A shell command's bare arguments, which the shell grammar marks as strings and highlight.js
  // leaves plain.
  { scope: ['string.unquoted.argument.shell'], settings: { foreground: TEXT } },
  // built_in, regexp, char.escape
  {
    scope: [
      'support.function',
      'support.class',
      'support.variable',
      'support.constant',
      'string.regexp',
      'constant.character.escape',
    ],
    settings: { foreground: t.teal },
  },
  // type, title.class
  {
    scope: [
      'entity.name.type',
      'entity.name.class',
      'entity.other.inherited-class',
      'support.type',
      'storage.type.primitive',
    ],
    settings: { foreground: t.yellow },
  },
  // literal, number, symbol, variable.constant, bullet, attr (object keys, html attributes)
  {
    scope: [
      'constant.numeric',
      'constant.language',
      'constant.other',
      'variable.other.constant',
      'punctuation.definition.list.begin.markdown',
      'entity.other.attribute-name',
      'meta.object-literal.key',
      'support.type.property-name',
      'entity.name.tag.yaml',
      'keyword.other.definition.ini',
    ],
    settings: { foreground: t.apricot },
  },
  // string, code, addition
  {
    scope: ['string', 'markup.inline.raw', 'markup.fenced_code', 'markup.inserted'],
    settings: { foreground: t.green },
  },
  // title (function definitions and calls), section, link; a shell command reads as a call
  {
    scope: [
      'entity.name.function',
      'entity.name.command',
      'markup.heading',
      'entity.name.section',
      'markup.underline.link',
    ],
    settings: { foreground: t.periwinkle },
  },
  // variable (shell parameters only: a TextMate grammar marks every identifier a variable, where
  // highlight.js marks none), tag, name, subst, deletion
  {
    scope: [
      'variable.other.normal.shell',
      'variable.other.special.shell',
      'variable.other.positional.shell',
      'variable.other.bracket.shell',
      'punctuation.definition.variable.shell',
      'entity.name.tag',
      'punctuation.definition.tag',
      'punctuation.definition.template-expression',
      'punctuation.section.embedded',
      'markup.deleted',
    ],
    settings: { foreground: t.rose },
  },
  // comment, doctag, meta, quote
  {
    scope: ['comment', 'punctuation.definition.comment', 'markup.quote', 'meta.preprocessor'],
    settings: { foreground: t.gray },
  },
  { scope: ['comment'], settings: { fontStyle: 'italic' } },
  { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
  { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
];

export const reikaCodeTheme = {
  name: 'reika',
  type: 'dark' as const,
  colors: { 'editor.background': BACKGROUND, 'editor.foreground': TEXT },
  tokenColors: rules,
};
