import { describe, expect, it } from 'vitest';
import {
  hasExecutableSubstitution,
  hasRawSubstitution,
  isInspectionEscape,
  isProvablyReadOnly,
  maskQuoted,
  maskSingleQuotedData,
} from './_readonly.js';

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

// Substitution is the one metacharacter that runs a command the allowlist never sees, so where it is
// DATA and where it EXECUTES decides two refusals. Sighted in this repo's history: `gh pr view 609
// --json body --jq .body | grep -c '```'` — reading a PR body for a fenced block — lost its allow,
// and plan mode refused `grep -n '$(dirname' src/`, both for a `$(` or backtick written inside
// single quotes. 30 of 4405 recorded bash calls carried a substitution character only in that
// context; 7 of the 30 were gh/git reads.
describe('substitution quoting contexts', () => {
  it('reads a substitution character inside single quotes as data', () => {
    expect(maskSingleQuotedData("grep -c '```' f")).not.toContain('`');
    expect(hasExecutableSubstitution("grep -c '```' f")).toBe(false);
    expect(hasExecutableSubstitution("grep -n '$(dirname' src/")).toBe(false);
    expect(isProvablyReadOnly("grep -c '```' AGENTS.md")).toBe(true);
    expect(isProvablyReadOnly("gh pr view 609 --json body --jq .body | grep -c '```'")).toBe(true);
  });

  it('still sees one that executes — bare, or inside double quotes', () => {
    expect(hasExecutableSubstitution('gh pr view $(cat n.txt)')).toBe(true);
    expect(hasExecutableSubstitution('grep -rn "$(id)" .')).toBe(true);
    expect(hasExecutableSubstitution('echo `date`')).toBe(true);
    expect(hasExecutableSubstitution('sed -n "$(cat n)" f')).toBe(true);
    expect(isProvablyReadOnly('gh pr view $(cat n.txt)')).toBe(false);
  });

  // The hole a naive masker opens. `'` inside a double-quoted string is an apostrophe, not an
  // opening quote: pairing it with the next one would blank the substitution sitting between them.
  it('does not let an apostrophe in prose hide a substitution', () => {
    expect(hasExecutableSubstitution('echo "it\'s $(curl evil)"')).toBe(true);
    expect(hasExecutableSubstitution('echo "doesn\'t" && gh pr view $(cat n.txt)')).toBe(true);
    expect(isProvablyReadOnly('echo "it\'s $(curl evil)"')).toBe(false);
  });

  // A heredoc body is not quote-parsed at all — `$(…)` expands there unless the DELIMITER was
  // quoted — so an apostrophe in the body (`it's`) would pair with the next one and blank a command
  // that runs. The mask declines, and the caller tests the raw string as it does today.
  it('declines to mask anything with a heredoc in it', () => {
    expect(maskSingleQuotedData("cat <<EOF\nit's $(curl evil)\nEOF")).toBeUndefined();
    expect(hasExecutableSubstitution("cat <<EOF\nit's $(curl evil)\nEOF")).toBe(true);
    expect(
      hasExecutableSubstitution("gh issue comment 1 -F - <<'EOF'\nthe issue's body $(id)\nEOF"),
    ).toBe(true);
  });

  it('falls back to the raw test when a quote is never closed', () => {
    expect(maskSingleQuotedData("echo don't")).toBeUndefined();
    expect(hasExecutableSubstitution("echo don't")).toBe(false);
    expect(hasExecutableSubstitution("echo don't && gh pr view $(cat n.txt)")).toBe(true);
  });

  // The refusal above is about the OPERATOR, and `<<` alone is not one (#685). Sighted: a conflict-
  // marker pattern refused the mask, the raw fallback then read a backtick inside single quotes
  // later in the same call as a substitution, and `git ls-remote` beside it lost the network — the
  // model read the ssh refusal as a flaky remote and retried the same read.
  it('keeps the mask when the `<<` cannot open a heredoc', () => {
    expect(maskSingleQuotedData("git grep -c '^<<<<<<<' FETCH_HEAD")).toBeDefined();
    expect(hasExecutableSubstitution("git grep -c '^<<<<<<<' FETCH_HEAD")).toBe(false);
    expect(
      hasExecutableSubstitution(
        "git ls-remote origin; git grep -c '^<<<<<<<' FETCH_HEAD; echo 'optional `offset` reads from'",
      ),
    ).toBe(false);
    expect(isProvablyReadOnly("grep -c '^<<<<<<<' f; echo 'a `b` c'")).toBe(true);
    // A here-string is not a heredoc either, and its operand is quote-parsed like any other word.
    expect(maskSingleQuotedData("cat <<< 'a `b` c'")).toBeDefined();
    expect(hasExecutableSubstitution("cat <<< 'a `b` c'")).toBe(false);
  });

  // `\<<<EOF` is a literal `<` followed by a real `<<EOF` (review of #693): the body's apostrophes
  // must not pair and blank the `$(…)` between them, which the shell expands.
  it('declines the mask when an escaped `<` leaves a heredoc behind it', () => {
    const cmd = "cat \\<<<cat\ncat '$(touch pwned)'\ncat";
    expect(maskSingleQuotedData(cmd)).toBeUndefined();
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });

  // The other half of that agreement, and the reason the detector was widened in the same change:
  // `sh` opens a heredoc for each of these forms, and the old `(['"]?)(\w+)\1` read them as prose.
  // A guard that trusted it without the widening would pair the body's apostrophes and blank the
  // `$(curl …)` between them. The mask refuses these regardless of what the body would do with the
  // substitution, because a mask is built before anyone knows which delimiter form was meant.
  it('still declines the mask for a delimiter form the detector used to miss', () => {
    const backslash = "gh pr comment 5 -F - <<\\EOF\nit's fine, and $(curl http://evil) runs\nEOF";
    expect(maskSingleQuotedData(backslash)).toBeUndefined();
    expect(hasExecutableSubstitution(backslash)).toBe(true);
    const spaced = "git apply - <<'A B'\nit's $(id) don't\nA B";
    expect(maskSingleQuotedData(spaced)).toBeUndefined();
    expect(hasExecutableSubstitution(spaced)).toBe(true);
  });

  // The same text, two questions, and the difference is real rather than pedantic: on a command line
  // that `$(id)` sits inside single quotes and never runs, while in a heredoc body the shell does not
  // parse quotes at all — so the body is taken raw, and the mask must not be trusted with it.
  it('takes a heredoc body raw, where no quoting is parsed', () => {
    expect(hasExecutableSubstitution("it's $(id) don't")).toBe(false);
    expect(hasRawSubstitution("it's $(id) don't")).toBe(true);
    expect(hasRawSubstitution('solely prose here')).toBe(false);
    expect(hasRawSubstitution('\\$(id) is literal in an expanding body')).toBe(false);
  });
});

