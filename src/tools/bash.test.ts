import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashTool, execStream, readOnlyBashTool, TailWindow } from './bash.js';
import { READ_ONLY_COMMAND_LIST } from './_readonly.js';
import { planTools } from './index.js';
import { resetSpillDir } from './_spill.js';

describe('execStream — timeout', () => {
  it('honors a custom timeout and reports the duration that fired', async () => {
    const result = await execStream('sleep 5', { cwd: process.cwd() }, 50);
    expect(result.summary).toMatch(/Bash timeout: sleep 5 \(killed after 0\.05s\)/);
  });

  it('runs normally when the command finishes within the timeout', async () => {
    const result = await execStream('echo hi', { cwd: process.cwd() }, 5000);
    expect(result.summary).toMatch(/^Ran: echo hi/);
    expect(result.payload).toContain('hi');
  });
});

describe('execStream — exit status', () => {
  const cwd = process.cwd();

  it('reports a clean run with no status slot at all', async () => {
    const result = await execStream('echo hi', { cwd });
    expect(result.summary).toBe('Ran: echo hi (3 bytes output)');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a non-zero exit without calling it a failure', async () => {
    const result = await execStream('echo hello; exit 3', { cwd });
    expect(result.summary).toBe('Ran: echo hello; exit 3 (exit 3, 6 bytes output)');
    expect(result.exitCode).toBe(3);
    expect(result.summary).not.toContain('failed');
  });

  it('keeps the output alongside the status, so a red test run is still readable', async () => {
    const result = await execStream('echo "2 tests failed"; exit 1', { cwd });
    expect(result.summary).toMatch(/^Ran: .* \(exit 1, \d+ bytes output\)$/);
    expect(result.payload).toContain('2 tests failed');
  });

  it('does not treat grep-with-no-match as a failure', async () => {
    const result = await execStream('echo abc | grep zzz', { cwd });
    expect(result.summary).toMatch(/^Ran: /);
    expect(result.exitCode).toBe(1);
  });

  it('names the signal when one killed the process, and reports no numeric code', async () => {
    const result = await execStream('kill -TERM $$', { cwd });
    expect(result.summary).toBe('Ran: kill -TERM $$ (killed by SIGTERM, 0 bytes output)');
    // null, not undefined: a signal death is a status we know, not a status we lack. Consumers
    // distinguish the two — see plantrack.ranSuccessfully.
    expect(result.exitCode).toBeNull();
  });

  it('still calls a timeout a timeout, not a plain run', async () => {
    const result = await execStream('sleep 5', { cwd }, 50);
    expect(result.summary).toMatch(/^Bash timeout: /);
    expect(result.summary).not.toContain('Ran: ');
  });

  it('still calls a spawn error a failure, and reports no status', async () => {
    // The shell itself starts fine here, so drive the error path through a cwd that does not exist:
    // spawn rejects before any process runs, which is the case `Bash failed:` is actually for.
    const result = await execStream('echo hi', { cwd: '/nonexistent-reika-dir' });
    expect(result.summary).toMatch(/^Bash failed: /);
    expect(result.exitCode).toBeUndefined();
  });
});

