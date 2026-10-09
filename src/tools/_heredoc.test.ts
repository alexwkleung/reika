import { describe, expect, it } from 'vitest';
import {
  expandingHeredocBodies,
  hasHeredocOperator,
  scanHeredocs,
  scanQuotes,
  stripHeredocs,
} from './_heredoc.js';

// The operator is a run of exactly two `<`, and both halves of this module have to agree on where
// it is — the guard is the conservative superset, so it may fire where the detector finds no
// delimiter, but it may never stay silent about a heredoc the detector recognized (#685).
describe('hasHeredocOperator', () => {
  it.each([
    'cat <<EOF',
    'cat << EOF',
    'cat <<-EOF',
    "cat <<'EOF'",
    'cat <<"EOF"',
    'cat <<\\EOF',
    "cat <<'A B'",
    'gh pr comment 5 -F - <<EOF\nbody\nEOF',
    'git apply - <<$DELIM\nbody\n$DELIM', // no delimiter form is recognized here: the guard covers it
  ])('fires on %s', cmd => {
    expect(hasHeredocOperator(cmd)).toBe(true);
  });

  it.each([
    "git grep -c '^<<<<<<<' FETCH_HEAD",
    "grep -n '<<<<<<<\\|>>>>>>>\\|=======' f",
    "cat <<< 'here-string'",
    "echo $'<<<<<<<<'",
    'grep -c "<<" f',
  ])('stays quiet on %s, which cannot open a heredoc', cmd => {
    expect(hasHeredocOperator(cmd)).toBe(false);
  });

  // The invariant the two questions have to hold, over the forms that actually open one: wherever
  // the detector finds a heredoc to cut, the guard says the mask is unsafe.
  it('fires wherever the detector reads a heredoc', () => {
    for (const cmd of [
      'cat <<EOF\nbody\nEOF',
      "cat <<'A B'\nbody\nA B",
      'cat <<\\EOF\nbody\nEOF',
      'cat <<-EOF\n\tbody\nEOF',
      "cat > x.ts <<'EOF'\nconst a = 1 > 0;\nEOF",
    ]) {
      expect(hasHeredocOperator(cmd)).toBe(true);
      expect(stripHeredocs(cmd)).not.toBe(cmd);
    }
  });
});

describe('stripHeredocs', () => {
  it('cuts the body of every delimiter form the shell accepts', () => {
    // The newline that ends the operator line survives the cut (the body is cut from the line after
    // it), which is why the survivors are `cat ` and `echo after` on separate lines.
    expect(stripHeredocs('cat <<EOF\nprose\nEOF\necho after')).toBe('cat \necho after');
    expect(stripHeredocs("cat <<'A B'\nprose\nA B\necho after")).toBe('cat \necho after');
    expect(stripHeredocs('cat <<\\EOF\nprose\nEOF\necho after')).toBe('cat \necho after');
    expect(stripHeredocs('cat <<-"EOF"\nprose\nEOF\necho after')).toBe('cat \necho after');
  });

  // `<<<` is a here-string: nothing follows it on later lines, so there is no body to cut, and the
  // `<<` inside it must not be read as an operator of its own.
  it('leaves a here-string alone', () => {
    expect(stripHeredocs("cat <<< 'x'\necho after")).toBe("cat <<< 'x'\necho after");
  });

  // The delimiter is a literal line, so its metacharacters are not pattern syntax: `E-O-F` is not
  // the terminator of a `<<'E.O.F'` body.
  it('takes a delimiter with regex metacharacters literally', () => {
    expect(stripHeredocs("cat <<'E.O.F'\nE-O-F is body\nE.O.F\necho after")).toBe(
      'cat \necho after',
    );
  });
});

// The complement of `stripHeredocs`, and the distinction is the delimiter's quoting: `<<'EOF'` pastes
// its body literally where `<<EOF` expands what is in it, and `<<\EOF` — which the shells measured
// paste too — is read as expanding anyway, for the reason `heredocDelimiter` gives.
describe('expandingHeredocBodies', () => {
  it('returns the bodies a quoted delimiter would have made literal', () => {
    expect(expandingHeredocBodies("git apply - <<'EOF'\n$(id)\nEOF")).toEqual([]);
    expect(expandingHeredocBodies('git apply - <<EOF\n$(id)\nEOF')).toEqual(['$(id)']);
    expect(expandingHeredocBodies('git apply - <<-"EOF"\n$(id)\nEOF')).toEqual([]);
  });

  // Both forms the detector used to read as prose. Which body expands is the delimiter's own
  // quoting, and the two widest forms disagree: `<<'A B'` pastes (measured on sh/bash/dash/zsh),
  // while `<<\EOF` — which all four also make literal, because the backslash quotes the delimiter —
  // is deliberately read as expanding anyway. See the comment on `heredocDelimiter`: the fail-closed
  // direction there is the network guarantee, and the cost is a local read losing an allow it did
  // not need.
  it('reads the quoted delimiter as literal, and the backslash-quoted one as expanding anyway', () => {
    expect(expandingHeredocBodies("git apply - <<'A B'\n$(id)\nA B")).toEqual([]);
    expect(expandingHeredocBodies('git apply - <<\\EOF\n$(id)\nEOF')).toEqual(['$(id)']);
  });

  it('takes both bodies when one heredoc is quoted and the next is not', () => {
    const cmd = "cat <<'EOF'\nliteral\nEOF\ngit apply - <<EOF\n$(id)\nEOF";
    expect(expandingHeredocBodies(cmd)).toEqual(['$(id)']);
  });

  it('does not re-read a body as a heredoc operator of its own', () => {
    // The inner `<<EOF` is inside the outer body, so it opens nothing — the bug a naive scan has.
    const cmd = 'git apply - <<EOF\nexample: cat <<EOF\nmore\ndone\nEOF';
    expect(expandingHeredocBodies(cmd)).toEqual(['example: cat <<EOF\nmore\ndone']);
  });

  it('swallows the rest of the command when the delimiter never closes, as the shell does', () => {
    expect(expandingHeredocBodies('git apply - <<EOF\n$(id)')).toEqual(['$(id)']);
    expect(expandingHeredocBodies('git apply - <<EOF')).toEqual([]);
  });
});

