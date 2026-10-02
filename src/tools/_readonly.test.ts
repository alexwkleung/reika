import { describe, expect, it } from 'vitest';
import { isInspectionEscape, isProvablyReadOnly } from './_readonly.js';

// Two predicates, opposite consequences, so they get separate suites. `isProvablyReadOnly` gates
// plan mode (`true` admits the command — a wrong `true` is a write that escaped the guarantee);
// `isInspectionEscape` drives the withdrawal ladder (`true` refuses the call — a wrong `false` lets
// a withdrawn model keep circling, a wrong `true` refuses a real build mid-loop).

describe('isProvablyReadOnly — plan mode admits the command', () => {
  // The read-only escapes actually observed in real loops — these must stay classifiable.
  it.each([
    'grep -n "isFavorite\\|toggleFavorite" web/src/scripts/state.ts | head -20',
    'cd /home/dev/example-app && grep -n "btn-favorite" web/src/components/NowPlaying.astro',
    'cd /home/dev/example-app && cat web/src/scripts/state.ts | tail -20',
    'grep -A 5 "favorite-btn" web/src/scripts/dom.ts | head -20',
    'cat web/src/components/NowPlaying.astro | grep -A 5 "btn-favorite"',
    'grep -n "repair-btn" web/src/scripts/dom.ts',
    'ls web/src/scripts',
    'find web/src -name "*.ts"',
    'wc -l web/src/scripts/dom.ts',
  ])('classifies read-only inspection as read-only: %s', cmd => {
    expect(isProvablyReadOnly(cmd)).toBe(true);
  });

  it.each([
    'npm run build',
    'git commit -m "favorites"',
    'mkdir -p web/src/scripts',
    'rm -rf dist',
    'cd web && npm test',
    'grep foo file.ts && rm file.ts', // read-only THEN a mutator in the chain
    'grep foo file | node script.js',
    'curl example.com | grep foo',
  ])('classifies mutating/build commands as NOT read-only: %s', cmd => {
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a cd hop leaving no inspection command', 'cd web/src'],
  ])('returns false for %s', (_label, cmd) => {
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });

  // Below: one case per escape the classifier claims to close. A wrong `true` here is a write that
  // plan mode admitted, so each enumerated rule earns its own test rather than riding on the prose.
  describe('command substitution runs a command the allowlist never sees', () => {
    it.each([
      'echo $(rm -rf dist)',
      'echo `rm -rf dist`',
      'cat <(rm -rf dist)',
      'echo "$(rm -rf dist)"', // still executes inside double quotes
      'echo $((1+1))', // arithmetic is harmless; denied anyway, safety over precision
      'echo \\\\`rm -rf dist`', // an escaped backslash, then a real substitution
      'grep "\\`" f `rm -rf dist`', // one escaped backtick does not excuse a real pair
    ])('rejects %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });

    // Observed: a markdown-table grep refused in plan mode, costing a round.
    it.each(['grep -n "^| \\`REIKA" docs/configuration.md', 'grep -n "\\$(" src/a.ts'])(
      'allows an escaped backtick or dollar, which is a literal: %s',
      cmd => {
        expect(isProvablyReadOnly(cmd)).toBe(true);
      },
    );
  });

  describe('redirection is a write, unless it is search-pattern data', () => {
    it.each([
      'grep foo bar > out.txt',
      'cat a.ts > b.ts',
      'ls >> log',
      'npm run build 2>&1 | head',
    ])('rejects %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });

    it('allows a redirection character that is quoted search data', () => {
      expect(isProvablyReadOnly('grep ">" file.txt')).toBe(true);
      expect(isProvablyReadOnly('cat "; rm -rf /"')).toBe(true); // a file with an alarming name
    });

    // Observed in a plan session: `grep -n … docs/*.md 2>/dev/null | head -40` refused, a round lost.
    it.each([
      'grep -n "MCP" AGENTS.md docs/*.md 2>/dev/null | head -40',
      'ls src/nope 2> /dev/null',
      'cat a.ts &>/dev/null',
      'grep -rn foo src 2>&1 | head',
      'find . -name "*.ts" 2>/dev/null; wc -l a.ts >&2',
    ])('allows a redirection that cannot write a file: %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(true);
    });

    it.each([
      'cat a.ts 2>/dev/null > b.ts',
      'grep foo bar >/dev/null.txt',
      'ls 2>/dev/nullfile',
      'grep foo bar > /dev/null/../../tmp/x',
    ])('still rejects a real write beside or disguised as one: %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });
  });

  describe('every separator starts a new command', () => {
    it.each([
      ['semicolon', 'cat f; rm -rf dist'],
      ['background', 'cat f & rm -rf dist'],
      ['pipe', 'cat f | rm -rf dist'],
      ['and', 'cat f && rm -rf dist'],
      ['or', 'cat f || rm -rf dist'],
      ['newline', 'cat f\nrm -rf dist'],
      ['carriage return', 'cat f\r\nrm -rf dist'],
      ['no surrounding whitespace', 'cat f;rm -rf dist'],
    ])('splits on %s', (_label, cmd) => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });

    it('does not split on a separator inside quotes', () => {
      expect(isProvablyReadOnly("echo 'a;b'")).toBe(true);
    });

    it('rejects a command hidden behind an unbalanced quote', () => {
      expect(isProvablyReadOnly('cat "; rm -rf /')).toBe(false);
    });
  });

  describe('commands that interpret a program argument are not admitted', () => {
    it.each([
      `awk 'BEGIN{print "x" > "/tmp/pwn"}'`, // writes from inside the quoted program
      `awk 'BEGIN{system("rm -rf dist")}'`,
      `awk '{print $2}' file`, // read-only in practice, still not provable
      `sed 's/a/b/w /tmp/pwn' file`, // the w flag writes
      `sed -i "s/x/y/" file.ts`,
      `sed --in-place s/x/y/ file.ts`,
      'tree src', // -o writes the listing to a file
    ])('rejects %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });
  });

  // sed is admitted only through a positive grammar: addresses, then p, = or q. Observed refusal:
  // `sed -n '/## Adding a new tool/,/## Optional tools/p' AGENTS.md`, a plan round lost.
  describe('sed: range prints only', () => {
    it.each([
      `sed -n '1,50p' file`,
      `sed -n '120,$p' src/app.ts`,
      `sed -n '/## Adding a new tool/,/## Optional tools/p' AGENTS.md`,
      `sed -n '/start/I,+10p' f`,
      `sed -n '5p;10p' f`,
      `sed -ne '1,3p' -e '/x/=' f`,
      `sed 20q f`,
      `sed -n '/a\\/b/!p' f`, // escaped slash inside the regex
      `gh pr diff 420 | sed -n '1,300p'`,
      `sed -En '/w file/p' f`, // w inside a regex address is data
    ])('admits %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(true);
    });

    it.each([
      `sed -n '1,50w out.txt' f`, // w command writes
      `sed -n 's/a/b/p' f`, // no s at all, so none of its w/e flags can ride along
      `sed 's/a/b/w /tmp/pwn' f`,
      `sed -n '1e rm -rf dist' f`, // GNU e executes
      `sed -n '1r /etc/passwd' f`,
      `sed -n '1,5{p}' f`, // blocks are outside the grammar
      `sed -n '\\%x%p' f`, // custom regex delimiter
      `sed -i -n '1p' f`,
      `sed -n -f script.sed f`,
      `sed -n --debug '1p' f`,
      `sed -n`,
      `sed -n -e`,
    ])('rejects %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });
  });

  describe('find: the write-and-exec flags', () => {
    it.each([
      'find . -name "*.tmp" -delete',
      'find . -name "*.ts" -exec rm {} \;',
      'find . -execdir rm {} +',
      'find . -ok rm {} \;',
      'find . -okdir rm {} \;',
      'find . -fprint /tmp/pwn',
      'find . -fprintf /tmp/pwn "%p"',
      'find . -fls /tmp/pwn',
      "find . '-delete'", // quoting a flag does not stop it being one
      'find . "-delete"',
    ])('rejects %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(false);
    });

    it('allows -printf, which only writes to stdout', () => {
      expect(isProvablyReadOnly('find . -name "*.ts" -printf "%p\\n"')).toBe(true);
    });
  });

  describe('sort: -o writes a file', () => {
    it.each(['sort -o out.txt in.txt', 'sort --output=out.txt in.txt', 'sort -no out.txt in.txt'])(
      'rejects %s',
      cmd => {
        expect(isProvablyReadOnly(cmd)).toBe(false);
      },
    );

    it('allows sort flags that only read', () => {
      expect(isProvablyReadOnly('sort -n file | head')).toBe(true);
    });
  });

  describe('uniq: the second operand is an output file', () => {
    it('rejects a second operand', () => {
      expect(isProvablyReadOnly('uniq in.txt out.txt')).toBe(false);
    });

    it.each(['sort f | uniq -c', 'uniq -c in.txt'])('allows %s', cmd => {
      expect(isProvablyReadOnly(cmd)).toBe(true);
    });

    // `-f`/`-s`/`-w` take the next word as their value. Counting it as an operand refused a plain
    // read — and on the ladder side scored a real inspection shape as "not inspection", letting a
    // withdrawn model keep circling on it.
    it.each(['uniq -f 2 in.txt', 'uniq -s 5 in.txt', 'uniq -w 5 in.txt', 'uniq -c -f 2 out.txt'])(
      'does not count a flag value as the output operand: %s',
      cmd => {
        expect(isProvablyReadOnly(cmd)).toBe(true);
      },
    );

    it('still rejects a real second operand alongside a valued flag', () => {
      expect(isProvablyReadOnly('uniq -f 2 in.txt out.txt')).toBe(false);
    });
  });

  // `-i` used to read as an in-place-edit signal, which denied the single most common grep flag.
  // It existed for `sed -i`, and sed is no longer admitted at all.
  it('allows case-insensitive grep', () => {
    expect(isProvablyReadOnly('grep -i foo file.ts')).toBe(true);
  });
});

describe('isProvablyReadOnly — gh reads', () => {
  it.each([
    'gh issue view 213',
    'gh issue view 213 --comments',
    'gh pr view 420 --json title,body',
    'gh pr diff 420 | head -300',
    'gh pr checks 420',
    'gh -R octocat/hello-world issue list --state open',
    'gh search issues "flicker" --repo octocat/hello-world',
    'gh api repos/octocat/hello-world/pulls/1/comments',
    'gh api -X GET repos/octocat/hello-world/commits --paginate',
    'gh api -H "Accept: application/vnd.github.diff" repos/octocat/hello-world/pulls/1',
  ])('admits: %s', cmd => {
    expect(isProvablyReadOnly(cmd)).toBe(true);
  });

  it.each([
    ['comments on GitHub', 'gh pr comment 420 --body hi'],
    ['edits GitHub', 'gh issue edit 213 --add-label bug'],
    ['writes the working tree', 'gh pr checkout 420'],
    ['writes a clone', 'gh repo clone octocat/hello-world'],
    ['writes artifacts', 'gh run download 1'],
    ['never exits', 'gh run watch 1'],
    ['never exits (flag)', 'gh pr checks 420 --watch'],
    ['opens a browser', 'gh pr view 420 --web'],
    ['opens a browser (short)', 'gh issue view 213 -w'],
    ['bare noun', 'gh pr'],
    ['unknown noun (an extension)', 'gh dash'],
    ['api field = POST', 'gh api repos/octocat/hello-world/issues -f title=x'],
    ['api explicit method', 'gh api -X DELETE repos/octocat/hello-world'],
    ['api attached method', 'gh api --method=PATCH repos/octocat/hello-world'],
    ['api body from stdin', 'gh api repos/octocat/hello-world/issues --input body.json'],
    ['api graphql', "gh api graphql -F query='{ viewer { login } }'"],
    ['api graphql, no field', 'gh api graphql'],
    ['api method override', 'gh api -H "X-HTTP-Method-Override: DELETE" repos/o/r'],
    ['env prefix', 'GH_HOST=example.com gh issue view 1'],
    ['redirect', 'gh pr diff 420 > pr.diff'],
    // The carrier is read through, so the command INSIDE it is what has to be read-only (#621).
    ['carrier around a write', 'timeout 30 rm -rf src'],
    ['carrier around a sed write', "timeout 30 sed 's/a/b/w src/b.ts' src/a.ts"],
    ['carrier with nothing after it', 'timeout 30'],
  ])('refuses (%s): %s', (_why, cmd) => {
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });

  // #621: `timeout 120 gh issue view 621 --json title,body` — the bound a model puts on a read when
  // GitHub is slow. A carrier changes nothing about what runs, so the read inside it is the read.
  it('reads through a `timeout` carrier', () => {
    expect(isProvablyReadOnly('timeout 120 gh issue view 621 --json title,body')).toBe(true);
    expect(isProvablyReadOnly('timeout 120 gh pr view 620 --json state')).toBe(true);
    expect(isProvablyReadOnly("timeout 30 sed -n '1,40p' src/a.ts")).toBe(true);
    expect(isProvablyReadOnly('timeout 30 grep -n foo src/a.ts | head -5')).toBe(true);
  });

  // Plan mode's set must stay inside what agent mode already runs unprompted; a verb admitted here
  // but flagged there would make plan mode the looser of the two.
  it('admits nothing the danger scan flags', async () => {
    const { detectDangerousPatterns } = await import('./_danger.js');
    for (const cmd of [
      'gh pr view 1',
      'gh pr list',
      'gh pr diff 1',
      'gh pr checks 1',
      'gh pr status',
      'gh issue view 1',
      'gh issue list',
      'gh issue status',
      'gh repo view',
      'gh repo list',
      'gh run view 1',
      'gh run list',
      'gh workflow view ci',
      'gh workflow list',
      'gh release view v1',
      'gh release list',
      'gh label list',
      'gh search issues x',
      'gh search prs x',
      'gh search repos x',
      'gh search code x',
      'gh search commits x',
      'gh api repos/o/r',
    ]) {
      expect(isProvablyReadOnly(cmd)).toBe(true);
      expect(detectDangerousPatterns(cmd)).toEqual([]);
    }
  });

  it('is not an inspection escape for the ladder', () => {
    expect(isInspectionEscape('gh issue view 213')).toBe(false);
  });
});

describe('isInspectionEscape — the withdrawal ladder refuses the call', () => {
  // Everything plan mode admits is inspection by definition: the ladder is a strict superset, and a
  // regression that narrowed it would show up here first.
  it.each([
    'grep -n foo file.ts | head -20',
    'cat file.ts | tail -30',
    'find src -name "*.ts"',
    'wc -l src/app.ts',
    'ls -la src',
    'cd src && cat app.ts',
    'grep -i foo file.ts',
    'sort -u file.ts',
    "sed -n '1,50p' src/app.ts", // plan mode admits it via the sed grammar; still a ladder escape
    "sed -n '100,200p' file.ts",
  ])('refuses everything plan mode admits: %s', cmd => {
    expect(isProvablyReadOnly(cmd)).toBe(true);
    expect(isInspectionEscape(cmd)).toBe(true);
  });

  // The shapes that separate the two questions. These are inspection — the model reading instead
  // of working — so the ladder MUST catch them, while plan mode must not admit them (their program
  // argument can write, which no regex can rule out). Before the split, one predicate served both
  // and these silently escaped the ladder. sed's range prints left this list with its grammar.
  it.each([
    "awk '{print $1}' file.ts",
    "awk 'NR>10 && NR<40' file.ts",
    'tree src',
    'tree -L 2 src',
  ])('catches the inspection shapes plan mode refuses to admit: %s', cmd => {
    expect(isInspectionEscape(cmd)).toBe(true);
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });

  // Refusing real work mid-loop is the ladder's expensive mistake, so mutating and build commands
  // must fall through — including the in-place spellings of the commands it recognizes.
  it.each([
    'npm run build',
    'npm run build 2>&1 | head -50',
    'git commit -m "wip"',
    'mkdir -p src/scripts',
    'rm -rf dist',
    'cd web && npm test',
    'echo hi | tee log.txt',
    'sed -i "s/x/y/" file.ts', // an in-place edit is real work, not an escape
    'sed --in-place s/x/y/ f',
    'tree -o out.txt src',
    'find . -name "*.tmp" -delete',
    'grep foo file.ts && rm file.ts',
  ])('lets mutating/build work through: %s', cmd => {
    expect(isInspectionEscape(cmd)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a cd hop leaving no inspection command', 'cd web/src'],
    ['an unrecognized command in the pipeline', 'grep foo file | node script.js'],
  ])('returns false for %s', (_label, cmd) => {
    expect(isInspectionEscape(cmd)).toBe(false);
  });
});
