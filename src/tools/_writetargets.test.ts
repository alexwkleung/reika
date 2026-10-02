import { describe, expect, it } from 'vitest';
import { expandingHeredocBodies, writeTargets } from './_writetargets.js';

const cwd = '/proj';
const t = (cmd: string): string[] => writeTargets(cmd, cwd);

describe('writeTargets', () => {
  it('reads redirect targets in every spelling, but never descriptor dups or /dev', () => {
    expect(t('echo hi > a.txt')).toEqual(['/proj/a.txt']);
    expect(t('printf x >>b.txt')).toEqual(['/proj/b.txt']);
    expect(t('make 2>err.log &>all.log')).toEqual(['/proj/err.log', '/proj/all.log']);
    expect(t('npm test 2>&1 | tail')).toEqual([]);
    expect(t('cmd > /dev/null')).toEqual([]);
  });

  it('sees through a heredoc body, which is data and not more commands', () => {
    const cmd = "cat > x.ts <<'EOF'\nconst a = 1 > 0;\necho no > y.ts\nEOF\necho done";
    expect(t(cmd)).toEqual(['/proj/x.ts']);
  });

  it('takes sed and perl in-place files, skipping the script and the macOS backup suffix', () => {
    expect(t("sed -i '' 's/a/b/' f.ts")).toEqual(['/proj/f.ts']);
    expect(t("sed -i.bak -e 's/a/b/' f.ts g.ts")).toEqual(['/proj/f.ts', '/proj/g.ts']);
    expect(t("sed -n '1,5p' f.ts")).toEqual([]);
    expect(t("perl -pi -e 's/a/b/' f.ts")).toEqual(['/proj/f.ts']);
  });

  it('takes tee, rm, touch operands and the cp/mv destination', () => {
    expect(t('echo x | tee -a log.txt')).toEqual(['/proj/log.txt']);
    expect(t('rm -f a b')).toEqual(['/proj/a', '/proj/b']);
    expect(t('cp src.ts dst.ts')).toEqual(['/proj/dst.ts']);
    expect(t('mv a.ts sub/b.ts')).toEqual(['/proj/sub/b.ts']);
  });

  it('applies leading cd hops and leaves quoted redirect characters alone', () => {
    expect(t('cd sub && echo x > f.txt')).toEqual(['/proj/sub/f.txt']);
    expect(t('grep ">" f.ts')).toEqual([]);
    expect(t('echo x > "my file.txt"')).toEqual(['/proj/my file.txt']);
  });

  it('sees nothing in a command that writes wherever it likes', () => {
    expect(t('npm run fix')).toEqual([]);
    expect(t('prettier --write .')).toEqual([]);
  });
});

// The complement of `stripHeredocs`, and the distinction is the delimiter's quoting: `<<'EOF'` pastes
// its body literally, `<<EOF` expands what is in it.
describe('expandingHeredocBodies', () => {
  it('returns the bodies a quoted delimiter would have made literal', () => {
    expect(expandingHeredocBodies("git apply - <<'EOF'\n$(id)\nEOF")).toEqual([]);
    expect(expandingHeredocBodies('git apply - <<EOF\n$(id)\nEOF')).toEqual(['$(id)']);
    expect(expandingHeredocBodies('git apply - <<-"EOF"\n$(id)\nEOF')).toEqual([]);
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
