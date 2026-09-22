import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import {
  sandboxProfile,
  sandboxFooter,
  isBroadWorkdir,
  broadWorkdirNotice,
  networkAllowedFor,
} from './_sandbox.js';

// The generator's string output, not the syscall — per AGENTS.md's "unit-test the logic the wrapper
// adds (caps, windows, footers — not the syscall)". Enforcement is verified by driving the real
// shell (see the issue's measured tables); what can be got wrong in code is the profile's ORDER, the
// network classifier and the footer's gating, so those are what these cover.

describe('sandboxProfile', () => {
  const profile = sandboxProfile({ network: false });

  it('denies writes wholesale, then re-allows only the workdir, temp and /dev', () => {
    const lines = profile.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write*)');
    expect(lines[3]).toBe('(allow file-write* (subpath (param "WORKDIR")))');
    // Temp by its REAL paths: `/tmp` is a symlink to `/private/tmp` and the kernel matches the
    // target, so `(subpath "/tmp")` would allow nothing. Denying temp made python's mkdtemp fall
    // through to cwd and write scratch into the project.
    expect(lines[4]).toBe('(allow file-write* (subpath "/private/tmp"))');
    expect(lines[5]).toBe('(allow file-write* (subpath "/private/var/tmp"))');
    expect(lines[6]).toBe('(allow file-write* (subpath (param "TMPDIR")))');
    expect(lines[7]).toBe('(allow file-write* (subpath "/dev"))');
    expect(lines.filter(l => l.startsWith('(allow file-write*'))).toHaveLength(5);
  });

  // Seatbelt is last-match-wins, and this is the one ordering constraint that has a failure mode
  // worse than "a write is allowed": `/dev` is the PARENT of `/dev/null`, so anything placed after
  // it that is meant to win must be more specific than a whole directory — and a sibling path is
  // not. Getting this backwards silently re-allows `/dev/urandom`.
  it('puts the /dev allow last among the write rules', () => {
    const writeRules = profile.split('\n').filter(l => l.startsWith('(allow file-write*'));
    expect(writeRules[writeRules.length - 1]).toContain('/dev');
  });

  it('allows the workdir by param, never by interpolation', () => {
    // A cwd containing `"` or `)` would escape `(subpath "…")`. There must be no literal path.
    expect(profile).toContain('(param "WORKDIR")');
    expect(profile).toContain('(param "TMPDIR")');
    expect(profile).not.toMatch(/subpath "\/(?!dev|private\/(?:tmp|var\/tmp)")/);
  });

  // Both directions and every port: `(remote ip)` alone refused `network-bind`, so a test suite
  // starting a local server went red under the sandbox. Measured under this exact profile:
  // `listen(0)` + a loopback GET succeed on 127.0.0.1 and ::1, `curl https://…` exits 6.
  it('denies network, then re-allows loopback in both directions', () => {
    const lines = profile.split('\n');
    const deny = lines.indexOf('(deny network*)');
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(lines.slice(deny + 1)).toEqual([
      '(allow network* (local ip "localhost:*"))',
      '(allow network* (remote ip "localhost:*"))',
    ]);
    expect(profile).not.toContain('ALLOW_NET');
  });

  it('drops the network rules entirely for a network-allowed command, keeping the write rules', () => {
    const net = sandboxProfile({ network: true });
    expect(net).not.toContain('network');
    expect(net.split('\n').slice(0, 8)).toEqual(profile.split('\n').slice(0, 8));
  });

  // Reads are deliberately open (#163 phase 5 is not built): `(allow default)` is what keeps grep,
  // glob and every test runner working without a filesystem enumeration that rots. If a read deny
  // is ever added here it must come with the carve-out list, so this asserts the decision.
  it('leaves reads open', () => {
    expect(profile).not.toContain('(deny file-read');
    expect(profile).toContain('(allow default)');
  });

  it('is a valid, complete expression set — balanced parens, one per line', () => {
    for (const p of [profile, sandboxProfile({ network: true })]) {
      expect(p.startsWith('(version 1)')).toBe(true);
      expect(p.split('\n').every(l => l.startsWith('(') && l.endsWith(')'))).toBe(true);
      const opens = (p.match(/\(/g) ?? []).length;
      const closes = (p.match(/\)/g) ?? []).length;
      expect(opens).toBe(closes);
    }
  });
});

