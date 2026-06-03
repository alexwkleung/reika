import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { editTool } from './edit.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-edit-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const ctx = () => ({ cwd, ignore: ignore() });

async function write(name: string, content: string): Promise<string> {
  const p = join(cwd, name);
  await writeFile(p, content, 'utf8');
  return p;
}

describe('editTool', () => {
  it('replaces an exact unique match', async () => {
    const p = await write('a.css', '.x {\n  color: red;\n}\n');
    const result = await editTool.run(
      { path: 'a.css', old_string: '  color: red;', new_string: '  color: blue;' },
      ctx(),
    );
    expect(result.summary).toMatch(/^Edited/);
    expect(await readFile(p, 'utf8')).toBe('.x {\n  color: blue;\n}\n');
  });

  it('fails when old_string is non-unique and exact', async () => {
    await write('a.css', '  color: red;\n  color: red;\n');
    const result = await editTool.run(
      { path: 'a.css', old_string: '  color: red;', new_string: '  color: blue;' },
      ctx(),
    );
    expect(result.summary).toMatch(/multiple times/);
  });

  describe('whitespace-tolerant fallback', () => {
    it('matches a single line whose indentation the model got wrong', async () => {
      // File uses 2-space indent; model supplies 4 spaces.
      const p = await write('a.css', '.box {\n  font-size: 13px;\n  line-height: 24px;\n}\n');
      const result = await editTool.run(
        {
          path: 'a.css',
          old_string: '    font-size: 13px;\n    line-height: 24px;',
          new_string: '    font-size: 14px;\n    line-height: 24px;',
        },
        ctx(),
      );
      expect(result.summary).toMatch(/^Edited/);
      // Result preserves the FILE's 2-space indentation, not the model's 4.
      expect(await readFile(p, 'utf8')).toBe(
        '.box {\n  font-size: 14px;\n  line-height: 24px;\n}\n',
      );
    });

    it('reproduces the transcript scenario: two 13px blocks, unique multi-line context', async () => {
      const css = [
        '.line-calc-textarea {',
        "  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;",
        '  font-size: 13px;',
        '  line-height: 24px;',
        '}',
        '',
        '.line-calc-result-line {',
        "  font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;",
        '  font-size: 13px;',
        '  white-space: nowrap;',
        '}',
        '',
      ].join('\n');
      const p = await write('LineCalc.css', css);

      // First block — model uses wrong (4-space) indent, but unique trailing line
      // (line-height) disambiguates it from the second 13px occurrence.
      const r1 = await editTool.run(
        {
          path: 'LineCalc.css',
          old_string: '    font-size: 13px;\n    line-height: 24px;',
          new_string: '    font-size: 14px;\n    line-height: 24px;',
        },
        ctx(),
      );
      expect(r1.summary).toMatch(/^Edited/);

      // Second block — disambiguated by the white-space line.
      const r2 = await editTool.run(
        {
          path: 'LineCalc.css',
          old_string: '    font-size: 13px;\n    white-space: nowrap;',
          new_string: '    font-size: 14px;\n    white-space: nowrap;',
        },
        ctx(),
      );
      expect(r2.summary).toMatch(/^Edited/);

      const out = await readFile(p, 'utf8');
      expect(out).not.toContain('13px');
      expect((out.match(/font-size: 14px;/g) ?? []).length).toBe(2);
      // Indentation stayed at the file's 2 spaces.
      expect(out).toContain('\n  font-size: 14px;\n');
    });

    it('refuses an ambiguous fuzzy match instead of editing the wrong block', async () => {
      await write('a.css', '  font-size: 13px;\n  font-size: 13px;\n');
      const result = await editTool.run(
        { path: 'a.css', old_string: '\tfont-size: 13px;', new_string: '\tfont-size: 14px;' },
        ctx(),
      );
      expect(result.summary).toMatch(/multiple times/);
    });

    it('preserves relative indentation inside a reindented block', async () => {
      const p = await write('a.ts', 'function f() {\n  if (x) {\n    go();\n  }\n}\n');
      const result = await editTool.run(
        {
          path: 'a.ts',
          // model used 4-space base where the file uses 2
          old_string: '    if (x) {\n      go();\n    }',
          new_string: '    if (x) {\n      go();\n      done();\n    }',
        },
        ctx(),
      );
      expect(result.summary).toMatch(/^Edited/);
      expect(await readFile(p, 'utf8')).toBe(
        'function f() {\n  if (x) {\n    go();\n    done();\n  }\n}\n',
      );
    });

    it('gives a located hint when nothing matches even loosely', async () => {
      await write('a.css', '.box {\n  font-size: 13px;\n}\n');
      const result = await editTool.run(
        { path: 'a.css', old_string: '  font-size: 13px;\n  color: red;', new_string: 'x' },
        ctx(),
      );
      expect(result.summary).toMatch(/not found/);
      expect(result.summary).toMatch(/font-size: 13px/);
      expect(result.summary).toMatch(/line 2/);
    });
  });
});
