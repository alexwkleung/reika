// Characterization battery for editTool's residual edge cases — the behavior
// that remains AFTER exact-match + whitespace-tolerant fallback (#1/#2).
//
// These tests document CURRENT behavior, including known-imperfect rows. Rows
// labeled LIMITATION are slated to change when the divergence-diff message (#3)
// and the mixed-indent guard land; their assertions will be updated then. Run
// this file to see which rows pass as-is.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { editTool } from './edit.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-edit-edge-'));
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

describe('editTool edge cases', () => {
  // Row 1 — mixed tabs/spaces inside new_string.
  // When re-indenting (model's base differs from the file's), a line that doesn't
  // share the model's base indent can't be rewritten unambiguously, so the edit
  // is rejected rather than silently producing inconsistent indentation.
  describe('mixed indentation in new_string', () => {
    it('rejects an off-base line instead of mis-indenting silently', async () => {
      const before = 'function f() {\n  if (x) {\n    go();\n  }\n}\n';
      const p = await write('a.ts', before);
      const result = await editTool.run(
        {
          path: 'a.ts',
          // model uses a 4-space base where the file uses 2
          old_string: '    if (x) {\n      go();\n    }',
          // ...but the middle replacement line uses a tab instead of 4 spaces
          new_string: '    if (x) {\n\tgo();\n      done();\n    }',
        },
        ctx(),
      );
      expect(result.summary).toMatch(/mixes indentation/);
      // File is left untouched — no silent half-applied edit.
      expect(await readFile(p, 'utf8')).toBe(before);
    });

    it('still applies when every new line shares the model base indent', async () => {
      const p = await write('a.ts', 'function f() {\n  if (x) {\n    go();\n  }\n}\n');
      const result = await editTool.run(
        {
          path: 'a.ts',
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
  });

  // Row 2 — block diverges at a middle line.
  // Anchor line exists, but a later line in old_string doesn't match the file.
  // The hint now pinpoints the diverging line and shows what the file actually
  // has there, so the model can correct in one retry.
  describe('block diverges at a middle line', () => {
    it('reports the diverging line and the file content there', async () => {
      await write('a.css', '.box {\n  font-size: 13px;\n  color: red;\n}\n');
      const result = await editTool.run(
        {
          path: 'a.css',
          // file has `color: red;` here, not blue
          old_string: '  font-size: 13px;\n  color: blue;',
          new_string: '  font-size: 14px;\n  color: blue;',
        },
        ctx(),
      );
      expect(result.summary).toMatch(/not found/);
      expect(result.summary).toMatch(/line 2/); // anchor / block start
      expect(result.summary).toMatch(/line 3 differs/); // where it diverged
      expect(result.summary).toMatch(/expected "color: blue;"/);
      expect(result.summary).toMatch(/file has "color: red;"/);
    });
  });

  // Row 3 — genuinely ambiguous fuzzy match (two trimmed-equal blocks).
  // Refused, and the message now lists the candidate line numbers so the model
  // knows where to add disambiguating context.
  describe('ambiguous fuzzy match', () => {
    it('refuses and lists the candidate line numbers', async () => {
      await write('a.css', '  font-size: 13px;\n  font-size: 13px;\n');
      const result = await editTool.run(
        { path: 'a.css', old_string: '\tfont-size: 13px;', new_string: '\tfont-size: 14px;' },
        ctx(),
      );
      expect(result.summary).toMatch(/multiple times/);
      expect(result.summary).toMatch(/lines 1, 2/);
    });
  });

  // Row 4 — substring / non-whole-line old_string that misses exact.
  // The fuzzy path is line-based, so a fragment that no file line trims to is
  // unrecoverable. Documents that fuzzy is NOT a substring matcher.
  describe('substring old_string that misses exact match', () => {
    it('does not fuzzy-match a mid-line fragment', async () => {
      await write('a.css', '.box {\n  font-size: 13px;\n}\n');
      const result = await editTool.run(
        // wrong case — not present exactly, and not a whole line
        { path: 'a.css', old_string: '13PX', new_string: '14px' },
        ctx(),
      );
      expect(result.summary).toMatch(/not found/);
    });
  });

  // Row 5 — CRLF file, LF old_string.
  // Single-line edits match exactly (the `\r` sits after the content). Multi-line
  // edits miss exact but recover via fuzzy (`.trim()` eats the `\r`) — at the cost
  // of re-emitting that block with LF endings, leaving the file mixed.
  describe('CRLF line endings', () => {
    it('matches a single line exactly despite CRLF', async () => {
      const p = await write('a.css', '.box {\r\n  color: red;\r\n}\r\n');
      const result = await editTool.run(
        { path: 'a.css', old_string: '  color: red;', new_string: '  color: blue;' },
        ctx(),
      );
      expect(result.summary).toMatch(/^Edited/);
      expect(await readFile(p, 'utf8')).toBe('.box {\r\n  color: blue;\r\n}\r\n');
    });

    it('LIMITATION: multi-line CRLF block recovers via fuzzy but normalizes to LF', async () => {
      const p = await write('a.css', '.box {\r\n  color: red;\r\n}\r\n');
      const result = await editTool.run(
        { path: 'a.css', old_string: '  color: red;\n}', new_string: '  color: blue;\n}' },
        ctx(),
      );
      expect(result.summary).toMatch(/^Edited/);
      const out = await readFile(p, 'utf8');
      expect(out).toContain('color: blue;');
      // The edited block lost its CRLF — file is now mixed:
      expect(out).toContain('  color: blue;\n}');
    });
  });

  // Row 6 — anchor line truly absent (no line matches even when trimmed).
  describe('anchor line absent', () => {
    it('hints to re-read when nothing matches even loosely', async () => {
      await write('a.css', '.box {\n  font-size: 13px;\n}\n');
      const result = await editTool.run(
        { path: 'a.css', old_string: '  background: pink;', new_string: '  background: teal;' },
        ctx(),
      );
      expect(result.summary).toMatch(/not found/);
      expect(result.summary).toMatch(/re-read/);
    });
  });
});