// The network half is per command: `gh`/`git` reads keep it (the shipped skills open with them and
// their mutating forms are flagged → prompted → unsandboxed anyway), everything else is denied past
// loopback. An allowlist — a wrong `false` costs a footer, a wrong `true` costs the guarantee.
describe('networkAllowedFor', () => {
  it('allows the unflagged gh/git reads the shipped skills open with', () => {
    expect(networkAllowedFor('gh pr view 436 --json title,body')).toBe(true);
    expect(networkAllowedFor('gh issue view 163 --json body')).toBe(true);
    expect(networkAllowedFor('git fetch origin && git log --oneline main..origin/main')).toBe(true);
    expect(networkAllowedFor('git ls-remote origin')).toBe(true);
    expect(networkAllowedFor('glab mr view 12')).toBe(true);
  });

  it('keeps the allow through the inspection pipeline a model pages with', () => {
    expect(networkAllowedFor("gh pr diff 436 | sed -n '1,300p'")).toBe(true);
    expect(networkAllowedFor('gh pr diff 436 | wc -l')).toBe(true);
    expect(networkAllowedFor('gh pr diff 436 | grep -n "^+++" | head -20')).toBe(true);
    expect(networkAllowedFor('cd sub && git pull')).toBe(true);
  });

  // The `/review` skill's own line: xargs runs its argument command, so that is the verb read.
  it('reads through xargs to the command it runs', () => {
    expect(
      networkAllowedFor(
        "gh pr view 5 --json closingIssuesReferences --jq '.closingIssuesReferences[].number' | xargs -I{} gh issue view {} --json number,title",
      ),
    ).toBe(true);
    expect(
      networkAllowedFor('gh pr list --json number --jq ".[].number" | xargs -n 1 gh pr view'),
    ).toBe(true);
    expect(networkAllowedFor('echo x | xargs -I {} curl {}')).toBe(false);
  });

  it('denies a pipeline with an unrecognized verb in it', () => {
    expect(
      networkAllowedFor('gh pr diff 436 | python3 -c "import sys; print(sys.stdin.read())"'),
    ).toBe(false);
    expect(networkAllowedFor('git fetch && npm install')).toBe(false);
    expect(networkAllowedFor('gh api /user; node -e "fetch(\'https://x.example\')"')).toBe(false);
  });

  it('denies the commands the deny exists for', () => {
    expect(networkAllowedFor('curl -s https://example.com')).toBe(false);
    expect(networkAllowedFor('ssh host "ps aux"')).toBe(false);
    expect(networkAllowedFor('python3 -c "import urllib.request"')).toBe(false);
    expect(networkAllowedFor('npm view left-pad version')).toBe(false);
    expect(networkAllowedFor('wget https://example.com')).toBe(false);
  });

  it('denies when a substitution could smuggle a second command', () => {
    expect(networkAllowedFor('gh pr view $(cat n.txt)')).toBe(false);
    expect(networkAllowedFor('git log `curl -s x`')).toBe(false);
  });

  it('is not fooled by a net verb in an argument or a quoted separator', () => {
    expect(networkAllowedFor('echo gh')).toBe(false);
    expect(networkAllowedFor('grep -rn "git fetch" src/')).toBe(false);
    expect(networkAllowedFor('cat "a;git fetch"')).toBe(false);
    expect(networkAllowedFor('')).toBe(false);
    expect(networkAllowedFor('cd sub')).toBe(false);
  });

  it('sees through env assignments and wrappers to the verb', () => {
    expect(networkAllowedFor('GH_PAGER= gh pr view 1')).toBe(true);
    expect(networkAllowedFor('GIT_TERMINAL_PROMPT=0 git fetch --all')).toBe(true);
    expect(networkAllowedFor('time git clone https://example.com/r.git')).toBe(true);
  });
});

