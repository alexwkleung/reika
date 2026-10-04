import { describe, expect, it } from 'vitest';
import { maskMarkdownData } from './_markdown.js';

// The mask's contract, stated as properties rather than as string fixtures: it must never change the
// command's length or its newlines (every parser downstream indexes the original), and it must keep
// the substitutions the shell still runs. The labels this buys are asserted in `_danger.test.ts`.
describe('maskMarkdownData', () => {
  const cases = [
    `gh pr create --body "$(cat <<'EOF'\nrm -rf /\nEOF)"`,
    `cat > CHANGELOG.md <<EOF\n$(rm -rf /)\nEOF`,
    `echo 'a' > NOTES.md && rm -rf /tmp/x`,
    `bash <<'EOF'\nrm -rf /tmp/x\nEOF`,
    `cat > run.sh <<'EOF'\nrm -rf /tmp/x\nEOF`,
    `gh pr edit 12 --body "sudo is not needed"`,
    `rm -rf /tmp/x`,
    `git commit -m "rm -rf /tmp/x"`,
    '',
  ];

  it('keeps the length and the line structure of the command', () => {
    for (const cmd of cases) {
      const masked = maskMarkdownData(cmd);
      expect(masked.length, cmd).toBe(cmd.length);
      expect(masked.split('\n').length, cmd).toBe(cmd.split('\n').length);
    }
  });

  it('keeps the substitutions the shell still runs, and blanks the literal text beside them', () => {
    const cmd = `gh pr create --body "prose $(rm -rf /tmp/x) more prose"`;
    const masked = maskMarkdownData(cmd);
    // The substitution survives for the scan to read; the words around it do not.
    expect(masked).toContain('$(rm -rf /tmp/x)');
    expect(masked).not.toContain('more prose');
  });

  it('leaves a quoted heredoc body blank even when a substitution is spelled inside it', () => {
    const cmd = `cat > CHANGELOG.md <<'EOF'\n$(rm -rf /tmp/x)\nEOF`;
    expect(maskMarkdownData(cmd)).not.toContain('rm -rf');
  });

  it('blanks a command that writes no Markdown', () => {
    const cmd = `cat > run.sh <<'EOF'\nrm -rf /tmp/x\nEOF`;
    expect(maskMarkdownData(cmd)).toBe(cmd);
    expect(maskMarkdownData('rm -rf /tmp/x')).toBe('rm -rf /tmp/x');
  });

  it('reads two heredocs in one command independently', () => {
    const cmd = `cat > CHANGELOG.md <<'EOF'\nprose\nEOF\nbash <<'X'\nrm -rf /tmp/x\nX`;
    const masked = maskMarkdownData(cmd);
    expect(masked).not.toContain('prose');
    expect(masked).toContain('rm -rf /tmp/x');
    expect(masked).toContain(`bash <<'X'`);
  });
});
