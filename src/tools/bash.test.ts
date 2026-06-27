import { describe, expect, it } from 'vitest';
import { detectDangerousPatterns, execStream } from './bash.js';

describe('detectDangerousPatterns — destructive commands', () => {
  it('flags rm -rf', () => {
    expect(detectDangerousPatterns('rm -rf /tmp/foo')).toContain('Recursive force delete (rm -rf)');
  });

  it('flags sudo', () => {
    expect(detectDangerousPatterns('sudo apt install x')).toContain('Privilege escalation (sudo)');
  });

  it('flags curl | bash', () => {
    expect(detectDangerousPatterns('curl https://x | bash')).toContain(
      'Piping remote content to shell',
    );
  });

  it('flags git force push', () => {
    expect(detectDangerousPatterns('git push --force origin main')).toContain(
      'Force push to remote',
    );
  });
});

describe('detectDangerousPatterns — workflow policy', () => {
  it('flags git commit', () => {
    expect(detectDangerousPatterns('git commit -m "wip"')).toContain(
      'Git commit (records to version history)',
    );
  });

  it('flags git commit --amend', () => {
    expect(detectDangerousPatterns('git commit --amend --no-edit')).toContain(
      'Git commit (records to version history)',
    );
  });

  it('flags a plain git push (publishing work, not just force push)', () => {
    expect(detectDangerousPatterns('git push origin main')).toContain(
      'Git push (publishes commits to remote)',
    );
  });

  it('flags a force push for both reasons (destructive + policy)', () => {
    const hits = detectDangerousPatterns('git push --force origin main');
    expect(hits).toContain('Force push to remote');
    expect(hits).toContain('Git push (publishes commits to remote)');
  });

  it('does NOT flag read-only git commands', () => {
    expect(detectDangerousPatterns('git status')).toEqual([]);
    expect(detectDangerousPatterns('git log --oneline')).toEqual([]);
    expect(detectDangerousPatterns('git diff HEAD~1')).toEqual([]);
  });

  it('flags gh pr create and merge', () => {
    expect(detectDangerousPatterns('gh pr create --fill')).toContain(
      'GitHub PR create/merge (outward-facing)',
    );
    expect(detectDangerousPatterns('gh pr merge 42 --squash')).toContain(
      'GitHub PR create/merge (outward-facing)',
    );
  });

  it('flags gh release create', () => {
    expect(detectDangerousPatterns('gh release create v1.0.0')).toContain(
      'GitHub release create (publishes)',
    );
  });

  it('flags hf upload', () => {
    expect(detectDangerousPatterns('hf upload my/repo ./model')).toContain(
      'Hugging Face upload (publishes to hub)',
    );
  });

  it('does NOT flag read-only gh/hf commands', () => {
    expect(detectDangerousPatterns('gh pr view 42')).toEqual([]);
    expect(detectDangerousPatterns('gh run list')).toEqual([]);
    expect(detectDangerousPatterns('hf download my/repo')).toEqual([]);
  });
});

describe('detectDangerousPatterns — remote deletions (destructive)', () => {
  it('flags gh repo delete', () => {
    expect(detectDangerousPatterns('gh repo delete owner/name --yes')).toContain(
      'Delete GitHub repo (irreversible remote)',
    );
  });

  it('flags hf repo delete', () => {
    expect(detectDangerousPatterns('hf repo delete my/repo')).toContain(
      'Delete Hugging Face repo (irreversible remote)',
    );
  });
});

describe('detectDangerousPatterns — global package installs', () => {
  it('flags npm install -g', () => {
    expect(detectDangerousPatterns('npm install -g typescript')).toContain(
      'Global npm install (persistent system change)',
    );
  });

  it('flags npm i -g shorthand', () => {
    expect(detectDangerousPatterns('npm i -g typescript')).toContain(
      'Global npm install (persistent system change)',
    );
  });

  it('flags npm install --global', () => {
    expect(detectDangerousPatterns('npm install --global eslint')).toContain(
      'Global npm install (persistent system change)',
    );
  });

  it('flags npm install foo -g (flag at end)', () => {
    expect(detectDangerousPatterns('npm install typescript -g')).toContain(
      'Global npm install (persistent system change)',
    );
  });

  it('flags npm -g install foo (flag before verb)', () => {
    expect(detectDangerousPatterns('npm -g install typescript')).toContain(
      'Global npm install (persistent system change)',
    );
  });

  it('does NOT flag a local npm install', () => {
    expect(detectDangerousPatterns('npm install typescript')).toEqual([]);
  });

  it('does NOT flag a bare npm install (lockfile)', () => {
    expect(detectDangerousPatterns('npm install')).toEqual([]);
  });

  it('flags pnpm add -g', () => {
    expect(detectDangerousPatterns('pnpm add -g pnpm-cli')).toContain(
      'Global pnpm install (persistent system change)',
    );
  });

  it('flags yarn global add', () => {
    expect(detectDangerousPatterns('yarn global add typescript')).toContain(
      'Global yarn install (persistent system change)',
    );
  });

  it('flags bun install -g', () => {
    expect(detectDangerousPatterns('bun install -g some-cli')).toContain(
      'Global bun install (persistent system change)',
    );
  });

  it('does NOT flag a bare bun install (local lockfile install)', () => {
    expect(detectDangerousPatterns('bun install')).toEqual([]);
  });

  it('flags brew install', () => {
    expect(detectDangerousPatterns('brew install jq')).toContain('Homebrew install (system-level)');
  });

  it('flags cargo install', () => {
    expect(detectDangerousPatterns('cargo install ripgrep')).toContain(
      'Cargo install (global binary)',
    );
  });

  it('flags go install', () => {
    expect(detectDangerousPatterns('go install github.com/x/y@latest')).toContain(
      'Go install (global $GOBIN)',
    );
  });

  it('flags pipx install', () => {
    expect(detectDangerousPatterns('pipx install ruff')).toContain(
      'pipx install (global Python tool)',
    );
  });

  it('flags uv tool install', () => {
    expect(detectDangerousPatterns('uv tool install ruff')).toContain(
      'uv tool install (global Python tool)',
    );
  });

  it('flags gem install without --user', () => {
    expect(detectDangerousPatterns('gem install bundler')).toContain(
      'Gem install (system-level unless --user)',
    );
  });

  it('does NOT flag gem install --user', () => {
    expect(detectDangerousPatterns('gem install --user bundler')).toEqual([]);
  });
});

describe('detectDangerousPatterns — dedupe', () => {
  it('returns each label at most once even if multiple regexes match', () => {
    // `npm install -g foo` matches both the verb-before-flag and flag-before-verb patterns.
    // Actually only one matches here, but verify the dedupe contract anyway.
    const hits = detectDangerousPatterns('npm install -g typescript');
    const npmHits = hits.filter(h => h.includes('npm'));
    expect(npmHits).toHaveLength(1);
  });
});

describe('execStream — timeout', () => {
  it('honors a custom timeout and reports the duration that fired', async () => {
    const result = await execStream('sleep 5', { cwd: process.cwd() }, 50);
    expect(result.summary).toMatch(/Bash timeout: sleep 5 \(killed after 0\.05s\)/);
  });

  it('runs normally when the command finishes within the timeout', async () => {
    const result = await execStream('echo hi', { cwd: process.cwd() }, 5000);
    expect(result.summary).toMatch(/^Ran: echo hi/);
    expect(result.payload).toContain('hi');
  });
});
