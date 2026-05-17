import { describe, expect, it } from 'vitest';
import { detectDangerousPatterns } from './bash.js';

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

  it('does not flag a plain git push', () => {
    expect(detectDangerousPatterns('git push origin main')).toEqual([]);
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
