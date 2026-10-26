import { spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxExecAvailable, sandboxPlan, sandboxProfile } from '../tools/_sandbox.js';
import {
  type CheckOutcome,
  type Diagnostic,
  decideTypecheckGate,
  detectTsProject,
  diagnosticKey,
  formatIntroduced,
  introducedDiagnostics,
  parseTscOutput,
  runTypecheck,
  runTscProcess,
  sandboxRefused,
  shellQuote,
  stopTypecheckReport,
} from './typecheck.js';

function diag(over: Partial<Diagnostic> = {}): Diagnostic {
  return {
    file: 'src/a.ts',
    line: 1,
    col: 1,
    severity: 'error',
    code: 'TS2322',
    message: "Type 'string' is not assignable to type 'number'.",
    ...over,
  };
}

describe('parseTscOutput', () => {
  it('parses the non-pretty one-line diagnostic format', () => {
    const raw = `src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`;
    expect(parseTscOutput(raw)).toEqual([
      {
        file: 'src/a.ts',
        line: 12,
        col: 5,
        severity: 'error',
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
  });

  it('parses warnings and multiple diagnostics, ignoring non-diagnostic lines', () => {
    const raw = [
      `src/a.ts(1,1): error TS2304: Cannot find name 'foo'.`,
      `  some indented continuation that is not a diagnostic`,
      ``,
      `src/b.ts(9,3): warning TS6133: 'x' is declared but its value is never read.`,
      `Found 2 errors in 2 files.`,
    ].join('\n');
    const got = parseTscOutput(raw);
    expect(got).toHaveLength(2);
    expect(got[0].code).toBe('TS2304');
    expect(got[1].severity).toBe('warning');
  });

  it('tolerates CRLF line endings', () => {
    const raw = `src/a.ts(1,1): error TS2304: Cannot find name 'foo'.\r\nsrc/b.ts(2,2): error TS2304: Cannot find name 'bar'.\r\n`;
    expect(parseTscOutput(raw)).toHaveLength(2);
  });

  it('returns nothing for clean output', () => {
    expect(parseTscOutput('')).toEqual([]);
    expect(parseTscOutput('\n\n')).toEqual([]);
  });
});

describe('diagnosticKey', () => {
  it('ignores line and column so a line shift does not change identity', () => {
    const a = diag({ line: 10, col: 4 });
    const b = diag({ line: 42, col: 9 });
    expect(diagnosticKey(a)).toBe(diagnosticKey(b));
  });

  it('distinguishes by file, code, and message', () => {
    expect(diagnosticKey(diag({ file: 'src/a.ts' }))).not.toBe(
      diagnosticKey(diag({ file: 'src/b.ts' })),
    );
    expect(diagnosticKey(diag({ code: 'TS2322' }))).not.toBe(
      diagnosticKey(diag({ code: 'TS2345' })),
    );
    expect(diagnosticKey(diag({ message: 'a' }))).not.toBe(diagnosticKey(diag({ message: 'b' })));
  });
});

describe('introducedDiagnostics', () => {
  it('returns only errors absent from the baseline', () => {
    const baseline = [diag({ file: 'src/old.ts', message: 'pre-existing' })];
    const current = [
      diag({ file: 'src/old.ts', message: 'pre-existing' }),
      diag({ file: 'src/new.ts', message: 'fresh breakage' }),
    ];
    const got = introducedDiagnostics(baseline, current);
    expect(got).toHaveLength(1);
    expect(got[0].file).toBe('src/new.ts');
  });

  it('does not flag a pre-existing error whose line shifted after the edit', () => {
    // Same error, moved down 20 lines because the edit inserted code above it.
    const baseline = [diag({ file: 'src/x.ts', line: 5 })];
    const current = [diag({ file: 'src/x.ts', line: 25 })];
    expect(introducedDiagnostics(baseline, current)).toEqual([]);
  });

  it('cancels a systematic error present in both sets', () => {
    const noise = diag({ file: 'tsconfig.json', code: 'TS18003', message: 'No inputs were found' });
    expect(introducedDiagnostics([noise], [noise])).toEqual([]);
  });

  it('treats everything as introduced when the baseline is empty', () => {
    const current = [diag(), diag({ file: 'src/b.ts' })];
    expect(introducedDiagnostics([], current)).toHaveLength(2);
  });
});

describe('formatIntroduced', () => {
  it('returns the empty string for no diagnostics', () => {
    expect(formatIntroduced([])).toBe('');
  });

  it('renders a header and one compact line per error', () => {
    const block = formatIntroduced([diag({ file: 'src/a.ts', line: 12, col: 5 })]);
    expect(block).toContain('introduced 1 new type error');
    expect(block).toContain('src/a.ts:12:5 TS2322:');
  });

  it('pluralizes and caps the list, reporting the remainder', () => {
    const many = Array.from({ length: 14 }, (_, i) => diag({ file: `src/f${i}.ts` }));
    const block = formatIntroduced(many, 10);
    expect(block).toContain('introduced 14 new type errors');
    expect(block).toContain('… +4 more');
    // header + 10 shown + the "+N more" line
    expect(block.split('\n')).toHaveLength(12);
  });

  it('truncates an overlong message', () => {
    const block = formatIntroduced([diag({ message: 'x'.repeat(500) })]);
    expect(block).toContain('…');
    expect(block.length).toBeLessThan(300);
  });
});

describe('stopTypecheckReport (#830)', () => {
  it('quotes the first two introduced errors and counts the rest', () => {
    const final: CheckOutcome = {
      ran: true,
      diagnostics: [
        diag({ file: 'src/a.ts', line: 3 }),
        diag({ file: 'src/b.ts', line: 7, code: 'TS2554', message: 'Expected 3 arguments.' }),
        diag({ file: 'src/c.ts', message: 'Cannot find name x.' }),
      ],
    };
    const r = stopTypecheckReport([], final);
    expect(r.tone).toBe('warn');
    expect(r.addendum).toContain('introduced 3 new type errors');
    expect(r.addendum).toContain('`src/a.ts:3 TS2322');
    expect(r.addendum).toContain('`src/b.ts:7 TS2554: Expected 3 arguments.`');
    expect(r.addendum).toContain('+1 more');
    expect(r.addendum).not.toContain('src/c.ts');
  });

  it('ignores errors the baseline already had', () => {
    const old = diag();
    expect(stopTypecheckReport([old], { ran: true, diagnostics: [old] })).toEqual({
      tone: 'info',
      userNotice: 'Typecheck passed — no new type errors from your edits.',
    });
  });

  it('reports nothing when the check did not run', () => {
    expect(stopTypecheckReport([], { ran: false, reason: 'no tsc' })).toEqual({});
  });
});

describe('decideTypecheckGate', () => {
  const ran = (diagnostics: Diagnostic[]): CheckOutcome => ({ ran: true, diagnostics });

  it('fails open and finishes when the final check could not run', () => {
    const d = decideTypecheckGate({
      baseline: [],
      final: { ran: false, reason: 'no local tsc binary' },
      gateRounds: 0,
      maxRounds: 2,
    });
    expect(d).toEqual({ action: 'finish' });
  });

  it('finishes cleanly when the edit introduced no new errors', () => {
    const pre = diag({ message: 'pre-existing' });
    const d = decideTypecheckGate({
      baseline: [pre],
      final: ran([pre]),
      gateRounds: 0,
      maxRounds: 2,
    });
    expect(d).toEqual({ action: 'finish' });
  });

  it('retries with the introduced errors when under the cap', () => {
    const d = decideTypecheckGate({
      baseline: [],
      final: ran([diag({ file: 'src/new.ts', message: 'broke it' })]),
      gateRounds: 0,
      maxRounds: 2,
    });
    expect(d.action).toBe('retry');
    if (d.action === 'retry') {
      expect(d.modelMessage).toContain('broke it');
      expect(d.userNotice).toContain('1 new type error');
    }
  });

  it('finishes dirty with a notice once the cap is reached', () => {
    const d = decideTypecheckGate({
      baseline: [],
      final: ran([diag({ message: 'still broken' })]),
      gateRounds: 2,
      maxRounds: 2,
    });
    expect(d.action).toBe('finish');
    if (d.action === 'finish') {
      expect(d.userNotice).toContain('still unresolved after 2 attempts');
    }
  });
});

describe('detectTsProject', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-check-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('finds a tsconfig.json at the project root', async () => {
    await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8');
    expect(await detectTsProject(cwd)).toBe(join(cwd, 'tsconfig.json'));
  });

  it('returns null when there is no tsconfig.json', async () => {
    expect(await detectTsProject(cwd)).toBeNull();
  });

  it('walks up from the edited file to the nearest ancestor tsconfig.json', async () => {
    // Monorepo shape: no root tsconfig, one inside the package being edited.
    const pkgDir = join(cwd, 'packages', 'web');
    await mkdir(join(pkgDir, 'src'), { recursive: true });
    await writeFile(join(pkgDir, 'tsconfig.json'), '{}', 'utf8');
    expect(await detectTsProject(cwd, 'packages/web/src/foo.ts')).toBe(
      join(pkgDir, 'tsconfig.json'),
    );
  });

  it('prefers the nearest tsconfig.json when several are ancestors', async () => {
    const pkgDir = join(cwd, 'packages', 'web');
    await mkdir(join(pkgDir, 'src'), { recursive: true });
    await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8');
    await writeFile(join(pkgDir, 'tsconfig.json'), '{}', 'utf8');
    expect(await detectTsProject(cwd, 'packages/web/src/foo.ts')).toBe(
      join(pkgDir, 'tsconfig.json'),
    );
  });

  it('is bounded at the project root: never resolves a tsconfig above cwd', async () => {
    // tsconfig lives in the PARENT of the project root; an edit path that escapes upward must not
    // reach it — the walk clamps to the root and finds nothing.
    const root = join(cwd, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8'); // above `root`
    expect(await detectTsProject(root, '../x.ts')).toBeNull();
  });

  it('honors the REIKA_TSCONFIG override when it resolves to a real file', async () => {
    await writeFile(join(cwd, 'tsconfig.web.json'), '{}', 'utf8');
    const prev = process.env.REIKA_TSCONFIG;
    process.env.REIKA_TSCONFIG = 'tsconfig.web.json';
    try {
      // No plain tsconfig.json exists; the override wins.
      expect(await detectTsProject(cwd)).toBe(join(cwd, 'tsconfig.web.json'));
    } finally {
      if (prev === undefined) delete process.env.REIKA_TSCONFIG;
      else process.env.REIKA_TSCONFIG = prev;
    }
  });

  it('falls through to detection when REIKA_TSCONFIG points at a missing file', async () => {
    await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8');
    const prev = process.env.REIKA_TSCONFIG;
    process.env.REIKA_TSCONFIG = 'tsconfig.does-not-exist.json';
    try {
      expect(await detectTsProject(cwd)).toBe(join(cwd, 'tsconfig.json'));
    } finally {
      if (prev === undefined) delete process.env.REIKA_TSCONFIG;
      else process.env.REIKA_TSCONFIG = prev;
    }
  });
});

describe('shellQuote', () => {
  it('wraps every argument in single quotes, empty included', () => {
    expect(shellQuote('tsc')).toBe(`'tsc'`);
    expect(shellQuote('')).toBe(`''`);
    expect(shellQuote('/a b/c.ts')).toBe(`'/a b/c.ts'`);
  });

  it('escapes an embedded single quote so the shell cannot re-parse', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("'")).toBe(`''\\'''`);
  });

  it('keeps shell metacharacters literal', () => {
    const arg = '$(rm -rf /); `reboot` | & > * ? [ ]';
    expect(shellQuote(arg)).toBe(`'${arg}'`);
  });

  it.skipIf(process.platform === 'win32')(
    'round-trips hostile arguments through a real /bin/sh',
    () => {
      const args = [
        'plain',
        'with spaces',
        "it's quoted",
        '$(echo pwned)',
        '`reboot`',
        '*?[]{}',
        'mix \' $ ( ) ; & | < > " \n newline',
      ];
      const line = `printf '%s\\0' ${args.map(shellQuote).join(' ')}`;
      const r = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.split('\0').slice(0, -1)).toEqual(args);
    },
  );
});