describe('isBroadWorkdir', () => {
  // The two halves of the profile degrade independently, so a broad cwd is sandboxed and *said* —
  // the case that is genuinely void is the filesystem root, which is a different check entirely.
  it('flags home and the filesystem root and volumes', () => {
    expect(isBroadWorkdir('/Users/someone', '/Users/someone')).toBe(true);
    expect(isBroadWorkdir('/', '/Users/someone')).toBe(true);
    expect(isBroadWorkdir('/Volumes/Backup', '/Users/someone')).toBe(true);
  });

  it('does not flag an ordinary project', () => {
    expect(isBroadWorkdir('/Users/someone/Git/repo', '/Users/someone')).toBe(false);
    expect(isBroadWorkdir('/tmp/x', '/Users/someone')).toBe(false);
  });

  it('names what is and is not covered, with the home path abbreviated', () => {
    const notice = broadWorkdirNotice('/Users/someone', '/Users/someone');
    expect(notice).toContain('(~)');
    expect(notice).toContain('/etc');
    expect(notice).not.toContain('/Users/someone');
  });
});

describe('sandboxFooter', () => {
  const denied = { network: false };
  const curlDns = 'curl: (6) Could not resolve host: example.com\n';

  it('stays silent on success and on a signal death', () => {
    expect(sandboxFooter('curl https://x.example', 0, curlDns, denied)).toBe('');
    expect(sandboxFooter('curl https://x.example', null, curlDns, denied)).toBe('');
  });

  // The gate is the point, and it is on the OUTPUT: a gate on the command's name fired on every red
  // `npm test`, every `cargo test` failure and `git diff --exit-code`'s exit 1, blaming the sandbox
  // for genuine failures — the exact misattribution the footer exists to prevent.
  it('stays silent for a failure the sandbox had nothing to do with', () => {
    expect(sandboxFooter('npx vitest run src/foo.test.ts', 1, 'FAIL 3 tests\n', denied)).toBe('');
    expect(sandboxFooter('grep -rn useThing src/', 1, '', denied)).toBe('');
    expect(sandboxFooter('node -e "process.exit(1)"', 1, '', denied)).toBe('');
    expect(sandboxFooter('npm test', 1, 'AssertionError: expected 1 to be 2\n', denied)).toBe('');
    expect(sandboxFooter('git diff --exit-code', 1, 'diff --git a/x b/x\n', denied)).toBe('');
    expect(sandboxFooter('cargo test', 101, 'test result: FAILED. 1 failed\n', denied)).toBe('');
  });

  it('explains the network misattribution when the output carries a denial', () => {
    const footer = sandboxFooter('curl https://example.com', 6, curlDns, denied);
    expect(footer).toContain('sandbox');
    expect(footer).toContain('Network access is denied');
    expect(footer).toContain('fetch_url');
  });

  // `curl -s` prints nothing and exits 6: the exit status is the only signal, so it carries it.
  it('catches a silent curl by its exit status', () => {
    expect(sandboxFooter('curl -s -m 3 https://example.com', 6, '', denied)).toContain(
      'Network access is denied',
    );
    expect(sandboxFooter('curl -s http://10.0.0.1/', 7, '', denied)).toContain(
      'Network access is denied',
    );
    // Any other status is curl's own complaint about the request, not a denial.
    expect(sandboxFooter('curl -f https://example.com/404', 22, '', denied)).toBe('');
  });

  // Measured under the profile: the denial texts each client actually prints. git and npm report a
  // credentials problem and a proxy problem respectively, so the footer pre-empts both.
  it('recognises each client’s denial text', () => {
    const cases: Array<[string, number, string]> = [
      [
        'git push origin main',
        128,
        "fatal: unable to access 'https://…': Could not resolve host: github.com\n",
      ],
      [
        'git ls-remote origin',
        128,
        'ssh: connect to host github.com port 22: Operation not permitted\n',
      ],
      ['npm install', 1, 'npm error code ENOTFOUND\nnpm error syscall getaddrinfo\n'],
      [
        'python3 fetch.py',
        1,
        'URLError: <urlopen error [Errno 8] nodename nor servname provided, or not known>\n',
      ],
      ['go get example.com/m', 1, 'dial tcp: lookup proxy.golang.org: no such host\n'],
      ['pip install x', 1, 'Temporary failure in name resolution\n'],
    ];
    for (const [cmd, code, out] of cases) {
      expect(sandboxFooter(cmd, code, out, denied), cmd).toContain('auth/proxy');
    }
  });

  // Minimal mode is bash alone and an offline session registers neither web tool: naming fetch_url
  // there is the phantom pointer #377 is about. `curl` is what the model reaches for in that mode.
  it('does not point at fetch_url or search when the turn does not offer them', () => {
    const minimal = sandboxFooter('curl -s https://example.com', 6, '', {
      network: false,
      toolNames: new Set(['bash', 'ask_user']),
    });
    expect(minimal).toContain('Network access is denied');
    expect(minimal).not.toContain('fetch_url');
    expect(minimal).not.toContain('search tool');
    expect(minimal).toContain('ask the user');
    const fetchOnly = sandboxFooter('curl -s https://example.com', 6, '', {
      network: false,
      toolNames: new Set(['bash', 'fetch_url']),
    });
    expect(fetchOnly).toContain('fetch_url');
    expect(fetchOnly).not.toContain('search tool');
  });

  // A command that ran WITH network (a `gh` read) cannot have been denied it, so a DNS error there is
  // the machine's, not the sandbox's — no footer, or it would send the model to fetch_url for
  // something fetch_url cannot do either.
  it('never blames a network-allowed run for a network error', () => {
    expect(
      sandboxFooter('gh pr view 1', 1, 'error connecting to api.github.com\n', { network: true }),
    ).toBe('');
    expect(
      sandboxFooter('git fetch', 128, 'Could not resolve host: github.com\n', { network: true }),
    ).toBe('');
  });

  // Measured: `ps`/`top` cannot be exec'd under seatbelt at all, even under a bare `(allow default)`
  // profile, so allowlisting them is not an option and the footer is the only fix — keyed on the
  // shell's own refusal line, so it does not depend on the command also looking like a network
  // client, and cannot fire on `docker ps` or `grep ps` either.
  it('names ps/top as unrunnable rather than letting it read as a broken pipeline', () => {
    const footer = sandboxFooter(
      'ps aux | grep node',
      1,
      '/bin/sh: /bin/ps: Operation not permitted\n',
      denied,
    );
    expect(footer).toContain('ps');
    expect(footer).toContain('cannot be run under the local sandbox');
    expect(
      sandboxFooter('top -l 1', 126, '/bin/sh: /usr/bin/top: Operation not permitted\n', denied),
    ).toContain('cannot be run under the local sandbox');
  });

  it('does not mistake ps in an argument for the ps command', () => {
    expect(sandboxFooter('docker ps', 1, 'Cannot connect to the Docker daemon\n', denied)).toBe('');
    expect(sandboxFooter('grep -c ps file', 1, '', denied)).toBe('');
    expect(sandboxFooter('npx tailwindcss --help', 1, '', denied)).toBe('');
    expect(sandboxFooter('ls options/', 1, '', denied)).toBe('');
  });
});

// dirname('x') === 'x' is what identifies a filesystem root, and it is the one check that decides
// "do not start at all" rather than "start and say so".
describe('filesystem root detection', () => {
  it('is the dirname-is-itself test', () => {
    expect(dirname('/')).toBe('/');
    expect(dirname('/Users/someone')).toBe('/Users');
  });
});
