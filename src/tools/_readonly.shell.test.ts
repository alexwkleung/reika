import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isProvablyReadOnly } from './_readonly.js';

const exec = promisify(execFile);

// The rest of the suite tests the classifier against what we BELIEVE the shell does. This one tests
// it against the shell. Every command the gate admits is executed for real in a scratch directory,
// and the directory must come back byte-for-byte unchanged — so a rule that is subtly wrong about
// quoting, separators or expansion fails here rather than in plan mode.
//
// Deliberately one-directional: only ADMITTED commands run. A command the gate refuses is never
// executed (that is the whole point), so there is nothing to observe and nothing to be unsafe about.
// Every payload below is `touch PWNED` — a marker, so a leak is visible without being destructive.

const CANDIDATES = [
  // Separator handling: each of these is a second command riding along, in a spelling the shell
  // accepts and a naive split misses.
  'cat f\ttouch PWNED',
  'cat f\rtouch PWNED',
  'cat f;touch PWNED',
  'cat f & touch PWNED',
  'cat f && touch PWNED',
  'cat f || touch PWNED',
  'cat f | touch PWNED',
  'cat f\ntouch PWNED',
  // Quoting: the mask must agree with the shell about which separators are data.
  `echo "a\\" ; touch PWNED"`,
  `echo 'a'"'"'; touch PWNED'`,
  `grep "a'b;c" f`,
  `echo 'a;b'`,
  `cat "; touch PWNED"`,
  'cat "; touch PWNED',
  // Substitution, in every spelling that executes.
  'echo $(touch PWNED)',
  'echo `touch PWNED`',
  'cat <(touch PWNED)',
  'echo "$(touch PWNED)"',
  'echo hi ${x:=$(touch PWNED)}',
  // Redirection, including the forms that are not a bare `>`.
  'echo hi > PWNED',
  'echo hi >> PWNED',
  'cat a >| PWNED',
  'echo hi 2> PWNED',
  'cat f 3> PWNED',
  // Allowlisted commands asked to write.
  'find . -name "*" -delete',
  'find . -exec touch PWNED {} +',
  'find . -execdir touch PWNED {} +',
  "find . '-delete'",
  'find . -fprint PWNED',
  'find . -fls PWNED',
  'sort -o PWNED f',
  'sort --output=PWNED f',
  'sort -no PWNED f',
  'uniq f PWNED',
  // Program-argument commands, which the gate does not admit at all.
  `awk 'BEGIN{print "x" > "PWNED"}'`,
  `awk 'BEGIN{system("touch PWNED")}'`,
  `sed 's/a/b/w PWNED' f`,
  'sed -i "s/a/b/" f',
  'tree -o PWNED',
  // Ordinary inspection that must keep working — these SHOULD run, and still must not write.
  'cat f',
  'cat f g',
  'grep -n data f',
  'grep -i DATA f',
  'grep ">" f',
  'find . -name "*" -printf "%p\\n"',
  'ls -la',
  'wc -l f',
  'head -c 2 f',
  'sort -n f | head',
  'sort f | uniq -c',
  'cat f | wc -l',
  'echo hi | wc -c',
  'cd . && cat f',
  'stat f',
  'realpath f',
  'nl f',
  'cut -d, -f1 f',
];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reika-readonly-shell-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Reset the scratch directory to a known set of readable files and return its contents, which is
// the baseline each case is compared against.
async function seed(): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const name of ['f', 'g', 'a']) await writeFile(join(dir, name), 'data\n', 'utf8');
  return (await readdir(dir)).sort();
}

describe('isProvablyReadOnly against the real shell', () => {
  it.each(CANDIDATES)('admitting %s never writes to disk', async cmd => {
    if (!isProvablyReadOnly(cmd)) return; // refused: never executed, nothing to observe
    const before = await seed();
    try {
      await exec('bash', ['-c', cmd], { cwd: dir, timeout: 5000 });
    } catch {
      // A non-zero exit is fine — the assertion is about side effects, not success.
    }
    expect((await readdir(dir)).sort()).toEqual(before);
  });

  // The suite would pass vacuously if the gate refused everything, so pin that it actually admits
  // the inspection half of the list.
  it('admits a meaningful number of the candidates', () => {
    expect(CANDIDATES.filter(isProvablyReadOnly).length).toBeGreaterThanOrEqual(15);
  });
});