describe('TailWindow', () => {
  it('keeps everything while under the budget', () => {
    const w = new TailWindow(100);
    w.push('abc');
    w.push('def');
    expect(w.text()).toBe('abcdef');
    expect(w.bytes).toBe(6);
  });

  it('drops from the front once over budget, keeping the end', () => {
    const w = new TailWindow(10);
    for (const c of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd']) w.push(c);
    // Trimming stops while the window would still hold 10 bytes without its front chunk, so the
    // last two chunks survive and `bytes` reports what is retained, not what was seen.
    expect(w.text()).toBe('cccccddddd');
    expect(w.bytes).toBe(10);
  });

  it('never drops the only chunk it has, however big', () => {
    const w = new TailWindow(4);
    w.push('a'.repeat(50));
    expect(w.text()).toHaveLength(50);
    expect(w.bytes).toBe(50);
  });
});

describe('execStream — spill', () => {
  const spillDirs: string[] = [];
  const cwd = process.cwd();
  // ~109KB of output, comfortably past the 64KB payload cap, with a unique last line.
  const BIG = 'seq 1 20000';

  beforeEach(() => {
    resetSpillDir();
    process.env.REIKA_SPILL = '1';
  });

  afterEach(async () => {
    delete process.env.REIKA_SPILL;
    resetSpillDir();
    for (const d of spillDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const locatorOf = (payload: string): string | undefined => {
    const hit = /saved to (\S+\.txt)/.exec(payload)?.[1];
    if (hit) spillDirs.push(dirname(hit));
    return hit;
  };

  it('saves the tail the payload cap drops, and points at it', async () => {
    const result = await execStream(BIG, { cwd });
    const payload = result.payload ?? '';

    // The payload is unchanged: still the head, still capped, still marked truncated.
    expect(payload.startsWith('1\n2\n')).toBe(true);
    expect(payload).toContain('…(truncated)');
    expect(payload).not.toContain('\n20000\n');

    const locator = locatorOf(payload);
    expect(locator).toBeTruthy();
    expect(payload).toContain('Full output saved to');
    expect(payload).toContain('Do not re-run this command to see the rest.');

    // The file holds the whole run — including the last line, which existed nowhere before.
    const saved = await readFile(locator!, 'utf8');
    expect(saved.startsWith('1\n')).toBe(true);
    expect(saved.trimEnd().endsWith('\n20000')).toBe(true);

    // The summary reports the true size now that we know it, not the 65536 it stopped counting at.
    const reported = Number(/\((\d+) bytes output\)/.exec(result.summary)![1]);
    expect(reported).toBe(saved.length);
    expect(reported).toBeGreaterThan(100_000);
  });

  it('says so honestly when the window itself dropped the middle', async () => {
    // ~4.7MB, past the 4MB window, so the head is in the payload and the tail in the file with a
    // gap between — the one case where calling the file the "full output" would be a lie.
    const result = await execStream('seq 1 700000', { cwd });
    const payload = result.payload ?? '';
    const locator = locatorOf(payload);
    expect(locator).toBeTruthy();

    expect(payload).toContain('(the middle was dropped)');
    expect(payload).toContain('The output above is the start of the run; the file holds the end.');
    expect(payload).not.toContain('Full output saved to');

    const saved = await readFile(locator!, 'utf8');
    expect(saved.startsWith('1\n')).toBe(false);
    expect(saved.trimEnd().endsWith('\n700000')).toBe(true);
    expect(saved.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it('writes nothing when the output fits in the payload', async () => {
    const result = await execStream('echo small', { cwd });
    expect(result.payload).toContain('small');
    expect(result.payload).not.toContain('saved to');
  });

  it('leaves the payload identical when the flag is off — only the footer differs', async () => {
    const on = await execStream(BIG, { cwd });
    locatorOf(on.payload ?? '');
    process.env.REIKA_SPILL = '0';
    const off = await execStream(BIG, { cwd });

    expect(off.payload).not.toContain('saved to');
    // The head both runs show is the same; the spill run adds a footer after it.
    const head = (p: string): string => p.slice(0, p.indexOf('…(truncated)'));
    expect(head(on.payload ?? '')).toBe(head(off.payload ?? ''));
    // The summary reports the command's real output size either way. It used to say 65536 with
    // the flag off — the payload cap, not the output — which was a false claim about the run.
    expect(off.summary).toBe(on.summary);
    expect(off.summary).toMatch(/\(108894 bytes output\)/);
  });
});

describe('execStream — command chip', () => {
  const cwd = process.cwd();

  it('shows the end of a truncated run, not the end of the payload head', async () => {
    process.env.REIKA_SPILL = '0';
    const result = await execStream('seq 1 20000', { cwd });
    const chip = result.command!;

    expect(chip.outputTail.trimEnd().endsWith('20000')).toBe(true);
    expect(chip.outputTruncated).toBe(true);
    // The payload still holds the head — the two channels now legitimately disagree, which is the
    // whole point: the model gets the start (plus a locator), the user gets the end.
    expect(result.payload).not.toContain('\n20000');
  });

  it('shows short output whole, with no omission marker', async () => {
    const result = await execStream('printf "a\\nb\\nc\\n"', { cwd });
    expect(result.command!.outputTail).toBe('a\nb\nc\n');
    expect(result.command!.outputTruncated).toBe(false);
  });

  it('marks omission when more lines ran than the chip shows, even under the byte cap', async () => {
    const result = await execStream('seq 1 50', { cwd });
    const chip = result.command!;
    expect(chip.outputTail.trimEnd().endsWith('50')).toBe(true);
    // 9, not 10: output ends with a newline, so the empty string after it takes one of the ten
    // slots. Pre-existing cosmetic behavior of the line slice, pinned here rather than changed.
    expect(chip.outputTail.split('\n').filter(Boolean)).toHaveLength(9);
    expect(chip.outputTruncated).toBe(true);
  });
});

describe('readOnlyBashTool — plan mode (#109)', () => {
  const ctx = { cwd: process.cwd() };

  it('runs a command that is provably read-only', async () => {
    const result = await readOnlyBashTool.run({ command: 'echo hello | wc -c' }, ctx);
    expect(result.summary).toMatch(/^Ran:/);
    expect(result.payload).toContain('6');
  });

  it('refuses a command that can write, and says why and what to do instead', async () => {
    const result = await readOnlyBashTool.run({ command: 'rm -rf dist' }, ctx);
    expect(result.summary).toContain('Bash refused (read-only mode)');
    expect(result.summary).toContain('rm -rf dist');
    expect(result.summary).toContain('read/grep/glob/list');
  });

  it('does not run the refused command', async () => {
    const path = join(tmpdir(), `reika-readonly-${Date.now()}.txt`);
    await writeFile(path, 'untouched');
    await readOnlyBashTool.run({ command: `echo clobbered > ${path}` }, ctx);
    expect(await readFile(path, 'utf8')).toBe('untouched');
    await rm(path, { force: true });
  });

  it('names the enforced allowlist rather than a restated copy of it', () => {
    expect(readOnlyBashTool.description).toContain(READ_ONLY_COMMAND_LIST);
  });

  // The refusal states the rule, not the roster. A refused model retries, and the allowlist already
  // rides every request in the tool description — restating it per refusal would spend ~100 tokens a
  // round re-teaching what the model can already see, on the small windows this project targets.
  it('keeps the refusal terse: no second copy of the allowlist', async () => {
    const result = await readOnlyBashTool.run({ command: 'rm -rf dist' }, ctx);
    expect(result.summary).not.toContain(READ_ONLY_COMMAND_LIST);
    expect(result.summary.length).toBeLessThan(200);
  });

  it('reports an empty command as empty, not as refused', async () => {
    const result = await readOnlyBashTool.run({ command: '   ' }, ctx);
    expect(result.summary).toBe('Bash failed: empty command');
  });

  it('keeps the bash name so the model needs no second dialect', () => {
    expect(readOnlyBashTool.name).toBe('bash');
  });

  // The approval decision, asserted rather than left to emerge from _danger.ts happening to return
  // no warnings. `off` is documented as "confirm every MUTATING action", the classifier has just
  // proved this command mutates nothing, and plan mode's other four tools read arbitrary paths with
  // no prompt — so gating this one on a modal would be incoherent, not safer. Flipping the decision
  // means deleting the `requestApproval: undefined` line in bash.ts, which fails this test first.
  it('does not prompt for a command it proved read-only, even with approvals wired', async () => {
    let asked = 0;
    const result = await readOnlyBashTool.run(
      { command: 'echo hello' },
      {
        ...ctx,
        requestApproval: async () => {
          asked++;
          return true;
        },
      },
    );
    expect(asked).toBe(0);
    expect(result.summary).toMatch(/^Ran:/);
  });

  // A refusal must never reach the approval prompt either: asking the user to authorize a command
  // that is about to be thrown away is pure noise, and it would put `rm -rf dist` in a modal that
  // implies it might run.
  it('never prompts for a refused command', async () => {
    let asked = 0;
    const result = await readOnlyBashTool.run(
      { command: 'rm -rf dist' },
      {
        ...ctx,
        requestApproval: async () => {
          asked++;
          return true;
        },
      },
    );
    expect(asked).toBe(0);
    expect(result.summary).toContain('Bash refused (read-only mode)');
  });

  // The unrestricted bash still prompts — the exemption is scoped to the proven-read-only tool, not
  // leaked into the tool it spreads.
  it('leaves the ordinary bash tool prompting as before', async () => {
    let asked = 0;
    await bashTool.run(
      { command: 'echo hello' },
      {
        ...ctx,
        requestApproval: async () => {
          asked++;
          return false;
        },
      },
    );
    expect(asked).toBe(1);
  });
});

describe('planTools — REIKA_PLAN_BASH gate', () => {
  afterEach(() => {
    delete process.env.REIKA_PLAN_BASH;
  });

  it('omits bash by default', () => {
    delete process.env.REIKA_PLAN_BASH;
    expect(planTools().map(t => t.name)).not.toContain('bash');
  });

  it('adds the read-only bash under the flag', () => {
    process.env.REIKA_PLAN_BASH = '1';
    const bash = planTools().find(t => t.name === 'bash');
    expect(bash).toBe(readOnlyBashTool);
  });

  it('never adds the unrestricted bash', () => {
    process.env.REIKA_PLAN_BASH = '1';
    expect(planTools()).not.toContain(bashTool);
  });
});
