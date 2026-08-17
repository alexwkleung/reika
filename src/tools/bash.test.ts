import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectDangerousPatterns, execStream, TailWindow } from './bash.js';
import { resetSpillDir } from './_spill.js';

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

  it('reports a global install as both global and a package install', () => {
    const hits = detectDangerousPatterns('npm install -g typescript');
    expect(hits).toContain('Global npm install (persistent system change)');
    expect(hits).toContain('Package install (npm/pnpm/bun)');
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

  it('flags gem install, --user or not', () => {
    expect(detectDangerousPatterns('gem install bundler')).toContain('Gem install (Ruby package)');
    expect(detectDangerousPatterns('gem install --user bundler')).toContain(
      'Gem install (Ruby package)',
    );
  });
});

describe('detectDangerousPatterns — local package installs (#131)', () => {
  it('flags a local npm install', () => {
    expect(detectDangerousPatterns('npm install typescript')).toEqual([
      'Package install (npm/pnpm/bun)',
    ]);
  });

  it('flags a bare npm install (manifest the model may have just edited)', () => {
    expect(detectDangerousPatterns('npm install')).toContain('Package install (npm/pnpm/bun)');
  });

  it('flags npm i, npm ci, pnpm add, bun add, yarn add', () => {
    for (const cmd of ['npm i lodash', 'npm ci', 'pnpm add zod', 'bun add zod']) {
      expect(detectDangerousPatterns(cmd)).toContain('Package install (npm/pnpm/bun)');
    }
    expect(detectDangerousPatterns('yarn add zod')).toContain('Package install (yarn)');
    expect(detectDangerousPatterns('yarn install')).toContain('Package install (yarn)');
  });

  it('flags pip install in its usual spellings', () => {
    for (const cmd of [
      'pip install requests',
      'pip3 install requests',
      'pip install -r requirements.txt',
      'python -m pip install requests',
      'python3.12 -m pip install --upgrade requests',
    ]) {
      expect(detectDangerousPatterns(cmd)).toContain('Python package install (pip)');
    }
  });

  it('flags the other Python package managers', () => {
    expect(detectDangerousPatterns('uv add httpx')).toContain('Python package install (uv)');
    expect(detectDangerousPatterns('uv pip install httpx')).toContain(
      'Python package install (uv)',
    );
    expect(detectDangerousPatterns('uv sync')).toContain('Python package install (uv)');
    expect(detectDangerousPatterns('poetry add httpx')).toContain(
      'Python package install (poetry/pipenv)',
    );
  });

  it('flags installs in other ecosystems', () => {
    expect(detectDangerousPatterns('cargo add serde')).toContain(
      'Rust package install (cargo add)',
    );
    expect(detectDangerousPatterns('go get github.com/x/y')).toContain(
      'Go module install (go get)',
    );
    expect(detectDangerousPatterns('composer require monolog/monolog')).toContain(
      'Package install (bundler/composer)',
    );
  });

  it('flags system package managers', () => {
    for (const cmd of ['apt-get install -y curl', 'dnf install curl', 'pacman -Syu curl']) {
      expect(detectDangerousPatterns(cmd)).toContain(
        'System package install (persistent system change)',
      );
    }
  });

  it('falls back to a generic label for unenumerated installers', () => {
    expect(detectDangerousPatterns('conda install numpy')).toEqual([
      'Install command (fetches and runs third-party code)',
    ]);
    expect(detectDangerousPatterns('make install')).toEqual([
      'Install command (fetches and runs third-party code)',
    ]);
  });

  it('does not add the generic label when a specific install pattern fired', () => {
    expect(detectDangerousPatterns('pip install requests')).toEqual([
      'Python package install (pip)',
    ]);
    expect(detectDangerousPatterns('brew install jq')).toEqual(['Homebrew install (system-level)']);
  });

  it('does NOT flag non-install commands that merely contain the word', () => {
    expect(detectDangerousPatterns('npm run install-hooks')).toEqual([]);
    expect(detectDangerousPatterns('cat install.md')).toEqual([]);
    expect(detectDangerousPatterns('npm run build')).toEqual([]);
    expect(detectDangerousPatterns('npm init -y')).toEqual([]);
    expect(detectDangerousPatterns('ls node_modules')).toEqual([]);
  });

  it('does NOT flag read-only commands that pass install as an argument', () => {
    expect(detectDangerousPatterns('grep -rn install src/')).toEqual([]);
    expect(detectDangerousPatterns('man install')).toEqual([]);
    expect(detectDangerousPatterns('which install')).toEqual([]);
  });
});

