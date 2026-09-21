import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TreeChanges } from '../types.js';

// A shell edit is an edit. The two done-gates used to key on MUTATING_TOOLS = {write, edit}, so a
// turn that did its writing through `sed -i` or a heredoc finished with the post-edit typecheck
// never run and the plan done-gate never fired. These are the two predicates that close that gap —
// deliberately separate, because they answer the same question at different moments with different
// evidence: `willMutate` before dispatch from the command text (best-effort, what the typecheck
// baseline needs), `didMutate` after it from the git-backed tree diff (accurate, what the plan gate
// needs).

vi.mock('../provider/client.js', () => ({ callModel: vi.fn() }));

const { willMutate, didMutate, typecheckAnchor } = await import('./loop.js');

const CWD = '/repo';
const changes = (...paths: string[]): TreeChanges => ({
  files: paths.map(path => ({ path, kind: 'modified' as const, hunks: [], added: 1, removed: 0 })),
  more: 0,
});

describe('willMutate', () => {
  it('is true for the mutating tools whatever their args', () => {
    expect(willMutate('edit', { path: 'a.ts' }, CWD)).toBe(true);
    expect(willMutate('write', { path: 'a.ts' }, CWD)).toBe(true);
    // A malformed call still counts: the pre-existing behavior captures a baseline on the attempt.
    expect(willMutate('edit', {}, CWD)).toBe(true);
  });

  it('is false for the inspection tools', () => {
    expect(willMutate('read', { path: 'a.ts' }, CWD)).toBe(false);
    expect(willMutate('grep', { pattern: 'x' }, CWD)).toBe(false);
    expect(willMutate('subagent', { task: 'x' }, CWD)).toBe(false);
  });

  it('is true for a bash command that names files it will write', () => {
    expect(willMutate('bash', { command: "sed -i '' s/a/b/ src/app.ts" }, CWD)).toBe(true);
    expect(willMutate('bash', { command: "cat > src/app.ts <<'EOF'\nx\nEOF" }, CWD)).toBe(true);
    expect(willMutate('bash', { command: 'echo x >> notes.md' }, CWD)).toBe(true);
    expect(willMutate('bash', { command: 'cp a.ts b.ts' }, CWD)).toBe(true);
    expect(willMutate('bash', { command: 'rm src/old.ts' }, CWD)).toBe(true);
  });

  it('is false for a read-only bash command', () => {
    // The case the separation exists for: bash runs inspection far more often than it mutates, and
    // treating every bash call as an edit would put a tsc run in front of every `grep`.
    expect(willMutate('bash', { command: 'grep -rn foo src' }, CWD)).toBe(false);
    expect(willMutate('bash', { command: 'ls -la && cat package.json' }, CWD)).toBe(false);
    expect(willMutate('bash', { command: 'npm test' }, CWD)).toBe(false);
    expect(willMutate('bash', {}, CWD)).toBe(false);
  });

  it('does not mistake a quoted redirect in a search pattern for a write', () => {
    expect(willMutate('bash', { command: 'grep -n ">" src/app.ts' }, CWD)).toBe(false);
  });
});

describe('didMutate', () => {
  it('counts the attempt for edit/write, landed or not', () => {
    // A failed edit is what puts the turn in edit-recovery, so it must still read as "acted".
    expect(didMutate('edit', undefined)).toBe(true);
    expect(didMutate('write', undefined)).toBe(true);
  });

  it('counts a bash call only when the tree actually changed', () => {
    expect(didMutate('bash', changes('src/app.ts'))).toBe(true);
    expect(didMutate('bash', { files: [], more: 0 })).toBe(false);
    expect(didMutate('bash', undefined)).toBe(false);
  });

  it('catches what the command text cannot', () => {
    // `npm run fix` names no targets, so willMutate misses it — the git-backed diff does not.
    const command = 'npm run fix';
    expect(willMutate('bash', { command }, CWD)).toBe(false);
    expect(didMutate('bash', changes('src/app.ts'))).toBe(true);
  });

  it('is false for the inspection tools', () => {
    expect(didMutate('read', undefined)).toBe(false);
    expect(didMutate('grep', undefined)).toBe(false);
  });
});

describe('typecheckAnchor', () => {
  it('is the edited path for edit/write', () => {
    expect(typecheckAnchor('edit', { path: 'packages/web/src/a.ts' }, CWD)).toBe(
      'packages/web/src/a.ts',
    );
    expect(typecheckAnchor('write', { path: 'a.ts' }, CWD)).toBe('a.ts');
    expect(typecheckAnchor('edit', {}, CWD)).toBeUndefined();
  });

  it('is the first file a bash command names, resolved against cwd', () => {
    // Absolute, which is what detectTsProject's own resolve() expects to be handed.
    expect(
      typecheckAnchor('bash', { command: "sed -i '' s/a/b/ packages/web/src/a.ts" }, CWD),
    ).toBe(join(CWD, 'packages/web/src/a.ts'));
  });

  it('is undefined when there is nothing to anchor on', () => {
    expect(typecheckAnchor('bash', { command: 'npm test' }, CWD)).toBeUndefined();
    expect(typecheckAnchor('read', { path: 'a.ts' }, CWD)).toBeUndefined();
  });
});
