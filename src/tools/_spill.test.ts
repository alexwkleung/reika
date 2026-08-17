import { readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCappedFooter,
  buildSpillFooter,
  spillEnabled,
  spillResult,
  resetSpillDir,
} from './_spill.js';

const dirs: string[] = [];

beforeEach(() => {
  resetSpillDir();
  process.env.REIKA_SPILL = '1';
});

afterEach(async () => {
  delete process.env.REIKA_SPILL;
  resetSpillDir();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function spill(name: string, content: string) {
  const ref = await spillResult(name, content);
  if (ref) dirs.push(dirname(ref.path));
  return ref;
}

describe('spillResult', () => {
  it('is a strict no-op when REIKA_SPILL is off', async () => {
    delete process.env.REIKA_SPILL;
    expect(spillEnabled()).toBe(false);
    expect(await spillResult('x', 'content')).toBeNull();
  });

  it('writes the full content and reports its byte size', async () => {
    const content = 'line\n'.repeat(500);
    const ref = await spill('grep-results', content);
    expect(ref).not.toBeNull();
    expect(await readFile(ref!.path, 'utf8')).toBe(content);
    expect(ref!.bytes).toBe(Buffer.byteLength(content));
  });

  it('gives each spill its own path so concurrent calls cannot collide', async () => {
    const a = await spill('grep-results', 'a');
    const b = await spill('grep-results', 'b');
    expect(a!.path).not.toBe(b!.path);
    expect(await readFile(a!.path, 'utf8')).toBe('a');
    expect(await readFile(b!.path, 'utf8')).toBe('b');
  });

  it('sanitizes the suggested name to one path segment', async () => {
    const ref = await spill('../../etc/passwd', 'x');
    expect(ref).not.toBeNull();
    expect(dirname(ref!.path)).toMatch(/reika-spill-/);
    expect(ref!.path).not.toContain('..');
  });

  it('writes owner-only files', async () => {
    const ref = await spill('grep-results', 'x');
    expect((await stat(ref!.path)).mode & 0o777).toBe(0o600);
  });

  it('returns null rather than throwing when the write fails', async () => {
    const ref = await spill('grep-results', 'x');
    // Removing the directory out from under the store is the cheapest real failure to induce.
    await rm(dirname(ref!.path), { recursive: true, force: true });
    expect(await spillResult('grep-results', 'y')).toBeNull();
  });
});

describe('footers', () => {
  it('names the path and both follow-up calls', () => {
    const footer = buildSpillFooter({
      shown: 100,
      total: '384',
      unit: 'matches',
      ref: { path: '/tmp/reika-spill-1/grep-results-ab.txt', bytes: 10 },
    });
    expect(footer).toContain('Showing 100 of 384 matches');
    expect(footer).toContain('/tmp/reika-spill-1/grep-results-ab.txt');
    expect(footer).toContain('read that path');
    expect(footer).toContain('grep it');
    expect(footer).toContain('Do not re-run this search');
  });

  it('says the rest is unavailable when no spill landed', () => {
    const footer = buildCappedFooter({ shown: 100, total: '384', unit: 'matches' });
    expect(footer).toContain('could not be saved');
    expect(footer).not.toContain('read that path');
  });
});
