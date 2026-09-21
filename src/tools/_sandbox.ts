import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Kernel-enforced confinement for model-chosen shell commands (#163). Seatbelt (`sandbox-exec`)
// only: bubblewrap has no port-level network filtering, so a sandboxed process gets its own
// loopback and cannot reach the host's model server — the one thing bash needs localhost for. The
// OCR precedent (`ocr/system.ts`) applies: ship the platform that works, report unavailable
// elsewhere, degrade to today's behavior.
//
// Nothing here bundles `sandbox-runtime` or anything else (AGENTS.md's minimal-dependency rule,
// and the issue's own "a dependency that can change any time"). The profile is ours, ~15 lines.

// The threat model is a confused model, not a determined adversary — the same line `_paths.ts`
// draws. A blocklist of secret paths is deliberately NOT built here (#163 phase 5): `(allow
// default)` on reads keeps grep/glob/list/test running in one line instead of a /System, /usr,
// node_modules, toolchain enumeration that breaks quietly as the machine changes. That also means
// reads are open everywhere, cwd included — so a broad cwd (`$HOME`) leaves `~/.ssh` *readable* and
// `~/.zshrc` writable. Containment, stated plainly in the receipt, rather than a guarantee it
// doesn't have. What this does enforce: a command the *harness* auto-approved cannot write outside
// cwd and cannot reach the network — both of those genuinely.

// `ps`/`top` are setuid and CANNOT be exec'd under seatbelt at all — measured as an unconditional
// failure, including under a bare `(version 1)(allow default)` profile with no denies in it:
//   /bin/sh: /bin/ps: Operation not permitted      (ps's own exit status 126)
//   sandbox-exec: execvp() of '/bin/ps' failed: Operation not permitted
// So this is a hard limit, not something a profile can carve out: `file-write* (subpath "/bin/ps")`,
// a `(literal …)` variant, and a profile with every subsystem allowed were each tried, and none
// moved it. #163 lists allowlisting these as an option — it is not one. That leaves only the
// affordance fix, which is why `sandboxFooter` exists and why it names `ps` explicitly rather than
// letting a model read this as a bug in its own pipeline.

// A malformed profile makes `sandbox-exec` exit 65 *without running the command* — the sandbox
// fails closed, which is the opposite of what a fail-open feature wants. Detected so the caller
// can retry unsandboxed instead of turning every command into an uninterpretable failure.
export const SANDBOX_PROFILE_ERROR_CODE = 65;
export const SANDBOX_EXEC_ERROR_PREFIX = 'sandbox-exec:';

/** Seatbelt profile for one cwd. Pure string in, string out — the unit under test. */
export function sandboxProfile(): string {
  return [
    '(version 1)',
    '(allow default)',
    // Writes: deny everything, then two narrow allows. Seatbelt is LAST-MATCH-WINS, so the order of
    // these three lines is load-bearing — and the `/dev` allow has to be last, because `/dev` is the
    // parent of `/dev/null` and therefore also contains `/dev/urandom`. Anything placed after it that
    // should win would have to be *more* specific than a whole directory, which a sibling path is not.
    //
    // `/dev` is allowed at all because `stdio: 'ignore'` gives stdin /dev/null but *shell* redirection
    // to it is a write: `npm test >/dev/null 2>&1` failed with `/bin/sh: /dev/null: Operation not
    // permitted` and took the command's exit status with it (measured; it broke a plain `npm run
    // typecheck`). That is a very common shape, and losing to it makes the sandbox unusable.
    '(deny file-write*)',
    '(allow file-write* (subpath (param "WORKDIR")))',
    '(allow file-write* (subpath "/dev"))',
    // Writes/clones outside cwd stay denied (that is the point), reads stay open — see the note at
    // the top of the file. Note that reads being open is what makes a broad cwd a stated weakening
    // rather than a hole: `~/.ssh` stays readable there, and says so in the receipt.
    '(deny network*)',
    // `(remote ip "localhost:11434")` matches that host and port only — verified: another port on the
    // same host is refused (curl rc 7). This has to come *after* the deny to win, which is why the
    // deny is not `(deny default)`: with `(allow default)` reads work for the whole filesystem and
    // the two denials here are the entire policy. Per-port allowlisting is what makes "deny all
    // network" compatible with a local model server, and why this needs no proxy.
    '(allow network* (remote ip (param "ALLOW_NET")))',
  ].join('\n');
}

// `(remote ip "localhost:11434")` matches that host and port only — verified: another port on the
// same host is refused (curl rc 7). The block has to be an explicit allow *after* `(deny network*)`
// because a remote this specific loses to the broad deny... no: it wins, which is the whole reason
// per-port allowlisting is worth having. Without it a local-model owner cannot use this at all.
function allowNetSpec(baseURL: string): string | undefined {
  let port: string;
  try {
    const u = new URL(baseURL);
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '::1') {
      return undefined;
    }
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return undefined;
  }
  return `localhost:${port}`;
}