describe('sandboxRefused', () => {
  // Measured from a real sandbox-exec that failed before running the command: exit 65 (a profile
  // the OS rejects, an unbound param) or 71 (nested seatbelt), the wrapper's own line on stderr,
  // and no stdout at all.
  const wrapperLine =
    'sandbox-exec: unbound variable: WORKDIR at <input string>, line 1, column 17';

  it('is a refusal when the wrapper exited before running anything', () => {
    expect(sandboxRefused(65, wrapperLine)).toBe(true);
    expect(sandboxRefused(71, 'sandbox-exec: sandbox_apply: Operation not permitted')).toBe(true);
  });

  it('is not a refusal when tsc itself ran, diagnostics or not', () => {
    expect(sandboxRefused(1, 'a.ts(1,7): error TS2322: bad type')).toBe(false);
    expect(sandboxRefused(2, 'error TS5083: Cannot read file')).toBe(false);
    // The wrapper's line buried under real diagnostics: tsc ran after it, so not a refusal.
    expect(sandboxRefused(65, `${wrapperLine}\na.ts(1,7): error TS2322: bad type`)).toBe(false);
  });

  it('is not a refusal on success, a signal, or silence', () => {
    expect(sandboxRefused(0, wrapperLine)).toBe(false);
    expect(sandboxRefused(null, wrapperLine)).toBe(false);
    expect(sandboxRefused(65, '')).toBe(false);
  });
});

