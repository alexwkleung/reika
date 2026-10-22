import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ignore from 'ignore';
import { writeTool } from './write.js';
import { GIT_METADATA_WARNING } from './_paths.js';
import { addFileToIndex } from '../context/files.js';
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

// The path that rides `diff.path` is consumed by App.tsx -> addFileToIndex -> ignore, which throws
// a RangeError on an absolute path. An out-of-project write is exactly when that path could become
// absolute, so the approved case — the feature working as designed — is what must be pinned.
describe('writeTool — diff.path stays project-relative', () => {
  it('does not hand an absolute path to the file index after an approved outside write', async () => {
    const g = gate(true);
    const target = join(outsideDir, 'approved.txt');
    const result = await writeTool.run(
      { path: target, content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    const written = result.diff?.path;
    expect(written).toBeDefined();
    expect(isAbsolute(written!)).toBe(false);
    // The actual consumer, not a proxy for it.
    expect(() => addFileToIndex([], written!, ignore())).not.toThrow();
  });

  it('shows the resolved path to the user while keeping diff.path relative', async () => {
    const g = gate(true);
    const target = join(outsideDir, 'shown.txt');
    const result = await writeTool.run(
      { path: target, content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen[0].subject).toBe(target);
    expect(result.summary).toContain(target);
    expect(isAbsolute(result.diff!.path)).toBe(false);
  });

  it('keeps an in-project write on the relative path, unchanged', async () => {
    const result = await writeTool.run(
      { path: 'src/a.ts', content: 'x' },
      { cwd, ignore: ignore() },
    );
    expect(result.diff?.path).toBe('src/a.ts');
  });
});

// stat() answers whether a file exists, and the model reads that answer back in the summary. For a
// path outside the project that is a fact the user has not agreed we may look up.
describe('writeTool — approval precedes the existence check', () => {
  it('does not report whether an outside file exists when the user declines', async () => {
    const g = gate(false);
    const target = join(outsideDir, 'secret-exists.txt');
    await writeFile(target, 'original', 'utf8');
    const result = await writeTool.run(
      { path: target, content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen).toHaveLength(1);
    expect(result.summary).toContain('declined');
    expect(result.summary).not.toContain('already exists');
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('still reports it once the user approves', async () => {
    const g = gate(true);
    const target = join(outsideDir, 'now-visible.txt');
    await writeFile(target, 'original', 'utf8');
    const result = await writeTool.run(
      { path: target, content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(result.summary).toContain('already exists');
  });

  it('prompts once, not twice, for an approved outside write', async () => {
    const g = gate(true);
    await writeTool.run(
      { path: join(outsideDir, 'once.txt'), content: 'x' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0].warnings).toEqual(['Writes outside the project directory']);
  });
});

// #719: the same deny the sandbox profile gives bash commands, at the file-tool level. The shape is
// the warning (like OUTSIDE_PROJECT_WARNING): under `safe` the modal carries it and the user
// decides — a user asking the agent to repair a hook can approve — and under `bypass` the write is
// refused, since there is nobody to clear it. The control is COMMIT_EDITMSG, mirroring the sandbox
// enforcement test in bash.test.ts.
//
// Creating the `.git` files the gate protects is itself a write some test environments deny (the
// repo's own sandbox profile refuses `.git`-named writes even in temp), so the setup that needs
// them — a real `git init` — skips where it cannot, exactly as bash.test.ts's sandbox enforcement
// skips where sandbox-exec cannot run.
const gitInitWorks = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'reika-gitinit-probe-'));
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!gitInitWorks)('writeTool — git metadata gate (#719)', () => {
  beforeEach(async () => {
    execFileSync('git', ['init', '-q'], { cwd });
  });

  it('warns on .git/config before the existence check, leaving git bytes alone on approval', async () => {
    const g = gate(true);
    const result = await writeTool.run(
      { path: '.git/config', content: '[evil]\n' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0].warnings).toEqual([GIT_METADATA_WARNING]);
    // Consent precedes the stat, exactly like the out-of-project gate.
    expect(result.summary).toContain('already exists');
    expect(await readFile(join(cwd, '.git/config'), 'utf8')).toContain('repositoryformatversion');
  });

  it('warns on a new .git/hooks/pre-commit and lands it once the user approves', async () => {
    const g = gate(true);
    const result = await writeTool.run(
      { path: '.git/hooks/pre-commit', content: '#!/bin/sh\nexit 0\n' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen[0].warnings).toEqual([GIT_METADATA_WARNING]);
    expect(result.summary).toMatch(/^Wrote /);
    expect(await readFile(join(cwd, '.git/hooks/pre-commit'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });

  it('refuses .git/config under bypass, where no modal can clear it', async () => {
    const before = await readFile(join(cwd, '.git/config'), 'utf8');
    const result = await writeTool.run(
      { path: '.git/config', content: '[evil]\n' },
      { cwd, ignore: ignore() },
    );
    expect(result.summary).toContain('Write refused');
    expect(result.summary).toContain('git config or a hook');
    expect(await readFile(join(cwd, '.git/config'), 'utf8')).toBe(before);
  });

  it('refuses a new hook under bypass', async () => {
    const result = await writeTool.run(
      { path: '.git/hooks/pre-commit', content: '#!/bin/sh\nexit 0\n' },
      { cwd, ignore: ignore() },
    );
    expect(result.summary).toContain('Write refused');
    await expect(readFile(join(cwd, '.git/hooks/pre-commit'), 'utf8')).rejects.toThrow();
  });

  it('leaves .git/COMMIT_EDITMSG ungated — the control from the sandbox test', async () => {
    const g = gate(true);
    const result = await writeTool.run(
      { path: '.git/COMMIT_EDITMSG', content: 'msg\n' },
      { cwd, ignore: ignore(), requestApproval: g.requestApproval },
    );
    expect(g.seen[0].warnings).toBeUndefined();
    expect(result.summary).toMatch(/^Wrote /);
    expect(await readFile(join(cwd, '.git/COMMIT_EDITMSG'), 'utf8')).toBe('msg\n');
  });
});

// The gate is by NAME, so it fires before anything touches the filesystem — this runs in every
// environment, including ones that deny `.git` writes outright (the setup above skips there).
describe('writeTool — the git-metadata gate needs no .git on disk', () => {
  it('refuses .git/config under bypass even when no .git exists', async () => {
    const result = await writeTool.run(
      { path: '.git/config', content: 'x\n' },
      { cwd, ignore: ignore() },
    );
    expect(result.summary).toContain('Write refused');
    expect(result.summary).toContain('git config or a hook');
    const rel = join(cwd, '.git', 'config');
    await expect(readFile(rel, 'utf8')).rejects.toThrow();
  });
});
