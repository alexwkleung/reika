import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bashTool,
  decideSandbox,
  execStream,
  readOnlyBashTool,
  sandboxNoticed,
  TailWindow,
} from './bash.js';
import { detectDangerousPatterns } from './_danger.js';
import { READ_ONLY_COMMAND_LIST } from './_readonly.js';
import { planTools } from './index.js';
import { resetSpillDir } from './_spill.js';

describe('execStream — timeout', () => {
  const cwd = process.cwd();

  it('honors a custom timeout and reports the duration that fired', async () => {
    const result = await execStream('sleep 5', { cwd, bashTimeoutMs: 50 });
    expect(result.summary).toMatch(/Bash timeout: sleep 5 \(killed after 0\.05s\)/);
    expect(result.payload).toContain('killed: hit the 0.05s ceiling');
  });

  it('runs normally when the command finishes within the timeout', async () => {
    const result = await execStream('echo hi', { cwd, bashTimeoutMs: 5000 });
    expect(result.summary).toMatch(/^Ran: echo hi/);
    expect(result.payload).toContain('hi');
  });

  // The ceiling has to bound the whole pipeline, not just `sh` (#408). Killing only the shell
  // orphaned the rest of a compound command holding our stdout pipe, so 'close' waited on it and
  // `sleep 5; echo` ran its full five seconds after a 50ms "kill".
  it('bounds a compound command, not just the shell in front of it', async () => {
    const t0 = Date.now();
    const result = await execStream('sleep 5; echo done', { cwd, bashTimeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.summary).toMatch(/^Bash timeout: /);
    expect(result.payload).not.toContain('done');
  });

  it('kills a command that goes silent, and says that is why', async () => {
    const result = await execStream('echo start; sleep 5', {
      cwd,
      bashTimeoutMs: 10_000,
      bashIdleMs: 100,
    });
    expect(result.summary).toBe('Bash timeout: echo start; sleep 5 (no output for 0.1s, killed)');
    expect(result.payload).toContain('start');
    expect(result.payload).toContain('Do not re-run it as is');
  });

  it('lets a command that keeps writing run past the idle bound', async () => {
    const result = await execStream('for i in 1 2 3 4 5; do echo $i; sleep 0.05; done', {
      cwd,
      bashTimeoutMs: 10_000,
      bashIdleMs: 150,
    });
    expect(result.summary).toMatch(/^Ran: /);
    expect(result.payload).toContain('5');
  });

  it('disables a bound set to zero', async () => {
    const result = await execStream('sleep 0.2; echo ok', {
      cwd,
      bashTimeoutMs: 0,
      bashIdleMs: 0,
    });
    expect(result.summary).toMatch(/^Ran: /);
    expect(result.payload).toContain('ok');
  });

  it('kills the command on the abort signal instead of waiting out a bound', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    const result = await execStream('sleep 5; echo done', {
      cwd,
      bashTimeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(result.summary).toBe('Bash aborted: sleep 5; echo done (killed by user)');
  });

  it('does not run at all on a signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await execStream('echo ran', { cwd, signal: controller.signal });
    expect(result.summary).toBe('Bash aborted: echo ran (not run)');
    expect(result.payload).toBeUndefined();
  });

  // stdin is /dev/null: a command that reads it gets EOF, where a pipe nobody writes to would
  // have held it until the idle bound.
  it('gives a stdin reader EOF rather than a hang', async () => {
    const result = await execStream('cat', { cwd, bashIdleMs: 2000 });
    expect(result.summary).toBe('Ran: cat (0 bytes output)');
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
    const result = await execStream('sleep 5', { cwd, bashTimeoutMs: 50 });
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

// The composition half of #163: which commands run sandboxed is decided by the danger scan and the
// presence of an approval gate, so the cells are pinned on the pure decision — deterministic on every
// platform — and one darwin-only run pins that the decision reaches a real process.
describe('bashTool — sandbox composition', () => {
  const approve = async (): Promise<boolean> => true;

  it('sandboxes a clean command, auto-approved (safe) or with no gate at all (bypass)', () => {
    // No requestApproval is what bypass looks like. Before the scan was hoisted out of
    // `if (ctx.requestApproval)` it never ran here, so a sandbox keyed on it covered nothing in
    // exactly the autonomous configuration the issue is about.
    expect(decideSandbox('echo clean', [], { requestApproval: approve })).toEqual({
      network: false,
    });
    expect(decideSandbox('echo clean', [], {})).toEqual({ network: false });
  });

  it('leaves a flagged command unsandboxed only when a gate stood in front of it', () => {
    const warnings = detectDangerousPatterns('git push origin main');
    expect(warnings.length).toBeGreaterThan(0);
    expect(
      decideSandbox('git push origin main', warnings, { requestApproval: approve }),
    ).toBeUndefined();
    // Bypass: flagged, but nobody looked — sandboxed like everything else.
    expect(decideSandbox('git push origin main', warnings, {})).toEqual({ network: false });
  });

  it('keeps network for an unflagged gh/git read, denies it otherwise', () => {
    expect(decideSandbox('gh pr view 436', [], {})).toEqual({ network: true });
    expect(decideSandbox("gh pr diff 436 | sed -n '1,300p'", [], {})).toEqual({ network: true });
    expect(decideSandbox('npm test', [], {})).toEqual({ network: false });
  });

  it('is a no-op under REIKA_SANDBOX=0', () => {
    expect(decideSandbox('echo clean', [], { sandbox: false })).toBeUndefined();
  });

  it('does not run a flagged command at all when the user declines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-sandbox-'));
    try {
      const r = await bashTool.run(
        { command: 'npm install && touch ran.txt' },
        { cwd: dir, requestApproval: async () => false },
      );
      expect(r.summary).toContain('declined by user');
      await expect(readFile(join(dir, 'ran.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The receipt is once per cwd (the confinement is a session property, and a line under every chip
  // doubled the scrollback), and the write lands because WORKDIR is the realpath'd cwd — the
  // /tmp -> /private/tmp trap that made every create fail.
  it.skipIf(process.platform !== 'darwin')(
    'runs a clean command sandboxed, says so once per cwd, and can still write inside it',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bash-sandbox-'));
      try {
        sandboxNoticed.delete(dir);
        const first = await bashTool.run(
          { command: 'mkdir -p sub && echo x > sub/f.txt' },
          { cwd: dir },
        );
        expect(first.notice?.content).toContain('Shell commands run sandboxed');
        expect(await readFile(join(dir, 'sub', 'f.txt'), 'utf8')).toBe('x\n');
        const second = await bashTool.run({ command: 'echo y > sub/g.txt' }, { cwd: dir });
        expect(second.notice?.content ?? '').not.toContain('sandboxed');
        // Temp is writable now, so "outside" has to be somewhere else — home.
        const outside = join(homedir(), 'reika-bash-test-should-not-exist.txt');
        const third = await bashTool.run({ command: `echo x > ${outside}` }, { cwd: dir });
        expect(third.payload).toContain('Operation not permitted');
        await expect(readFile(outside, 'utf8')).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  // The scratchpad workflow — `mktemp -d`, write, `rm -rf` — is the commonest thing a model does
  // outside cwd, and denying temp made python's mkdtemp fall through to cwd and write scratch into
  // the project. Real paths matter here: `/tmp` → `/private/tmp`, `$TMPDIR` → `/private/var/…`.
  it.skipIf(process.platform !== 'darwin')(
    'lets a sandboxed command scratch in temp dirs, still not elsewhere in $HOME',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bash-sandbox-'));
      try {
        const r = await bashTool.run(
          {
            command:
              'd=$(mktemp -d) && echo hi > "$d/f" && cat "$d/f" && rm -rf "$d" && ' +
              'echo x > /tmp/reika-sandbox-test-$$ && rm /tmp/reika-sandbox-test-$$ && echo tmp-ok',
          },
          { cwd: dir },
        );
        expect(r.exitCode).toBe(0);
        expect(r.payload).toContain('tmp-ok');
        const home = join(homedir(), 'reika-sandbox-test-should-not-exist');
        const denied = await bashTool.run({ command: `echo x > ${home}` }, { cwd: dir });
        expect(denied.payload).toContain('Operation not permitted');
        await expect(readFile(home, 'utf8')).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  // Loopback stays open under the network deny, bind and connect both: a test suite that starts a
  // local server (this repo's transport.test.ts does) used to go red with EPERM on `listen(0)` and
  // then collect the network footer blaming the sandbox for the whole run.
  it.skipIf(process.platform !== 'darwin')(
    'lets a sandboxed command bind and reach a loopback port',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bash-sandbox-'));
      try {
        const script =
          'const http=require("http");const s=http.createServer((q,r)=>r.end("pong")).listen(0,"127.0.0.1",()=>{' +
          'http.get({host:"127.0.0.1",port:s.address().port},res=>{let b="";res.on("data",d=>b+=d);' +
          'res.on("end",()=>{console.log("got",b);s.close()})}).on("error",e=>{console.log("err",e.code);s.close()})})';
        const r = await bashTool.run({ command: `node -e '${script}'` }, { cwd: dir });
        expect(r.exitCode).toBe(0);
        expect(r.payload).toContain('got pong');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

// A shell edit gets the visual receipt the edit tool gives (#278). The detector is tested in
// _treediff.test.ts; this checks bash brackets its run with it and stays silent outside a repo.
describe('bashTool — tree changes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bash-changes-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('attaches the diff of what the command changed in a git repo', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await writeFile(join(dir, 'x.txt'), 'a\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', 'commit', '-qm', 'i'],
      {
        cwd: dir,
      },
    );
    const result = await bashTool.run({ command: 'echo b >> x.txt' }, { cwd: dir });
    expect(result.summary).toMatch(/^Ran: /);
    expect(result.changes?.files.map(f => f.path)).toEqual(['x.txt']);
    expect(result.changes?.files[0].hunks[0].text).toBe('  a\n+ b');
  });

  it('carries no changes field when nothing changed', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const result = await bashTool.run({ command: 'echo hi' }, { cwd: dir });
    expect(result.summary).toMatch(/^Ran: /);
    expect(result).not.toHaveProperty('changes');
  });

  // No repo: the diff is a best shot over the files the command names, and the user is told so —
  // once per cwd, as a user-facing notice, never in the model's context.
  it('without a repo, diffs the named file and says once that coverage is narrower', async () => {
    await writeFile(join(dir, 'x.txt'), 'a\n');
    const first = await bashTool.run({ command: 'echo b >> x.txt' }, { cwd: dir });
    expect(first.changes?.files[0].hunks[0].text).toBe('  a\n+ b');
    // Matched on content, not on presence: the first sandboxed command in a cwd carries the sandbox
    // receipt (#163) on this platform, so "has no notice" would be a claim about the machine rather
    // than about the once-per-cwd rule this test is about.
    const notRepo = first.notice?.content ?? '';
    expect(notRepo).toContain('Not a git repo');
    expect(first.notice?.tone).toBe('info');
    expect(first.payload).not.toContain('git repo');
    const second = await bashTool.run({ command: 'echo c >> x.txt' }, { cwd: dir });
    expect(second.changes?.files[0].hunks[0].text).toBe('  a\n  b\n+ c');
    expect(second.notice?.content ?? '').not.toContain('Not a git repo');
  });
});

describe('planTools — REIKA_PLAN_BASH gate', () => {
  afterEach(() => {
    delete process.env.REIKA_PLAN_BASH;
  });

  it('adds the read-only bash by default', () => {
    delete process.env.REIKA_PLAN_BASH;
    const bash = planTools().find(t => t.name === 'bash');
    expect(bash).toBe(readOnlyBashTool);
  });

  it('omits bash under =0', () => {
    process.env.REIKA_PLAN_BASH = '0';
    expect(planTools().map(t => t.name)).not.toContain('bash');
  });

  it('never adds the unrestricted bash', () => {
    delete process.env.REIKA_PLAN_BASH;
    expect(planTools()).not.toContain(bashTool);
  });
});