export type SandboxPlan = { file: string; args: string[] } | { reason: string };

let profilePath: string | undefined;

/** Written once per process, outside cwd so the model's own `ls` doesn't trip over it. */
function profileFile(): string | undefined {
  if (profilePath) return profilePath;
  const dir = join(homedir(), '.config', 'reika');
  try {
    writeFileSync(join(dir, 'sandbox.sb'), sandboxProfile(), 'utf8');
  } catch {
    try {
      // First run: ~/.config/reika may not exist yet.
      writeFileSync(join(mkdirp(dir), 'sandbox.sb'), sandboxProfile(), 'utf8');
    } catch {
      return undefined;
    }
  }
  profilePath = join(dir, 'sandbox.sb');
  return profilePath;
}

function mkdirp(dir: string): string {
  const parent = dirname(dir);
  if (!existsSync(dir) && parent !== dir) mkdirp(parent);
  return dir;
}

let execAvailable: boolean | undefined;

/** Cached: the binary's presence is a property of the machine, not of the command. */
export function sandboxExecAvailable(): boolean {
  if (execAvailable === undefined) {
    execAvailable = process.platform === 'darwin' && hasSandboxExec();
  }
  return execAvailable;
}

function hasSandboxExec(): boolean {
  try {
    const r = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/bin/sh', '-c', ':'],
      {
        stdio: 'ignore',
        timeout: 5_000,
      },
    );
    return r.status !== null && r.error === undefined;
  } catch {
    return false;
  }
}

// Exported for tests, which need each case to start from a clean probe.
export function resetSandboxCache(): void {
  execAvailable = undefined;
  profilePath = undefined;
}

/**
 * How to run `command` under the sandbox, or why it can't be sandboxed.
 *
 * The only case that is genuinely void is a cwd whose `(subpath …)` covers the whole filesystem —
 * then the filesystem half of the profile asserts a protection that doesn't exist and claiming it
 * would be worse than not starting. A *broad* cwd (`$HOME`) keeps the network half plus everything
 * outside it; the two halves degrade independently, so it is sandboxed and the footer says so.
 */
export function sandboxPlan(cwd: string, baseURL: string): SandboxPlan {
  if (!sandboxExecAvailable()) {
    return { reason: process.platform === 'darwin' ? 'sandbox-exec unavailable' : 'macOS only' };
  }
  // The WORKDIR param MUST be the symlink-resolved path. Seatbelt matches `(subpath …)` against the
  // real path the kernel sees, while reika's cwd is whatever the user typed — and on macOS `/tmp` is
  // a symlink to `/private/tmp`, so `-D WORKDIR=/tmp/proj` matches NOTHING.
  //
  // That failure mode is why this comment is long: an unmatched WORKDIR means `(deny file-write*)`
  // denies the whole filesystem, *including creating any new file inside cwd* — `mkdir -p src` fails
  // with `Operation not permitted` and a heredoc can't write its target. Writes to files that already
  // exist still succeed, so it looks like a partial, confusing failure rather than a profile bug, and
  // it silently turns the sandbox into something the model cannot work in at all. Measured, and the
  // only reason it was caught is that `_treediff`'s tests failed on a tmpdir cwd.
  //
  // `realpath` also resolves the reverse case for free: a user whose project sits behind a symlink
  // gets the path the kernel will actually see.
  const root = dirname(cwd) === cwd;
  if (root) return { reason: `cwd is the filesystem root (${cwd})` };
  const resolved = realpathSync.native(cwd);
  const file = profileFile();
  if (!file) return { reason: 'could not write the sandbox profile' };
  const args = ['-f', file, '-D', `WORKDIR=${resolved}`];
  const allow = allowNetSpec(baseURL);
  if (allow) args.push('-D', `ALLOW_NET=${allow}`);
  else {
    // No local endpoint to allow through, so the param can't be left unbound (Seatbelt would
    // reject the reference at load and exit 65). Point it at a host that isn't there.
    args.push('-D', 'ALLOW_NET=localhost:1');
  }
  return { file, args };
}

