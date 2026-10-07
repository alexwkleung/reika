import { describe, expect, it } from 'vitest';
import { expandingHeredocBodies, hasHeredocOperator, stripHeredocs } from './_heredoc.js';

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
    'grep -c "<<" f', // a bare operator the shell would reject: unproven, so the guard fires
  ])('fires on %s', cmd => {
    expect(hasHeredocOperator(cmd)).toBe(true);
  });

  it.each([
    "git grep -c '^<<<<<<<' FETCH_HEAD",
    "grep -n '<<<<<<<\\|>>>>>>>\\|=======' f",
    "cat <<< 'here-string'",
    "echo $'<<<<<<<<'",
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
