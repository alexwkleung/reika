import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { writeTool } from './write.js';
import type { ApprovalRequest } from '../types.js';

let cwd: string;
let outsideDir: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'reika-write-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'reika-outside-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

// A recording approval gate. `warnings` is the whole mechanism by which a write reaches the user
// under `safe` (App.tsx hasWarnings), so what lands in the request IS the behavior under test.
function gate(answer = true) {
  const seen: ApprovalRequest[] = [];
  return {
    seen,
    requestApproval: async (req: ApprovalRequest): Promise<boolean> => {
      seen.push(req);
      return answer;
    },
  };
}

describe('writeTool — out-of-project gate', () => {
  it('flags a write outside the project so it cannot be silently auto-approved', async () => {
    const g = gate();
    const target = join(outsideDir, 'escaped.txt');
    const result = await writeTool.run(
      { path: target, content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0].warnings).toEqual(['Writes outside the project directory']);
    // The resolved path rides the subject line, so the modal shows it without a `../../..` chain.
    expect(g.seen[0].subject).toBe(target);
    expect(result.summary).not.toContain('refused');
  });

  it('raises no warning for a write inside the project', async () => {
    const g = gate();
    await writeTool.run(
      { path: 'src/a.ts', content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0].warnings).toBeUndefined();
  });

  it('refuses an out-of-project write under bypass, where no modal can fire', async () => {
    const target = join(outsideDir, 'escaped.txt');
    const result = await writeTool.run({ path: target, content: 'x' }, { cwd, ignore: ignore() });
    expect(result.summary).toContain('Write refused');
    expect(result.summary).toContain('outside the project directory');
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('still writes inside the project under bypass', async () => {
    const result = await writeTool.run(
      { path: 'src/a.ts', content: 'hello' },
      { cwd, ignore: ignore() },
    );
    expect(result.summary).toMatch(/^Wrote /);
    expect(await readFile(join(cwd, 'src/a.ts'), 'utf8')).toBe('hello');
  });

  it('reports the boundary before anything else about the path', async () => {
    // An existing out-of-project file would otherwise return "already exists; use edit instead",
    // sending the model to a tool that refuses it too.
    const target = join(outsideDir, 'existing.txt');
    await writeFile(target, 'original', 'utf8');
    const result = await writeTool.run({ path: target, content: 'x' }, { cwd, ignore: ignore() });
    expect(result.summary).toContain('Write refused');
    expect(await readFile(target, 'utf8')).toBe('original');
  });
});
