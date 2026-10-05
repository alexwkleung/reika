import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFresh, parsePrView, currentBranch, resolvePr, resetPrCache } from './pr.js';

describe('parsePrView', () => {
  it('takes the number of an open PR', () => {
    expect(parsePrView('{"number":99,"state":"OPEN"}')).toEqual({ number: 99 });
  });

  it('carries the web URL the status bar links the number to', () => {
    expect(
      parsePrView('{"number":99,"state":"OPEN","url":"https://github.com/o/r/pull/99"}'),
    ).toEqual({ number: 99, url: 'https://github.com/o/r/pull/99' });
  });

  it('shows the badge without a link when gh reports no URL', () => {
    expect(parsePrView('{"number":99,"state":"OPEN","url":""}')).toEqual({ number: 99 });
    expect(parsePrView('{"number":99,"state":"OPEN","url":7}')).toEqual({ number: 99 });
  });

  it('ignores closed and merged PRs — a landed number is stale info', () => {
    expect(parsePrView('{"number":99,"state":"MERGED"}')).toBeNull();
    expect(parsePrView('{"number":99,"state":"CLOSED"}')).toBeNull();
  });

  it('accepts a number when gh reports no state field', () => {
    expect(parsePrView('{"number":12}')).toEqual({ number: 12 });
  });

  it('returns null on anything unparseable', () => {
    expect(parsePrView('')).toBeNull();
    expect(parsePrView('no PRs found for branch "main"')).toBeNull();
    expect(parsePrView('{"number":"12"}')).toBeNull();
  });
});

describe('isFresh', () => {
  it('keeps a hit for five minutes', () => {
    expect(isFresh({ pr: { number: 7 }, at: 0 }, 299_000)).toBe(true);
    expect(isFresh({ pr: { number: 7 }, at: 0 }, 301_000)).toBe(false);
  });

  it('re-checks a miss after a minute so a new PR appears without a restart', () => {
    expect(isFresh({ pr: null, at: 0 }, 59_000)).toBe(true);
    expect(isFresh({ pr: null, at: 0 }, 61_000)).toBe(false);
  });
});

// A repo of its own rather than this checkout: CI checks a PR out at a detached HEAD.
function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'reika-pr-'));
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  return dir;
}

describe('currentBranch', () => {
  it('reads the checked-out branch of a real repo', async () => {
    const dir = makeRepo('feature/x');
    try {
      expect(await currentBranch(dir)).toBe('feature/x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null at a detached HEAD', async () => {
    const dir = makeRepo('main');
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
      git(
        '-c',
        'user.name=Mona Lisa',
        '-c',
        'user.email=octocat@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      );
      git('checkout', '-q', '--detach');
      expect(await currentBranch(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null outside a git repo instead of throwing', async () => {
    expect(await currentBranch('/')).toBeNull();
  });
});

describe('resolvePr', () => {
  it('resolves to null outside a repo without shelling out to gh', async () => {
    resetPrCache();
    expect(await resolvePr('/', Date.now())).toBeNull();
  });
});
