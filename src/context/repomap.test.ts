import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRepoMap, extractSymbols } from './repomap.js';

describe('extractSymbols', () => {
  it('ts/js: exported declarations only, plus CommonJS exports', () => {
    const src = [
      'export function alpha() {}',
      'export default async function beta() {}',
      'export const gamma = 1;',
      'export abstract class Delta {}',
      'export type Eps = string;',
      'export interface Zeta {}',
      'export const enum Eta { A }',
      'function hidden() {}',
      'const alsoHidden = 2;',
      'exports.theta = () => {};',
    ].join('\n');
    expect(extractSymbols(src, '.ts')).toEqual([
      'beta',
      'alpha',
      'gamma',
      'Delta',
      'Eps',
      'Zeta',
      'Eta',
      'theta',
    ]);
  });

  it('python: top-level def/class, underscore-private dropped, methods not captured', () => {
    const src = [
      'import os',
      'def public_fn():',
      '    pass',
      'async def fetch():',
      '    pass',
      'def _private():',
      '    pass',
      'class Widget:',
      '    def method(self):',
      '        pass',
    ].join('\n');
    expect(extractSymbols(src, '.py')).toEqual(['public_fn', 'fetch', 'Widget']);
  });

  it('go: exported names only, receivers and grouped type blocks handled', () => {
    const src = [
      'package store',
      'func New() *Store { return nil }',
      'func (s *Store) Get(k string) string { return "" }',
      'func helper() {}',
      'type Store struct{}',
      'type (',
      '\tOption struct{}',
      '\tsecret struct{}',
      ')',
      'const MaxSize = 10',
      'var debug = false',
    ].join('\n');
    expect(extractSymbols(src, '.go')).toEqual(['New', 'Get', 'Store', 'Option', 'MaxSize']);
  });

  it('rust: top-level items and pub methods; mod and private methods stay out', () => {
    const src = [
      'use std::fmt;',
      'pub struct Hasher;',
      'pub(crate) enum Mode { A }',
      'fn private_top() {}',
      'pub const fn fast() {}',
      'const LIMIT: u32 = 1;',
      'impl Hasher {',
      '    pub fn new() -> Self { Hasher }',
      '    fn internal(&self) {}',
      '}',
      'macro_rules! make { () => {} }',
      '#[cfg(test)]',
      'mod tests {}',
    ].join('\n');
    expect(extractSymbols(src, '.rs')).toEqual([
      'Hasher',
      'Mode',
      'private_top',
      'fast',
      'LIMIT',
      'new',
      'make',
    ]);
  });

  it('java/c#: types plus public/protected members, calls and locals ignored', () => {
    const src = [
      'package app;',
      'public final class Service implements Runnable {',
      '  private final Map<String, List<Integer>> cache = new HashMap<>();',
      '  public Service(Config c) {}',
      '  public static void main(String[] args) {',
      '    Service s = create(args);',
      '    if (s == null) return;',
      '  }',
      '  protected Map<String, Integer> lookup(String k) { return null; }',
      '  private void internal() {}',
      '  public override string ToString() { return ""; }',
      '  interface Callback {}',
      '  public record Point(int x, int y) {}',
      '}',
    ].join('\n');
    expect(extractSymbols(src, '.java')).toEqual([
      'Service',
      'Callback',
      'Point',
      'main',
      'lookup',
      'ToString',
    ]);
  });

  it('kotlin: classes, objects, fun with generics and receivers', () => {
    const src = [
      'data class User(val id: Int)',
      'object Registry {',
      '  fun <T> register(item: T) {}',
      '  private fun String.shout(): String = this',
      '}',
      'suspend fun load(): User = User(1)',
      'typealias Handler = (User) -> Unit',
    ].join('\n');
    expect(extractSymbols(src, '.kt')).toEqual([
      'User',
      'Registry',
      'register',
      'shout',
      'load',
      'Handler',
    ]);
  });

  it('swift: func/struct/protocol/extension with modifiers and attributes', () => {
    const src = [
      'import Foundation',
      'public struct Point { var x: Int }',
      'protocol Drawable {}',
      'extension Point: Drawable {',
      '  @discardableResult public func draw() -> Bool { true }',
      '  class func make() -> Point { Point(x: 0) }',
      '}',
      'final class Canvas {}',
    ].join('\n');
    expect(extractSymbols(src, '.swift')).toEqual(['Point', 'Drawable', 'draw', 'make', 'Canvas']);
  });

  it('c/c++: column-0 definitions and prototypes; pointers, methods, structs, typedefs', () => {
    const src = [
      '#include <stdio.h>',
      '#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))',
      'static void *alloc_buf(size_t n);',
      'int main(int argc, char **argv) {',
      '  if (argc > 1) return run(argv[1]);',
      '  return 0;',
      '}',
      'std::string Parser::next_token() {',
      '  return "";',
      '}',
      'typedef struct node {',
      '  int v;',
      '} node_t;',
      'typedef void (*callback_t)(int);',
      'enum class Color : int { Red };',
      'MODULE_INIT(setup);',
      'else if (x) {}',
      'void __attribute__((noinline)) hot_path(void);',
    ].join('\n');
    expect(extractSymbols(src, '.c')).toEqual([
      'alloc_buf',
      'main',
      'next_token',
      'node',
      'Color',
      'node_t',
    ]);
  });

  it('ruby: def with self. and punctuation, class/module', () => {
    const src = [
      'module Billing',
      '  class Invoice',
      '    def self.build(x) end',
      '    def paid?; end',
      '    def total=(v) end',
      '  end',
      'end',
    ].join('\n');
    expect(extractSymbols(src, '.rb')).toEqual(['build', 'paid?', 'total=', 'Billing', 'Invoice']);
  });

  it('php: functions with modifiers/reference return, classes/traits/enums', () => {
    const src = [
      '<?php',
      'function helper(): void {}',
      'final class Cart {',
      '  public static function &create(): self {}',
      '}',
      'trait Loggable {}',
      'enum Suit: string {}',
    ].join('\n');
    expect(extractSymbols(src, '.php')).toEqual(['helper', 'create', 'Cart', 'Loggable', 'Suit']);
  });

  it('lua: function forms, dotted and method names reduced to the last segment', () => {
    const src = [
      'local M = {}',
      'function M.setup(opts) end',
      'function M:run() end',
      'local function helper() end',
      'M.teardown = function() end',
      'local cb = function() end',
    ].join('\n');
    expect(extractSymbols(src, '.lua')).toEqual(['setup', 'run', 'helper', 'teardown', 'cb']);
  });

  it('shell: both function syntaxes', () => {
    const src = [
      '#!/bin/sh',
      'log() {',
      '  echo "$@"',
      '}',
      'function check-deps {',
      '  :',
      '}',
    ].join('\n');
    expect(extractSymbols(src, '.sh')).toEqual(['log', 'check-deps']);
  });

  it('unknown extension yields nothing', () => {
    expect(extractSymbols('export function x() {}', '.md')).toEqual([]);
  });
});

