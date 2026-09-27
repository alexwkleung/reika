import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { AssertResult } from './types.js';

// Hidden asserts against the code a model left behind, for fixtures that grade the outcome of a
// change rather than a tool call. Each check runs in its own child with a timeout: a narrow fix to a
// hang (reject 0 only) still loops on -1, and one shared child would report a single timeout instead
// of which checks held.
//
// A check is a JS expression evaluated with the fixture's modules imported and two helpers in scope:
// `throws(fn)` and `same(a, b)` (JSON equality).
//
// A `strict` check grades a reading the prompt does not require — the chunk fixtures ask to reject
// sizes that "can't make progress", and 2.5 does make progress. It is reported beside the result
// and never decides it: the first 30 runs failed literal-minded fixes on exactly these.

export type HiddenCheck = [name: string, expression: string, kind?: 'strict'];

// `imports` maps a module's project-relative path to the names it binds, e.g.
// { 'src/chunk.js': ['chunk'] }.
async function runCheck(
  cwd: string,
  imports: Record<string, string[]>,
  expression: string,
): Promise<boolean | 'hang'> {
  const paths = Object.keys(imports);
  const prelude = [
    ...paths.map(
      (p, i) => `const { ${imports[p].join(', ')} } = await import(process.argv[${i + 1}]);`,
    ),
    'const throws = fn => { try { fn(); return false; } catch { return true; } };',
    'const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);',
  ].join('\n');
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `${prelude}\nprocess.stdout.write(String(${expression}));`,
        ...paths.map(p => pathToFileURL(join(cwd, p)).href),
      ],
      { timeout: 3000 },
    );
    return stdout.trim() === 'true';
  } catch (e) {
    return (e as { killed?: boolean }).killed ? 'hang' : false;
  }
}

// Pass only when every check holds; the reason names the ones that did not, with `suffix` (the
// steps note) appended either way.
export async function gradeHiddenChecks(
  cwd: string,
  imports: Record<string, string[]>,
  checks: HiddenCheck[],
  suffix: string,
): Promise<AssertResult> {
  const results = await Promise.all(checks.map(([, expr]) => runCheck(cwd, imports, expr)));
  const failedOf = (strict: boolean) =>
    checks.flatMap(([name, , kind], i) =>
      (kind === 'strict') !== strict || results[i] === true
        ? []
        : [results[i] === 'hang' ? `${name} (hangs)` : name],
    );
  const required = checks.filter(([, , kind]) => kind !== 'strict').length;
  const strictTotal = checks.length - required;
  const failed = failedOf(false);
  const strictFailed = failedOf(true);
  const strictNote =
    strictTotal === 0
      ? ''
      : `; strict ${strictTotal - strictFailed.length}/${strictTotal}${strictFailed.length > 0 ? ` (missed ${strictFailed.join(', ')})` : ''}`;
  if (failed.length > 0) {
    return {
      pass: false,
      reason: `${required - failed.length}/${required} hidden checks; failed: ${failed.join(', ')}${strictNote} — ${suffix}`,
    };
  }
  return { pass: true, note: `${required}/${required} hidden checks${strictNote} — ${suffix}` };
}