describe('detectDangerousPatterns — uninstalls', () => {
  it('flags npm/pnpm/yarn/bun removals', () => {
    for (const cmd of [
      'npm uninstall lodash',
      'npm rm lodash',
      'npm un lodash',
      'pnpm remove zod',
      'yarn remove zod',
      'bun remove zod',
    ]) {
      expect(detectDangerousPatterns(cmd)).toContain('Package uninstall (npm/pnpm/yarn/bun)');
    }
  });

  it('flags pip uninstall', () => {
    expect(detectDangerousPatterns('pip uninstall -y requests')).toContain(
      'Python package uninstall (pip)',
    );
    expect(detectDangerousPatterns('python -m pip uninstall requests')).toContain(
      'Python package uninstall (pip)',
    );
  });

  it('flags uv/poetry removals and global tool uninstalls', () => {
    expect(detectDangerousPatterns('uv remove httpx')).toContain(
      'Python package uninstall (uv/poetry/pipenv)',
    );
    expect(detectDangerousPatterns('uv tool uninstall ruff')).toContain(
      'Python package uninstall (uv/poetry/pipenv)',
    );
    expect(detectDangerousPatterns('brew uninstall jq')).toContain(
      'Package uninstall (global tool)',
    );
    expect(detectDangerousPatterns('cargo uninstall ripgrep')).toContain(
      'Package uninstall (global tool)',
    );
  });

  it('flags system package removals', () => {
    expect(detectDangerousPatterns('apt-get remove -y curl')).toContain(
      'System package uninstall (persistent system change)',
    );
    expect(detectDangerousPatterns('apt purge curl')).toContain(
      'System package uninstall (persistent system change)',
    );
    expect(detectDangerousPatterns('pacman -Rns curl')).toContain(
      'System package uninstall (persistent system change)',
    );
  });

  it('falls back to a generic uninstall label for unenumerated managers', () => {
    expect(detectDangerousPatterns('conda uninstall numpy')).toEqual([
      'Uninstall command (removes third-party code)',
    ]);
  });

  it('does NOT flag npm run, which shares a prefix with npm rm', () => {
    expect(detectDangerousPatterns('npm run test')).toEqual([]);
  });
});

describe('detectDangerousPatterns — remote package execution', () => {
  it('flags npx, bunx, uvx', () => {
    for (const cmd of ['npx create-react-app my-app', 'bunx cowsay hi', 'uvx ruff check']) {
      expect(detectDangerousPatterns(cmd)).toContain('Remote package execution (npx/bunx/uvx)');
    }
  });

  it('flags dlx and pipx run', () => {
    expect(detectDangerousPatterns('pnpm dlx create-vite')).toContain(
      'Remote package execution (dlx/pipx run)',
    );
    expect(detectDangerousPatterns('yarn dlx create-vite')).toContain(
      'Remote package execution (dlx/pipx run)',
    );
    expect(detectDangerousPatterns('pipx run ruff')).toContain(
      'Remote package execution (dlx/pipx run)',
    );
  });

  it('does NOT flag npm/bun invocations that merely start with the same letters', () => {
    expect(detectDangerousPatterns('npm test')).toEqual([]);
    expect(detectDangerousPatterns('bun test')).toEqual([]);
  });
});

