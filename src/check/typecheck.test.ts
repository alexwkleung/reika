import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CheckOutcome,
  type Diagnostic,
  decideTypecheckGate,
  detectTsProject,
  diagnosticKey,
  formatIntroduced,
  introducedDiagnostics,
  parseTscOutput,
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
});