/** The `spawn` argv for a sandboxed command. `-D` params, never interpolated — a cwd containing `"`
 *  or `)` would otherwise escape the `(subpath "…")` form. */
export function sandboxArgv(
  plan: SandboxPlan,
  command: string,
): { cmd: string; args: string[] } | undefined {
  if (!('args' in plan)) return undefined;
  return { cmd: '/usr/bin/sandbox-exec', args: [...plan.args, '/bin/sh', '-c', command] };
}

/** Whether this cwd is broad enough that the filesystem guarantee is visibly weaker. */
export function isBroadWorkdir(cwd: string, home = homedir()): boolean {
  return cwd === home || cwd === '/' || cwd.startsWith('/Volumes/');
}

/** Said in the footer rather than the summary: the model reads the summary, the user reads this. */
export function broadWorkdirNotice(cwd: string, home = homedir()): string {
  return (
    `Sandboxed with a broad working directory (${cwd.replace(home, '~')}): writes are confined to ` +
    'it, which for this directory is most of your files. Denied outside it: /etc, /usr, /Library, ' +
    '/Applications, other volumes and other users. Read the shell command’s output for what a ' +
    'denial actually blocked.'
  );
}

/** The one-line, user-facing receipt that a command ran sandboxed. Not sent to the model. */
export function sandboxNotice(command: string): string {
  return `Ran sandboxed (writes confined to cwd, network denied): ${command}`;
}

// The commands whose failures a model misreads as something other than a sandbox denial.
const NET_CMD_RE =
  /\b(?:curl|wget|git|gh|glab|hf|ssh|scp|rsync|ping|dig|nslookup|nc|telnet|ftp|pip|pip3|uv|npm|pnpm|yarn|bun|cargo|go|gem|brew|apt|apt-get|dnf|yum|apk|docker|kubectl|helm|terraform|aws|gcloud)\b/;

/**
 * What the model is told when a sandboxed command exits non-zero.
 *
 * Two things it has to stop, both of which are failure text a model repairs in the wrong direction.
 * Filesystem denials already name the path and the permission, so they need nothing. The other two
 * kinds do:
 *
 * - Network. A Seatbelt denial there never says "permission": `curl` reports `Could not resolve
 *   host` (rc 6, and nothing at all under `-s`), `git push` says "make sure you have the correct
 *   access rights" (SSH keys) and `npm install` says "make sure your 'proxy' config is set
 *   properly" (proxy config). Classic spiral setup.
 * - `ps`/`top`, which cannot be exec'd under seatbelt at all (see the note near the top of this
 *   file). `ps aux | grep …` is an ordinary thing to reach for — "is the server up?" — and the
 *   denial reads exactly like a broken pipeline.
 *
 * Gated on the command actually looking like one of those. Without the gate this fired on every
 * non-zero exit — `grep` with no match, a red test run — and appended a paragraph of irrelevant
 * advice to a failure the sandbox had nothing to do with.
 *
 * The `ps` note wins over the network half when a command is both (`ssh host 'ps aux'` has already
 * failed locally, as `ssh` itself, before the remote command matters).
 */
const PS_CMD_RE = /(?:^|[|;&(]\s*|\b)(?:ps|top)(?![\w./-])/;

export function sandboxFooter(command: string, code: number | null): string {
  if (code === 0 || code === null) return '';
  const lines: string[] = [];
  if (PS_CMD_RE.test(command)) {
    lines.push(
      '`ps`/`top` cannot be run under the local sandbox at all — that "Operation not permitted" is ' +
        'the sandbox, not process state. Read /proc-style equivalents a plain file read can answer ' +
        '(a pid file, `lsof`, the output of the command you started) instead of retrying it.',
    );
  }
  if (NET_CMD_RE.test(command)) {
    lines.push(
      'Network access is denied — a DNS or host error, a silent empty result, or an auth/proxy ' +
        'complaint from curl/git/npm is most likely the sandbox, not a wrong URL or a missing ' +
        'credential. For a web page, use the fetch_url tool instead of curl, and the search tool ' +
        'instead of scraping. If the command genuinely needs the network, say so and ask the user ' +
        'to run it.',
    );
  }
  if (lines.length === 0) return '';
  return `\n\n(reika: this command ran in a local sandbox, so the failure above may be the sandbox rather than your command. ${lines.join(' ')} Writes are confined to the working directory.)`;
}
