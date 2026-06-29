import { describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { addFileToIndex } from './files.js';

describe('addFileToIndex', () => {
  it('inserts a new path in sorted position', () => {
    const idx = ['a.ts', 'm.ts', 'z.ts'];
    expect(addFileToIndex(idx, 'n.ts', ignore())).toEqual(['a.ts', 'm.ts', 'n.ts', 'z.ts']);
  });

  it('inserts at the boundaries', () => {
    expect(addFileToIndex(['m.ts'], 'a.ts', ignore())).toEqual(['a.ts', 'm.ts']);
    expect(addFileToIndex(['m.ts'], 'z.ts', ignore())).toEqual(['m.ts', 'z.ts']);
    expect(addFileToIndex([], 'only.ts', ignore())).toEqual(['only.ts']);
  });

  it('returns the same reference when the path already exists', () => {
    const idx = ['a.ts', 'b.ts'];
    expect(addFileToIndex(idx, 'b.ts', ignore())).toBe(idx);
  });

  it('returns the same reference for a gitignored path', () => {
    const idx = ['a.ts'];
    expect(addFileToIndex(idx, 'secret.env', ignore().add('*.env'))).toBe(idx);
  });

  it('excludes node_modules / dist / dot-dirs to match the startup crawl', () => {
    const idx = ['a.ts'];
    const ig = ignore();
    expect(addFileToIndex(idx, 'node_modules/pkg/index.js', ig)).toBe(idx);
    expect(addFileToIndex(idx, 'dist/bundle.js', ig)).toBe(idx);
    expect(addFileToIndex(idx, '.git/config', ig)).toBe(idx);
  });

  it('keeps .reika paths (mirrors buildFileIndex)', () => {
    expect(addFileToIndex([], '.reika/handoff.md', ignore())).toEqual(['.reika/handoff.md']);
  });

  it('adds a freshly model-written nested source file', () => {
    const idx = ['src/a.ts', 'src/z.ts'];
    expect(addFileToIndex(idx, 'src/new.ts', ignore())).toEqual([
      'src/a.ts',
      'src/new.ts',
      'src/z.ts',
    ]);
  });
});