describe('buildRepoMap', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reika-repomap-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
  }

  it('ranks a file above another when more files mention its symbols, across languages', async () => {
    await write({
      'core.py': 'def load_config():\n    pass\n',
      'leaf.py': 'def unused_helper():\n    pass\n',
      'a.py': 'from core import load_config\nload_config()\n',
      'b.py': 'import core\ncore.load_config()\n',
      'tool.sh': 'python -c "load_config"\n',
    });
    const map = await buildRepoMap(dir, ignore());
    expect(map.split('\n')).toEqual(['core.py: load_config', 'leaf.py: unused_helper']);
  });

  it('a name mentioned in every file earns no credit', async () => {
    await write({
      'common.go': 'package p\nfunc Log() {}\n',
      'engine.go': 'package p\nfunc Render() {}\n',
      'x.go': 'package p\nfunc a() { Log(); Render() }\n',
      'y.go': 'package p\nfunc b() { Log() }\n',
      'z.go': 'package p\nfunc c() { Log() }\n',
    });
    // Log is in 3/5 files, Render in 1/5: df*log(N/df) gives 3*log(5/3)=1.53 vs 1*log(5)=1.61.
    const map = await buildRepoMap(dir, ignore());
    expect(map.split('\n')[0]).toBe('engine.go: Render');
  });

  it('caps symbols per file and reports the remainder', async () => {
    const names = Array.from({ length: 30 }, (_, i) => `sym${i}`);
    await write({
      'wide.rs': names.map(n => `pub fn ${n}() {}`).join('\n'),
    });
    const map = await buildRepoMap(dir, ignore());
    expect(map).toBe(`wide.rs: ${names.slice(0, 24).join(', ')} (+6 more)`);
  });

  it('omits files past the budget and counts them', async () => {
    await write({
      'a.py': 'def first_function():\n    pass\n',
      'b.py': 'def second_function():\n    pass\n',
      'c.py': 'def third_function():\n    pass\n',
    });
    const map = await buildRepoMap(dir, ignore(), 25);
    expect(map).toBe('a.py: first_function\n(2 more files omitted)');
  });

  it('skips Go test files, gitignored paths, and hardcoded build dirs', async () => {
    await write({
      'lib.go': 'package p\nfunc Real() {}\n',
      'lib_test.go': 'package p\nfunc TestReal(t *T) {}\n',
      'gen/out.go': 'package gen\nfunc Generated() {}\n',
      'target/build.rs': 'pub fn built() {}\n',
    });
    const map = await buildRepoMap(dir, ignore().add('gen/'));
    expect(map).toBe('lib.go: Real');
  });

  it('stops reading at the file cap, keeping the shallow files first', async () => {
    await write({
      'z.py': 'def root_last():\n    pass\n',
      'a/nested.py': 'def nested_first():\n    pass\n',
      'b.py': 'def root_first():\n    pass\n',
    });
    // Two of three: the root's files are all read before any subdirectory is opened, and the
    // cut is not reported as a budget omission — the map simply never saw the third file.
    const map = await buildRepoMap(dir, ignore(), undefined, { dirs: 4000, files: 2 });
    expect(map.split('\n').sort()).toEqual(['b.py: root_first', 'z.py: root_last']);
  });

  it('stops descending at the directory cap', async () => {
    await write({
      'top.rs': 'pub fn top() {}\n',
      'a/mid.rs': 'pub fn mid() {}\n',
      'a/b/low.rs': 'pub fn low() {}\n',
    });
    const map = await buildRepoMap(dir, ignore(), undefined, { dirs: 2, files: 3000 });
    expect(map.split('\n').sort()).toEqual(['a/mid.rs: mid', 'top.rs: top']);
  });
});