const sandboxWorks = sandboxExecAvailable();

describe('runTypecheck — the spawn line', () => {
  let cwd: string;
  beforeEach(async () => {
    // Deliberately hostile path: a space and a single quote, the case bare concatenation into the
    // `/bin/sh -c` line would split in two or let a quote re-parse the rest.
    cwd = await mkdtemp(join(tmpdir(), "reika's typecheck "));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // A fake tsc that records its argv: the failure mode these tests exist for is tsc never
  // starting, or starting with the flags split apart, and either shows up in what it records.
  async function fakeTsc(): Promise<{ bin: string; argvOut: string }> {
    await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8');
    await mkdir(join(cwd, 'node_modules', '.bin'), { recursive: true });
    const bin = join(cwd, 'node_modules', '.bin', 'tsc');
    const argvOut = join(cwd, 'tsc-argv.json');
    await writeFile(
      bin,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\n`,
      'utf8',
    );
    await chmod(bin, 0o755);
    return { bin, argvOut };
  }

  // Exactly one argv element per flag — what a split or re-parsed argument would break.
  async function expectRecordedArgv(argvOut: string, buildInfo: string): Promise<void> {
    expect(JSON.parse(await readFile(argvOut, 'utf8'))).toEqual([
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile',
      buildInfo,
      '--pretty',
      'false',
      '-p',
      join(cwd, 'tsconfig.json'),
    ]);
  }

  it.skipIf(process.platform === 'win32')(
    'reaches the project-local tsc with exactly one argv per element',
    async ctx => {
      // Say which path this proved rather than pass on either: a plan that is unavailable
      // (non-macOS, nested seatbelt) means the fail-open fallback ran, and the next test owns
      // that path.
      const plan = sandboxPlan(cwd, { network: false });
      if (!('args' in plan)) ctx.skip(`sandbox unavailable here (${plan.reason})`);
      const { argvOut } = await fakeTsc();
      const buildInfo = join(cwd, "it's a build.tsbuildinfo");
      const res = await runTypecheck(cwd, { tsBuildInfoFile: buildInfo });
      expect(res.ran).toBe(true);
      await expectRecordedArgv(argvOut, buildInfo);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'the fail-open fallback reaches tsc with exactly one argv per element',
    async ctx => {
      // The mirror of the one above, run only where the plan is unavailable (Linux CI), so the
      // fallback spawn is exercised somewhere rather than by a test that may not have taken it.
      const plan = sandboxPlan(cwd, { network: false });
      if ('args' in plan) ctx.skip('sandbox available — the sandboxed line is covered above');
      const { argvOut } = await fakeTsc();
      const buildInfo = join(cwd, "it's a build.tsbuildinfo");
      const res = await runTypecheck(cwd, { tsBuildInfoFile: buildInfo });
      expect(res.ran).toBe(true);
      await expectRecordedArgv(argvOut, buildInfo);
    },
  );

  it.skipIf(!sandboxWorks)(
    'reads a wrapper that refused to load the profile as a refusal, not a clean check',
    async () => {
      const { bin, argvOut } = await fakeTsc();
      // The real profile with none of its `-D` bindings: an unbound param is the refusal shape the
      // plan-time probe cannot see, and sandbox-exec exits before running anything — the case that
      // resolved "ran clean, zero diagnostics" before it was detected.
      const res = await runTscProcess(
        '/usr/bin/sandbox-exec',
        ['-p', sandboxProfile({ network: false }), '/bin/sh', '-c', shellQuote(bin)],
        cwd,
        30_000,
        undefined,
        true,
      );
      expect(res).toMatchObject({ ran: false });
      if (!res.ran) expect(res.reason).toContain('sandbox wrapper refused');
      // Nothing ran — which is exactly why an undetected refusal masquerades as a clean check.
      await expect(access(argvOut)).rejects.toThrow();
    },
  );
  it.skipIf(!sandboxWorks)(
    'never retries unsandboxed when the confined tsc claims the wrapper refused',
    async () => {
      // A planted tsc can print the wrapper's line and exit 65 as easily as sandbox-exec can. If
      // that bought a retry, the retry would be the unconfined run of the same binary — so it
      // must run exactly once, and the gate is off for the turn rather than reopened.
      const { bin } = await fakeTsc();
      const runs = join(cwd, 'runs.log');
      await writeFile(
        bin,
        `#!/bin/sh\necho run >> ${shellQuote(runs)}\necho 'sandbox-exec: fake refusal' >&2\nexit 65\n`,
        'utf8',
      );
      const res = await runTypecheck(cwd);
      expect(res).toMatchObject({ ran: false });
      expect((await readFile(runs, 'utf8')).trim().split('\n')).toEqual(['run']);
    },
  );

  it.skipIf(!sandboxWorks)(
    'reads a tsc the shell could not execute as not run, not a clean check',
    async () => {
      // Exec bit lost: the direct spawn reports EACCES, but behind `/bin/sh -c` it is exit 126
      // with no tsc output — zero diagnostics, which used to read as green.
      const { bin, argvOut } = await fakeTsc();
      await chmod(bin, 0o644);
      const res = await runTypecheck(cwd);
      expect(res.ran).toBe(false);
      if (!res.ran) expect(res.reason).toContain('exit 126');
      await expect(access(argvOut)).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'spawns tsc directly when the sandbox is switched off',
    async () => {
      // REIKA_SANDBOX=0: a tsc that writes outside the confined paths must keep working, so the
      // wrapper is skipped outright — proved by a write the profile would refuse.
      const { bin, argvOut } = await fakeTsc();
      const outside = await mkdtemp(join(homedir(), '.reika-tc-test-'));
      try {
        const marker = join(outside, 'wrote');
        await writeFile(
          bin,
          `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\nrequire('fs').writeFileSync(${JSON.stringify(argvOut)}, '[]');\n`,
          'utf8',
        );
        const res = await runTypecheck(cwd, { sandbox: false });
        expect(res.ran).toBe(true);
        await expect(access(marker)).resolves.toBeUndefined();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'a timeout kills the whole process group, not just the wrapper',
    async () => {
      // A shim that forks tsc without exec: killing only the shell left the grandchild running.
      const { bin } = await fakeTsc();
      const pidFile = join(cwd, 'grandchild.pid');
      await writeFile(
        bin,
        `#!/bin/sh\nsleep 30 &\necho $! > ${shellQuote(pidFile)}\nwait\n`,
        'utf8',
      );
      const res = await runTypecheck(cwd, { timeoutMs: 1000 });
      expect(res).toMatchObject({ ran: false, reason: expect.stringContaining('timed out') });
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      await new Promise(r => setTimeout(r, 200));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});
