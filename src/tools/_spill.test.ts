import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCappedFooter,
  buildSpillFooter,
  spillEnabled,
  spillResult,
  resetSpillDir,
  sweepStaleSpills,
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
  // The default is ON: only the explicit '0' opt-out disables it. Pinned because the polarity is
  // the whole contract — an unset var reading as off would silently take the feature away from
  // every user who never heard of the flag.
  it('is on when REIKA_SPILL is unset, and off only for an explicit 0', async () => {
    delete process.env.REIKA_SPILL;
    expect(spillEnabled()).toBe(true);
    process.env.REIKA_SPILL = '0';
    expect(spillEnabled()).toBe(false);
    for (const on of ['1', 'true', 'yes', '']) {
      process.env.REIKA_SPILL = on;
      expect(spillEnabled()).toBe(true);
    }
  });

  it('is a strict no-op when REIKA_SPILL is off', async () => {
    process.env.REIKA_SPILL = '0';
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
    expect(dirname(ref!.path)).toMatch(/reika-[0-9a-f]{6}$/);
    expect(ref!.path).not.toContain('..');
  });

  // #144: the model has to copy this path verbatim to follow the locator, and one was observed
  // dropping a character out of the ~100-char original — 48 of which were ours. Everything below
  // the system temp dir is what we control, so that is what this pins.
  it('keeps the part of the locator we control short enough to copy', async () => {
    const ref = await spill('grep', 'x');
    const ours = ref!.path.slice(tmpdir().length + 1);
    expect(ours).toMatch(/^reika-[0-9a-f]{6}\/grep-\d+\.txt$/);
    expect(ours.length).toBeLessThanOrEqual(24);
  });

  it('numbers files in a directory it created exclusively', async () => {
    const a = await spill('grep', 'a');
    const b = await spill('glob', 'b');
    // A counter rather than random hex — nothing else can write into a 0700 dir made with an
    // exclusive mkdir, and short digits are what the model has to retype.
    expect(basename(a!.path)).toBe('grep-1.txt');
    expect(basename(b!.path)).toBe('glob-2.txt');
    expect(dirname(a!.path)).toBe(dirname(b!.path));
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

// #224: the exit handler is only one of the ways reika stops. SIGHUP (closing the terminal
// window), SIGTERM, SIGKILL and hard crashes all skip it, so the next startup has to be what
// collects the leftovers — without ever reaping a session that is still running.
describe('sweepStaleSpills', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sweeptest-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // A pid far above any real one on macOS/Linux, so the probe reports ESRCH rather than finding
  // a live stranger. Spawning something and waiting for it would leave a pid the OS may recycle.
  const DEAD_PID = 999_999_999;

  async function makeDir(name: string, opts: { owner?: number; ageMs?: number } = {}) {
    const d = join(root, name);
    await mkdir(d, { mode: 0o700 });
    await writeFile(join(d, 'grep-1.txt'), 'x');
    if (opts.owner !== undefined) await writeFile(join(d, '.pid'), `${opts.owner}\n`);
    if (opts.ageMs !== undefined) {
      const when = new Date(Date.now() - opts.ageMs);
      await utimes(d, when, when);
    }
    return d;
  }

  const exists = async (d: string) => !!(await stat(d).catch(() => null));

  it('reaps a directory whose owning process is gone', async () => {
    const d = await makeDir('reika-aaaaaa', { owner: DEAD_PID });
    expect(await sweepStaleSpills(root)).toEqual([d]);
    expect(await exists(d)).toBe(false);
  });

  // The case the sweep must not break: a second reika running right now, whose model may still
  // page an artifact it was handed. Liveness decides it, so age never enters into it.
  it('keeps a directory whose owning process is alive, however old it looks', async () => {
    const d = await makeDir('reika-bbbbbb', { owner: process.pid, ageMs: 30 * 24 * 3600_000 });
    expect(await sweepStaleSpills(root)).toEqual([]);
    expect(await exists(d)).toBe(true);
  });

  // No owner stamp means a pre-#224 directory (or one caught mid-creation), and the only guard
  // left is age. A session idle overnight is inside the window on purpose.
  it('gives an unowned directory a day before reaping it', async () => {
    const overnight = await makeDir('reika-cccccc', { ageMs: 12 * 3600_000 });
    const fresh = await makeDir('reika-dddddd');
    const stale = await makeDir('reika-eeeeee', { ageMs: 25 * 3600_000 });
    expect(await sweepStaleSpills(root)).toEqual([stale]);
    expect(await exists(overnight)).toBe(true);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });

  // An unreadable stamp is treated as no stamp rather than as a dead owner: guessing "abandoned"
  // from a partial write would reap a session that is one millisecond old.
  it('falls back to age when the owner stamp is unreadable', async () => {
    const d = await makeDir('reika-ffffff');
    await writeFile(join(d, '.pid'), 'not-a-pid');
    const old = new Date(Date.now() - 25 * 3600_000);
    await utimes(d, old, old);
    expect(await sweepStaleSpills(root)).toEqual([d]);
  });

  // The sweep runs over a shared temp dir full of other programs' files. Only names this module
  // could have produced are candidates.
  it('touches nothing but its own directory names', async () => {
    const others = [
      await makeDir('reika-spill-1234-abcdef12'),
      await makeDir('reika-'),
      await makeDir('reika-AAAAAA'),
      await makeDir('reika-aaaaaaa'),
      await makeDir('notreika-aaaaaa'),
    ];
    const file = join(root, 'reika-abcdef');
    await writeFile(file, 'a plain file that happens to match');
    await utimes(file, new Date(0), new Date(0));
    for (const d of others) await utimes(d, new Date(0), new Date(0));

    expect(await sweepStaleSpills(root)).toEqual([]);
    for (const d of others) expect(await exists(d)).toBe(true);
    expect(await exists(file)).toBe(true);
  });

  it('is a no-op when the temp root does not exist', async () => {
    expect(await sweepStaleSpills(join(root, 'nope'))).toEqual([]);
  });

  // End to end against the real writer: the live session's own artifact survives its own sweep.
  it('never reaps the directory this session is writing to', async () => {
    const ref = await spill('grep', 'still needed');
    const swept = await sweepStaleSpills(tmpdir());
    expect(swept).not.toContain(dirname(ref!.path));
    expect(await readFile(ref!.path, 'utf8')).toBe('still needed');
  });

  it('stamps the owning pid inside the directory it creates', async () => {
    const ref = await spill('grep', 'x');
    const stamp = join(dirname(ref!.path), '.pid');
    expect(Number((await readFile(stamp, 'utf8')).trim())).toBe(process.pid);
    expect((await stat(stamp)).mode & 0o777).toBe(0o600);
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