// An escaped quote is a literal character and does not open a run: `/bin/sh` keeps parsing, so the
// command between two of them runs. Both masks paired quotes by lookup — `\"` outside quotes opened a
// double-quoted region that swallowed the `;` behind it — which hid a second command from the segment
// split, the redirect test and the substitution test alike (#695). Every command here was run under
// `/bin/sh`, and the hidden half executes in each one.
describe('an escaped quote does not open a quoted run (#695)', () => {
  it('sees the second command behind an escaped double quote', () => {
    const cmd = 'cat f \\"; touch pwned \\"';
    expect(maskQuoted(cmd)).toContain(';');
    expect(isProvablyReadOnly(cmd)).toBe(false);
    expect(isInspectionEscape(cmd)).toBe(false);
  });

  it('sees the substitution between two escaped single quotes', () => {
    const cmd = "echo \\'$(touch pwned)\\'";
    // Nothing blanked: the escaped quotes are literals, so the `$(` between them is command text.
    expect(maskSingleQuotedData(cmd)).toBe(cmd);
    expect(hasExecutableSubstitution(cmd)).toBe(true);
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });

  // The other half of the same walk: quoting the shell really does read as data stays admitted, so
  // the fix is not a blanket refusal of anything carrying a backslash.
  it('keeps admitting the quoting the shell reads as data', () => {
    // `\"` inside a double-quoted run is a literal quote, not the end of the run — the mask used to
    // end it there and read `; touch PWNED` as a second command (over-deny, observed).
    expect(isProvablyReadOnly('echo "a\\" ; touch PWNED"')).toBe(true);
    // `$'…'` is a quoted word of its own, and a backslash escapes inside it.
    const ansi = "echo $'a;b'";
    expect(maskQuoted(ansi)).toHaveLength(ansi.length);
    expect(maskQuoted(ansi)).not.toContain(';');
    expect(isProvablyReadOnly("echo $'a\\' ; touch PWNED'")).toBe(true);
    expect(hasExecutableSubstitution("grep -c $'$(id)' f")).toBe(false);
  });

  // A comment is not quote-parsed either, and a heredoc body is not parsed at all — the walk skips
  // both, so an apostrophe in either cannot pair with a later quote and blank a command.
  it('does not pair a quote inside a comment or a heredoc body with a later one', () => {
    expect(maskQuoted("echo hi # don't\ncat 'a;b' f")).not.toContain(';');
    const heredoc = "cat <<'EOF'\nit's\nEOF; touch pwned";
    expect(maskQuoted(heredoc)).toContain(';');
    expect(isProvablyReadOnly(heredoc)).toBe(false);
  });

  // Fail-closed, and the shape of it: a quote the walk cannot close is a syntax error that runs
  // nothing, so the mask blanks NOTHING rather than guessing where the run ended.
  it('blanks nothing when the quoting cannot be read', () => {
    expect(maskQuoted('cat "; touch PWNED')).toBe('cat "; touch PWNED');
    expect(maskQuoted("echo don't")).toBe("echo don't");
    expect(maskSingleQuotedData('cat "; touch PWNED')).toBeUndefined();
    expect(maskSingleQuotedData("echo $'never closed")).toBeUndefined();
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