// Each of these is a shape a regex reader got wrong, checked against `/bin/sh` (bash 3.2) and bash 5.
// The direction matters more than the case: a body read too long hides the commands after it from
// the verb readers, which is a network allow or a skipped prompt; a body read too short only
// over-denies.
describe('scanHeredocs reads heredocs the way /bin/sh does', () => {
  it('splits the `<` run the way the shell does: `\\<<<EOF` is a literal `<` and a real heredoc', () => {
    const cmd = "cat \\<<<EOF\n'$(id)'\nEOF";
    expect(hasHeredocOperator(cmd)).toBe(true);
    expect(expandingHeredocBodies(cmd)).toEqual(["'$(id)'"]);
    // An escaped `<` on its own is no operator, and four or more is a syntax error read fail-closed.
    expect(hasHeredocOperator('cat \\<\\< x')).toBe(false);
    expect(scanHeredocs('cat <<<<<EOF\nx\nEOF').uncertain).toBe(true);
  });

  it('takes the whole delimiter word, with its quotes and backslashes removed', () => {
    expect(scanHeredocs('cat <<"EOF"x\nEOFx\nEOF').heredocs[0].delimiter).toBe('EOFx');
    expect(scanHeredocs("cat <<'EOF'x\nb\nEOFx").heredocs[0].delimiter).toBe('EOFx');
    expect(scanHeredocs('cat <<\\EOF"x"\nb\nEOFx').heredocs[0].delimiter).toBe('EOFx');
    expect(scanHeredocs('cat <<END-X\nb\nEND-X').heredocs[0].delimiter).toBe('END-X');
    expect(scanHeredocs('cat <<E"O"F\nb\nEOF').heredocs[0]).toMatchObject({
      delimiter: 'EOF',
      literal: true,
    });
    expect(stripHeredocs('cat <<"EOF"x\nEOF\nEOFx\necho after')).toBe('cat \necho after');
  });

  it('never reads a quoted or commented `<<` as an operator', () => {
    for (const cmd of [
      "git log --grep '<<EOF'\ncurl x\nEOF",
      'echo "see <<EOF"\ncurl x\nEOF',
      'echo hi # <<EOF\ncurl x\nEOF',
    ]) {
      expect(hasHeredocOperator(cmd)).toBe(false);
      expect(stripHeredocs(cmd)).toBe(cmd);
    }
    // Inside a `$(…)` the text is a command again, quotes around it or not.
    expect(hasHeredocOperator('x="$(cat <<EOF\nb\nEOF\n)"')).toBe(true);
  });

  it('ends a body only on a line that is exactly the delimiter', () => {
    // Leading or trailing blanks keep the line in the body…
    expect(stripHeredocs('cat <<EOF\n  EOF\nEOF \nbody\nEOF\necho after')).toBe('cat \necho after');
    // …except leading tabs, and only for `<<-`.
    expect(stripHeredocs('cat <<-EOF\n\tb\n\tEOF\necho after')).toBe('cat \necho after');
    expect(stripHeredocs('cat <<EOF\n\tEOF\nEOF\necho after')).toBe('cat \necho after');
  });

  // bash ends a heredoc at `EOF)` inside a substitution (zsh and dash do not, but `/bin/sh` is bash).
  it('closes a heredoc and its substitution together at `EOF)`', () => {
    expect(stripHeredocs('x="$(cat <<EOF\nhi\nEOF)"\necho after')).toBe(
      'x="$(cat \n)"\necho after',
    );
    expect(stripHeredocs('x=`cat <<EOF\nhi\nEOF`\ncurl x')).toBe('x=`cat \n`\ncurl x');
    // Only the closer of the substitution the heredoc is in: at the top level `EOF)` is body.
    expect(stripHeredocs('cat <<EOF\nEOF)\nEOF\necho after')).toBe('cat \necho after');
  });

  // The old cut ran from the operator to the body's end, taking the rest of the operator's line with
  // it: a command chained after a heredoc on the same line vanished from the verb read.
  it('keeps the rest of the operator line', () => {
    expect(stripHeredocs('gh issue view 1 -F - <<EOF && curl x\nbody\nEOF')).toBe(
      'gh issue view 1 -F -  && curl x\n',
    );
    expect(stripHeredocs('cat <<EOF > out.md\nbody\nEOF')).toBe('cat  > out.md\n');
  });

  it('reads two heredocs on one line in order', () => {
    expect(stripHeredocs('cat <<A <<B\na\nA\nb\nB\necho after')).toBe('cat  \necho after');
  });

  // A `<<` in arithmetic is a shift, but `$((` can also open a subshell in a `$(`, so the lexer says
  // it cannot tell rather than guessing — and every reader then fails closed.
  it('fails closed on a `<<` it cannot place', () => {
    const cmd = 'echo $((1<<2))\ncurl x';
    expect(hasHeredocOperator(cmd)).toBe(true);
    expect(stripHeredocs(cmd)).toBe(cmd);
    expect(expandingHeredocBodies(cmd)).toEqual([cmd]);
  });
});

