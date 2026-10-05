import chalk from 'chalk';
import hljs from 'highlight.js/lib/common';
import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { highlightCode, ScopeEmitter, type ScopeNode } from './highlight.js';
import { renderMarkdown } from './markdown.js';

// Colors are off under vitest (non-TTY), and highlighting is skipped entirely there.
const savedLevel = chalk.level;
beforeEach(() => {
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = savedLevel;
});

// Built per use: chalk resolves a hex color to escape codes for the level it was created at.
const KEYWORD = (s: string) => chalk.hex('#d68cd6')(s);
const CLASS = (s: string) => chalk.hex('#e5d49a')(s);
const TITLE = (s: string) => chalk.hex('#b4aee0')(s);
const STRING = (s: string) => chalk.hex('#9fd49f')(s);

describe('highlightCode', () => {
  it('returns the source text unchanged under the colors', () => {
    const code = 'const a = `x${b}` < 3 && "q" !== \'r\'; // <tag> & done';
    expect(stripAnsi(highlightCode(code, 'ts'))).toBe(code);
  });

  it('colors a scope by its most specific entry', () => {
    expect(highlightCode('f(x)', 'js')).toContain(TITLE('f')); // title.function.invoke
    expect(highlightCode('class A {}', 'ts')).toContain(CLASS('A')); // title.class
  });

  it('falls back to the parent scope when a sub-scope has no entry', () => {
    // title.class.inherited has no entry of its own: it takes title.class.
    expect(highlightCode('class A extends B {}', 'ts')).toContain(CLASS('B'));
  });

  it('resumes the outer color after a nested span closes', () => {
    // C's #include is a meta span holding a keyword and a string; each keeps its own color.
    const out = highlightCode('#include <x.h>', 'c');
    expect(out).toContain(KEYWORD('include'));
    expect(out).toContain(STRING('<x.h>'));
  });

  // Downsampled, the pastel tones all land on white; 16 colors get named ones instead.
  it('keeps keywords, types and strings apart on a 16-color terminal', () => {
    chalk.level = 1;
    const out = highlightCode('class A { f() { return "s"; } }', 'ts');
    expect(out).toContain(chalk.magentaBright('class'));
    expect(out).toContain(chalk.yellowBright('A'));
    expect(out).toContain(chalk.green('"s"'));
  });

  it('leaves code alone with colors off', () => {
    chalk.level = 0;
    expect(highlightCode('const x = 1;', 'ts')).toBe('const x = 1;');
  });
});

// highlight.js drives its emitter through a private-but-stable hook (HLJSOptions.__emitter), and
// reika's theme is keyed by the scopes that hook hands over. The HTML format it replaced is no
// longer parsed, so this pins the tree's half of the contract instead: raw dotted scopes, not the
// `hljs-title function_ invoke__` CSS classes its HTML route writes, and text that arrives
// unescaped, so the five entity decodings have nothing left to undo.
describe('the highlight.js scope tree ScopeEmitter consumes', () => {
  // Rust is where a multi-part scope is reachable: `foo(` is `title.function.invoke`, which the
  // HTML route serializes as `hljs-title function_ invoke__`.
  const emitterFor = (language: string, code: string): ScopeEmitter =>
    hljs.highlight(code, { language, ignoreIllegals: true })._emitter as ScopeEmitter;

  const scopes = (node: ScopeNode): string[] =>
    node.children.flatMap(c =>
      typeof c === 'string' ? [] : [...(c.scope ? [c.scope] : []), ...scopes(c)],
    );
  const texts = (node: ScopeNode): string =>
    node.children.map(c => (typeof c === 'string' ? c : texts(c))).join('');

  it('is reika’s emitter, handed raw dotted scopes', () => {
    const emitter = emitterFor('rust', 'foo(x)');
    expect(emitter).toBeInstanceOf(ScopeEmitter);
    const found = scopes(emitter.root);
    expect(found).toContain('title.function.invoke');
    expect(found.some(s => s.startsWith('hljs-') || s.includes('_'))).toBe(false);
  });

  it('hands over text the renderer has not escaped', () => {
    const code = 'const a = 1 < 2 && "q" !== \'r\'; // <tag> & done';
    const all = texts(emitterFor('ts', code).root);
    expect(all).toContain('1 < 2 && "q" !== \'r\'');
    expect(all).toContain('// <tag> & done');
  });

  it('keeps the raw `language:` sublanguage scope, which the HTML route rewrites', () => {
    const html = '<script>let y = 1;</script>';
    expect(scopes(emitterFor('html', html).root)).toContain('language:javascript');
    // No theme entry and no parent scope to fall back to, so it adds no color of its own.
    expect(stripAnsi(highlightCode(html, 'html'))).toBe(html);
  });
});

// highlight.js calls openNode/closeNode on its hot path and startScope/endScope through its
// keyword helper, so both families have to build the same tree (its `Emitter` type declares only
// the second pair). Driven directly here, with no grammar in between.
describe('ScopeEmitter', () => {
  it('paints nested scopes through either method family', () => {
    const emitter = new ScopeEmitter();
    emitter.openNode('keyword');
    emitter.addText('const');
    emitter.startScope('string');
    emitter.addText('"x"');
    emitter.endScope();
    emitter.closeNode();
    expect(emitter.toHTML()).toBe(KEYWORD(`const${STRING('"x"')}`));
  });

  it('splices a nested language in unpainted', () => {
    const emitter = new ScopeEmitter();
    const sub = new ScopeEmitter();
    sub.openNode('keyword');
    sub.addText('let');
    sub.closeNode();
    emitter.addText('a ');
    emitter.__addSublanguage(sub, 'javascript');
    emitter.addText(' b');
    expect(emitter.toHTML()).toBe(`a ${KEYWORD('let')} b`);
  });

  it('leaves an unpainted scope transparent, and finalize drops scopes left open', () => {
    const emitter = new ScopeEmitter();
    emitter.openNode('no-theme-entry');
    emitter.addText('plain');
    emitter.finalize(); // a malformed match left the scope open
    emitter.openNode('keyword');
    emitter.addText('still');
    emitter.finalize();
    expect(emitter.toHTML()).toBe(`plain${KEYWORD('still')}`);
  });
});

describe('fenced code in markdown', () => {
  it('takes the language from the first word of the info string', () => {
    const out = renderMarkdown('```ts title="a.ts"\nconst x = 1;\n```');
    expect(out).toContain(KEYWORD('const'));
  });

  it('draws the code flush with the prose, without fence lines', () => {
    const out = stripAnsi(renderMarkdown('before\n\n```ts\nconst x = 1;\n```\n\nafter'));
    expect(out).toBe('before\n\nconst x = 1;\n\nafter');
  });
});
