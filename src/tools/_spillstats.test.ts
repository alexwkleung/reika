import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordCapped, recordFollowed, spillStatsEnabled } from './_spillstats.js';
import { execStream } from './bash.js';
import { referencesSpill, resetSpillDir, spillResult } from './_spill.js';
import { grepTool } from './grep.js';
import ignore from 'ignore';
import { mkdir, writeFile } from 'node:fs/promises';

let dir: string;
let file: string;
const savedTmpdir = process.env.TMPDIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reika-stats-'));
  file = join(dir, 'stats.jsonl');
  process.env.REIKA_SPILL_STATS = '1';
  process.env.REIKA_SPILL_STATS_FILE = file;
  resetSpillDir();
});

afterEach(async () => {
  delete process.env.REIKA_SPILL_STATS;
  delete process.env.REIKA_SPILL_STATS_FILE;
  delete process.env.REIKA_SPILL;
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  resetSpillDir();
  await rm(dir, { recursive: true, force: true });
});

// Point the spill at a directory that cannot be created, so `spillResult` fails the way a full
// disk or a read-only tmpdir would. `resetSpillDir` matters: the process-wide directory is cached
// after the first successful spill, and a cached one would succeed regardless of TMPDIR.
function breakSpillTarget(): void {
  process.env.TMPDIR = join(dir, 'does', 'not', 'exist');
  resetSpillDir();
}

const lines = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);

describe('spill stats', () => {
  it('is a strict no-op when the flag is off', async () => {
    delete process.env.REIKA_SPILL_STATS;
    expect(spillStatsEnabled()).toBe(false);
    recordCapped({ tool: 'bash', total: 1, shown: 1, spilled: false });
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('appends one timestamped line per event rather than a running tally', async () => {
    recordCapped({ tool: 'grep', total: 420, shown: 100, spilled: true });
    recordFollowed({ by: 'read' });
    const out = await lines();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ event: 'capped', tool: 'grep', total: 420, shown: 100 });
    expect(out[1]).toMatchObject({ event: 'followed', by: 'read' });
    // The distribution is the point — every line carries its own size and time.
    expect(typeof out[0].ts).toBe('string');
  });

  // The measurement has to see over-cap runs whether or not spilling is on, because what it
  // answers is a property of the workload: how often bash output blows past 64KB at all.
  it('records a capped bash run with REIKA_SPILL off', async () => {
    process.env.REIKA_SPILL = '0';
    await execStream('seq 1 20000', { cwd: process.cwd() });
    const out = await lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: 'capped', tool: 'bash', shown: 65536, spilled: false });
    expect(out[0].total).toBe(108894);
    // Nothing was retained, so completeness is not a claim this run can make.
    expect(out[0].complete).toBeUndefined();
  });

  it('records whether the retained window held the whole run when spilling', async () => {
    process.env.REIKA_SPILL = '1';
    await execStream('seq 1 20000', { cwd: process.cwd() });
    const out = await lines();
    expect(out[0]).toMatchObject({ event: 'capped', tool: 'bash', spilled: true, complete: true });
  });

  // `spilled` is the field that says an artifact exists to be followed. Reporting it optimistically
  // would hide the one outcome the stats are meant to expose: over-cap results whose bytes were
  // lost because the write failed.
  it('records a bash spill that failed to write as not spilled', async () => {
    process.env.REIKA_SPILL = '1';
    breakSpillTarget();
    const result = await execStream('seq 1 20000', { cwd: process.cwd() });
    expect(result.payload).toContain('could not be saved');
    const out = await lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: 'capped', tool: 'bash', spilled: false });
    // Nothing was saved, so the retained window's completeness is not a claim this run can make.
    expect(out[0].complete).toBeUndefined();
  });

  it('records a grep spill that failed to write as not spilled', async () => {
    process.env.REIKA_SPILL = '1';
    const cwd = join(dir, 'repo');
    await mkdir(cwd, { recursive: true });
    // Over the 100-match inline cap, so the result is capped and a spill is attempted. Matches are
    // padded apart so each is its own context block — adjacent ones merge into one range and the
    // page never fills.
    await writeFile(
      join(cwd, 'many.txt'),
      'needle\npad\npad\npad\npad\npad\npad\n'.repeat(150),
      'utf8',
    );
    breakSpillTarget();
    const result = await grepTool.run({ pattern: 'needle' }, { cwd, ignore: ignore() });
    expect(result.payload).toContain('could not be saved');
    const out = await lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ event: 'capped', tool: 'grep', spilled: false });
  });

  it('writes nothing for a run that fits under the cap', async () => {
    await execStream('echo small', { cwd: process.cwd() });
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});

describe('referencesSpill', () => {
  it('matches a handed-out locator anywhere in a string, not just as a whole arg', async () => {
    process.env.REIKA_SPILL = '1';
    const ref = await spillResult('grep', 'x');
    expect(referencesSpill(ref!.path)).toBe(true);
    // How the model actually reaches for it more than half the time.
    expect(referencesSpill(`tail -50 ${ref!.path}`)).toBe(true);
    expect(referencesSpill('src/agent/loop.ts')).toBe(false);
  });
});