// The same walk's quoting regions, which `_readonly.ts`'s two masks are built from (#695). Only the
// spans matter here — what each mask blanks with them is `_readonly.test.ts`'s question.
describe('scanQuotes', () => {
  it('reports each quoting form with its kind and its exact range', () => {
    const cmd = "cat 'a;b' \"c;d\" $'e;f'";
    const spans = scanQuotes(cmd).spans.map(s => [s.kind, cmd.slice(s.start, s.end)]);
    expect(spans).toEqual([
      ['single', "'a;b'"],
      ['double', '"c;d"'],
      ['ansi', "$'e;f'"],
    ]);
  });

  // Nesting is the reason this is one span list and not two: a `'…'` inside a `$(…)` inside a `"…"`
  // is quoted data (the single-quote mask blanks it) while the `"…"` around it is not (that mask
  // leaves it, because a `$(…)` runs there).
  it('reports a nested region as its own span', () => {
    const cmd = 'echo "$(grep \'x;y\' f)"';
    const spans = scanQuotes(cmd).spans.map(s => [s.kind, cmd.slice(s.start, s.end)]);
    expect(spans).toEqual([
      ['single', "'x;y'"],
      ['double', '"$(grep \'x;y\' f)"'],
    ]);
  });

  // An escaped quote opens nothing, and `$'…'` is the one single-quoted form a backslash escapes in.
  it("follows backslash escapes outside and inside `$'…'`", () => {
    const escaped = 'cat f \\"; touch pwned \\"';
    expect(scanQuotes(escaped).spans).toEqual([]);
    expect(scanQuotes("echo $'a\\' ; touch pwned'").spans).toHaveLength(1);
    expect(scanQuotes("echo $'a\\' ; touch pwned'").spans[0].kind).toBe('ansi');
  });

  // dash has no `$'…'` and closes it at the first `'`, so an escaped quote inside one splits the two
  // shells' readings: `; touch PWNED` is data to bash and a command to dash (#696 review).
  it("is uncertain about a `$'…'` that bash and dash close at different quotes", () => {
    const split = "echo $'a\\' ; touch PWNED; echo 'x\\'";
    expect(scanQuotes(split).uncertain).toBe(true);
    expect(scanHeredocs(split).uncertain).toBe(true);
    expect(scanQuotes("echo $'a\\\\\\'b' ; cat f").uncertain).toBe(true);
    expect(scanQuotes("echo $'a\\\\b' ; cat f").uncertain).toBe(false);
    // Escapes that leave the first `'` where both shells close agree, and stay certain.
    expect(scanQuotes("echo $'a;b'").uncertain).toBe(false);
    expect(scanQuotes("echo $'a\\nb\\\\'").uncertain).toBe(false);
  });

  // Not quote-parsed by the shell, so a quote in either is a character rather than an opener.
  it('records nothing inside a comment or a heredoc body', () => {
    expect(scanQuotes("echo hi # don't\ncat 'a;b' f").spans).toHaveLength(1);
    const heredoc = "cat <<'EOF'\nit's\nEOF\ncat 'a;b' f";
    expect(scanQuotes(heredoc).spans.map(s => heredoc.slice(s.start, s.end))).toEqual(["'a;b'"]);
  });

  it('is uncertain only about a quote it could not close', () => {
    expect(scanQuotes("cat 'a;b' f").uncertain).toBe(false);
    expect(scanQuotes('cat "; touch PWNED').uncertain).toBe(true);
    expect(scanQuotes("echo don't").uncertain).toBe(true);
    expect(scanQuotes("echo $'never closed").uncertain).toBe(true);
    // A `<<` the heredoc half cannot place says nothing about quoting, and must not refuse the mask.
    expect(scanHeredocs('echo $((1<<2))').uncertain).toBe(true);
    expect(scanQuotes('echo $((1<<2))').uncertain).toBe(false);
  });
});