describe('detectDangerousPatterns — dedupe', () => {
  it('returns each label at most once even if multiple regexes match', () => {
    // `npm install -g foo` trips the global pattern and the plain package-install pattern, so
    // the two labels it reports are distinct — no label repeats.
    const hits = detectDangerousPatterns('npm install -g typescript');
    expect(hits).toContain('Global npm install (persistent system change)');
    expect(new Set(hits).size).toBe(hits.length);
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

describe('TailWindow', () => {
  it('keeps everything while under the budget', () => {
    const w = new TailWindow(100);
    w.push('abc');
    w.push('def');
    expect(w.text()).toBe('abcdef');
    expect(w.bytes).toBe(6);
  });

  it('drops from the front once over budget, keeping the end', () => {
    const w = new TailWindow(10);
    for (const c of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd']) w.push(c);
    // Trimming stops while the window would still hold 10 bytes without its front chunk, so the
    // last two chunks survive and `bytes` reports what is retained, not what was seen.
    expect(w.text()).toBe('cccccddddd');
    expect(w.bytes).toBe(10);
  });

  it('never drops the only chunk it has, however big', () => {
    const w = new TailWindow(4);
    w.push('a'.repeat(50));
    expect(w.text()).toHaveLength(50);
    expect(w.bytes).toBe(50);
  });
});

// #139: bash stopped *draining* at the payload cap, so the tail of a long run was never read —
// exactly the bytes that matter, since a build or test failure lands at the end. The drain now
// always runs; only the retained window is bounded.
describe('execStream — spill', () => {
  const spillDirs: string[] = [];
  const cwd = process.cwd();
  // ~109KB of output, comfortably past the 64KB payload cap, with a unique last line.
  const BIG = 'seq 1 20000';

  beforeEach(() => {
    resetSpillDir();
    process.env.REIKA_SPILL = '1';
  });

  afterEach(async () => {
    delete process.env.REIKA_SPILL;
    resetSpillDir();
    for (const d of spillDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const locatorOf = (payload: string): string | undefined => {
    const hit = /saved to (\S+\.txt)/.exec(payload)?.[1];
    if (hit) spillDirs.push(dirname(hit));
    return hit;
  };

  it('saves the tail the payload cap drops, and points at it', async () => {
    const result = await execStream(BIG, { cwd });
    const payload = result.payload ?? '';

    // The payload is unchanged: still the head, still capped, still marked truncated.
    expect(payload.startsWith('1\n2\n')).toBe(true);
    expect(payload).toContain('…(truncated)');
    expect(payload).not.toContain('\n20000\n');

    const locator = locatorOf(payload);
    expect(locator).toBeTruthy();
    expect(payload).toContain('Full output saved to');
    expect(payload).toContain('Do not re-run this command to see the rest.');

    // The file holds the whole run — including the last line, which existed nowhere before.
    const saved = await readFile(locator!, 'utf8');
    expect(saved.startsWith('1\n')).toBe(true);
    expect(saved.trimEnd().endsWith('\n20000')).toBe(true);

    // The summary reports the true size now that we know it, not the 65536 it stopped counting at.
    const reported = Number(/\((\d+) bytes output\)/.exec(result.summary)![1]);
    expect(reported).toBe(saved.length);
    expect(reported).toBeGreaterThan(100_000);
  });

  it('says so honestly when the window itself dropped the middle', async () => {
    // ~4.7MB, past the 4MB window, so the head is in the payload and the tail in the file with a
    // gap between — the one case where calling the file the "full output" would be a lie.
    const result = await execStream('seq 1 700000', { cwd });
    const payload = result.payload ?? '';
    const locator = locatorOf(payload);
    expect(locator).toBeTruthy();

    expect(payload).toContain('(the middle was dropped)');
    expect(payload).toContain('The output above is the start of the run; the file holds the end.');
    expect(payload).not.toContain('Full output saved to');

    const saved = await readFile(locator!, 'utf8');
    expect(saved.startsWith('1\n')).toBe(false);
    expect(saved.trimEnd().endsWith('\n700000')).toBe(true);
    expect(saved.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  it('writes nothing when the output fits in the payload', async () => {
    const result = await execStream('echo small', { cwd });
    expect(result.payload).toContain('small');
    expect(result.payload).not.toContain('saved to');
  });

  it('is byte-identical to the capped result when the flag is off', async () => {
    const on = await execStream(BIG, { cwd });
    locatorOf(on.payload ?? '');
    delete process.env.REIKA_SPILL;
    const off = await execStream(BIG, { cwd });

    expect(off.payload).not.toContain('saved to');
    expect(off.summary).toBe('Ran: seq 1 20000 (65536 bytes output)');
    // The head both runs show is the same; only the footer and the honest byte count differ.
    const head = (p: string): string => p.slice(0, p.indexOf('…(truncated)'));
    expect(head(on.payload ?? '')).toBe(head(off.payload ?? ''));
  });
});
