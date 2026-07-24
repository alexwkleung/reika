import { describe, expect, it } from 'vitest';
import { isFresh, parsePrView, currentBranch, resolvePr, resetPrCache } from './pr.js';

describe('parsePrView', () => {
  it('takes the number of an open PR', () => {
    expect(parsePrView('{"number":99,"state":"OPEN"}')).toBe(99);
  });

  it('ignores closed and merged PRs — a landed number is stale info', () => {
    expect(parsePrView('{"number":99,"state":"MERGED"}')).toBeNull();
    expect(parsePrView('{"number":99,"state":"CLOSED"}')).toBeNull();
  });

  it('accepts a number when gh reports no state field', () => {
    expect(parsePrView('{"number":12}')).toBe(12);
  });

  it('returns null on anything unparseable', () => {
    expect(parsePrView('')).toBeNull();
    expect(parsePrView('no PRs found for branch "main"')).toBeNull();
    expect(parsePrView('{"number":"12"}')).toBeNull();
  });
});

describe('isFresh', () => {
  it('keeps a hit for five minutes', () => {
    expect(isFresh({ number: 7, at: 0 }, 299_000)).toBe(true);
    expect(isFresh({ number: 7, at: 0 }, 301_000)).toBe(false);
  });

  it('re-checks a miss after a minute so a new PR appears without a restart', () => {
    expect(isFresh({ number: null, at: 0 }, 59_000)).toBe(true);
    expect(isFresh({ number: null, at: 0 }, 61_000)).toBe(false);
  });
});

describe('currentBranch', () => {
  it('reads the checked-out branch of a real repo', async () => {
    expect(await currentBranch(process.cwd())).toBeTruthy();
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
