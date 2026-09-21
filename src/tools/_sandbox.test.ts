import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { sandboxProfile, sandboxFooter, isBroadWorkdir, broadWorkdirNotice } from './_sandbox.js';

// The generator's string output, not the syscall — per AGENTS.md's "unit-test the logic the wrapper
// adds (caps, windows, footers — not the syscall)". Enforcement is verified by driving the real
// shell (see the issue's measured tables); what can be got wrong in code is the profile's ORDER and
// the footer's gating, so those are what these cover.

describe('sandboxProfile', () => {
  const profile = sandboxProfile();

  it('denies writes wholesale, then re-allows only the workdir and /dev', () => {
    const lines = profile.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write*)');
    expect(lines[3]).toBe('(allow file-write* (subpath (param "WORKDIR")))');
    expect(lines[4]).toBe('(allow file-write* (subpath "/dev"))');
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
    expect(profile).not.toMatch(/subpath "\/(?!dev)/);
  });

  it('denies network, then allows exactly one host:port back through', () => {
    const lines = profile.split('\n');
    const deny = lines.indexOf('(deny network*)');
    const allow = lines.findIndex(l => l.startsWith('(allow network*'));
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(allow).toBeGreaterThan(deny);
    expect(lines[allow]).toBe('(allow network* (remote ip (param "ALLOW_NET")))');
  });

  // Reads are deliberately open (#163 phase 5 is not built): `(allow default)` is what keeps grep,
  // glob and every test runner working without a filesystem enumeration that rots. If a read deny
  // is ever added here it must come with the carve-out list, so this asserts the decision.
  it('leaves reads open', () => {
    expect(profile).not.toContain('(deny file-read');
    expect(profile).toContain('(allow default)');
  });

  it('is a valid, complete expression set — balanced parens, one per line', () => {
    expect(profile.startsWith('(version 1)')).toBe(true);
    expect(profile.split('\n').every(l => l.startsWith('(') && l.endsWith(')'))).toBe(true);
    const opens = (profile.match(/\(/g) ?? []).length;
    const closes = (profile.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
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
  it('stays silent on success and on a signal death', () => {
    expect(sandboxFooter('curl https://x.example', 0)).toBe('');
    expect(sandboxFooter('curl https://x.example', null)).toBe('');
  });

  // The gate is the point: a footer on every non-zero exit put 350 chars of network advice under a
  // `tsc` error and a red test run, which is noise the model can act on none of.
  it('stays silent for a failure the sandbox had nothing to do with', () => {
    expect(sandboxFooter('npx vitest run src/foo.test.ts', 1)).toBe('');
    expect(sandboxFooter('grep -rn useThing src/', 1)).toBe('');
    expect(sandboxFooter('node -e "process.exit(1)"', 1)).toBe('');
  });

  it('explains the network misattribution for a network command', () => {
    const footer = sandboxFooter('curl -s https://example.com', 6);
    expect(footer).toContain('sandbox');
    expect(footer).toContain('Network access is denied');
    expect(footer).toContain('fetch_url');
  });

  // The two signals that make this worth a file: git and npm report a sandbox denial as a
  // credentials problem and a proxy problem respectively, and the footer has to pre-empt both.
  it('covers the package managers whose denial text points at credentials or a proxy', () => {
    expect(sandboxFooter('git push origin main', 128)).toContain('auth/proxy');
    expect(sandboxFooter('npm install', 1)).toContain('auth/proxy');
  });

  // Measured: `ps`/`top` cannot be exec'd under seatbelt at all, even under a bare `(allow default)`
  // profile, so allowlisting them is not an option and the footer is the only fix — and it must
  // therefore not depend on the command also looking like a network client.
  it('names ps/top as unrunnable rather than letting it read as a broken pipeline', () => {
    const footer = sandboxFooter('ps aux | grep node', 1);
    expect(footer).toContain('ps');
    expect(footer).toContain('cannot be run under the local sandbox');
  });

  it('does not mistake a word containing ps for the ps command', () => {
    expect(sandboxFooter('npx tailwindcss --help', 1)).toBe('');
    expect(sandboxFooter('ls options/', 1)).toBe('');
  });
});

// dirname('x') === 'x' is what identifies a filesystem root, and it is the one check that decides
// "do not start at all" rather than "start and say so".
describe('filesystem root detection', () => {
  it('is the dirname-is-itself test', () => {
    expect(dirname('/')).toBe('/');
    expect(dirname('/Users/someone')).not.toBe(dirname('/Users/someone').slice(1) + '/');
    expect(dirname('/Users/someone')).toBe('/Users');
  });
});
