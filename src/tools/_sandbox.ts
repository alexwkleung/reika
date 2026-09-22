import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { maskQuoted, splitSegments, words, INSPECTION_COMMANDS } from './_readonly.js';

// Kernel-enforced confinement for model-chosen shell commands (#163). Seatbelt (`sandbox-exec`)
// only: bubblewrap has no port-level network filtering, so a sandboxed process gets its own
// loopback and cannot reach the host's model server — the one thing bash needs localhost for. The
// OCR precedent (`ocr/system.ts`) applies: ship the platform that works, report unavailable
// elsewhere, degrade to today's behavior.
//
// Nothing here bundles `sandbox-runtime` or anything else (AGENTS.md's minimal-dependency rule,
// and the issue's own "a dependency that can change any time"). The profile is ours, ~10 lines,
// and is passed inline (`-p`) — no file to write, so a fresh machine with no `~/.config/reika` yet
// is sandboxed exactly like one that has it.

// The threat model is a confused model, not a determined adversary — the same line `_paths.ts`
// draws. A blocklist of secret paths is deliberately NOT built here (#163 phase 5): `(allow
// default)` on reads keeps grep/glob/list/test running in one line instead of a /System, /usr,
// node_modules, toolchain enumeration that breaks quietly as the machine changes. That also means
// reads are open everywhere, cwd included — so a broad cwd (`$HOME`) leaves `~/.ssh` *readable* and
// `~/.zshrc` writable. Containment, stated plainly in the receipt, rather than a guarantee it
// doesn't have. What this does enforce: a command the *harness* auto-approved cannot write outside
// cwd and cannot reach past loopback — both of those genuinely.

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
export function sandboxProfile(opts: { network: boolean }): string {
  const lines = [
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
    // Temp is writable: `mktemp -d`, `cd /tmp && …` and `tempfile` are how a model scratches, and
    // denying them did worse than fail — python's `tempfile.mkdtemp()` fell through TMPDIR and /tmp
    // to its last resort, the cwd, and silently wrote `tmpXXXX` into the project (measured). The
    // bounded-damage argument holds: temp is disposable by definition, and `rm -rf` there is what
    // the model does today. The kernel sees real paths, so these are the `/private/…` forms, and
    // the per-user `$TMPDIR` (`/private/var/folders/…/T`) rides as a param since it is per machine.
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/var/tmp"))',
    '(allow file-write* (subpath (param "TMPDIR")))',
    '(allow file-write* (subpath "/dev"))',
  ];
  if (!opts.network) {
    lines.push(
      '(deny network*)',
      // Loopback stays open in BOTH directions, every port. `(remote ip)` alone — one allowed port
      // for the model server — refused `network-bind`, so any test suite that starts a local server
      // (`listen(0)` → EPERM; this repo's own transport.test.ts does) went red under the sandbox,
      // with the network footer then blaming the sandbox for the whole run. The confused-model
      // threat is what a command does to the machine and the network, and a loopback listener is
      // neither; opening it wholesale is also what lets the profile need no config at all. Two
      // rules because bind/accept match on `local ip` and connect on `remote ip`. Must come after
      // the deny (last-match-wins).
      '(allow network* (local ip "localhost:*"))',
      '(allow network* (remote ip "localhost:*"))',
    );
  }
  return lines.join('\n');
}

// Commands whose UNFLAGGED forms are network reads a session cannot do without — the shipped
// `/issue` and `/review` skills open with `gh issue view` / `gh pr view` / `gh pr diff`, and a
// `git fetch` is how a model finds out what the remote has. Their outward-facing forms (`git push`,
// `gh pr create|merge`, `gh release create`) are already in `_danger.ts`'s patterns, so they prompt
// and run unsandboxed; what is left when one of these arrives unflagged is a read plus a fetch.
// Nothing else is here on purpose: `curl`/`wget`/`ssh`/`nc` are flagged, and an interpreter
// (`python -c 'urlopen…'`, `node -e 'fetch…'`) is exactly the unbounded shape the deny is for.
const NET_VERBS = new Set(['gh', 'git', 'glab']);

// Wrappers that don't change what a segment runs (the same set `_danger.ts` strips), plus the
// keywords a compound can open with. Stripped before the verb is read.
const VERB_PREFIX_RE =
  /^(?:(?:[A-Za-z_]\w*=\S*|sudo|command|nohup|exec|env|time|if|then|else|elif|do|while|until|!)\s+)+/;

// Substitution runs a nested command the verb check never sees — tested on the RAW string, since
// `$(…)` executes inside double quotes. Same rule and same trade as `_readonly.ts`.
const SUBSTITUTION_RE = /\$\(|`|<\(|>\(/;

// `xargs` flags that take the next word as their value, so `xargs -I {} gh issue view {}` reads its
// verb as `gh`, not `{}`. `-I{}` attached is one word and drops with the flag.
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-J', '-R', '-S']);

function effectiveVerb(segment: string): string | undefined {
  const ws = words(segment.trim().replace(VERB_PREFIX_RE, ''));
  let i = 0;
  if (ws[i] === 'xargs') {
    i++;
    while (i < ws.length && ws[i].startsWith('-')) {
      if (XARGS_VALUE_FLAGS.has(ws[i])) i++;
      i++;
    }
  }
  return ws[i];
}

/**
 * Whether `command` may run sandboxed WITH network: every segment is a `NET_VERBS` command or one
 * of the read-only inspection commands a model pages their output through (`| sed -n '1,300p'`,
 * `| wc -l`, `| xargs gh …`). The writes half of the profile is unchanged either way — this only
 * decides whether `(deny network*)` is in it. An allowlist, so an unrecognized verb means denied:
 * the cost of a wrong `false` is one footer telling the model what happened, the cost of a wrong
 * `true` is the guarantee.
 */
export function networkAllowedFor(command: string): boolean {
  const c = command.trim();
  if (!c || SUBSTITUTION_RE.test(c)) return false;
  const segments = splitSegments(c, maskQuoted(c))
    .map(s => s.trim())
    .filter(s => s && !/^cd(?:\s|$)/.test(s));
  if (segments.length === 0) return false;
  let net = false;
  for (const seg of segments) {
    const verb = effectiveVerb(seg);
    if (!verb) return false;
    if (NET_VERBS.has(verb)) net = true;
    else if (!INSPECTION_COMMANDS.has(verb)) return false;
  }
  return net;
}

export type SandboxPlan = { args: string[] } | { reason: string };

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
}

/**
 * How to run a command under the sandbox, or why it can't be sandboxed.
 *
 * The only case that is genuinely void is a cwd whose `(subpath …)` covers the whole filesystem —
 * then the filesystem half of the profile asserts a protection that doesn't exist and claiming it
 * would be worse than not starting. A *broad* cwd (`$HOME`) keeps the network half plus everything
 * outside it; the two halves degrade independently, so it is sandboxed and the receipt says so.
 */
export function sandboxPlan(cwd: string, opts: { network: boolean }): SandboxPlan {
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
  let resolved: string;
  try {
    resolved = realpathSync.native(cwd);
  } catch {
    return { reason: `cwd does not resolve (${cwd})` };
  }
  // Same realpath rule for the temp dir: `os.tmpdir()` is `/var/folders/…/T`, a symlink hop away
  // from the `/private/var/…` the kernel matches. Falls back to `/private/tmp`, which the profile
  // already allows, so an unresolvable TMPDIR costs nothing rather than an unbound param (exit 65).
  let tmp = '/private/tmp';
  try {
    tmp = realpathSync.native(tmpdir());
  } catch {
    // keep the fallback
  }
  return {
    args: ['-p', sandboxProfile(opts), '-D', `WORKDIR=${resolved}`, '-D', `TMPDIR=${tmp}`],
  };
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

/** Said in the receipt rather than the summary: the model reads the summary, the user reads this. */
export function broadWorkdirNotice(cwd: string, home = homedir()): string {
  return (
    `Shell commands run sandboxed with a broad working directory (${cwd.replace(home, '~')}): ` +
    'writes are confined to it, which for this directory is most of your files. Denied outside it: ' +
    '/etc, /usr, /Library, /Applications, other volumes and other users. Read the shell command’s ' +
    'output for what a denial actually blocked.'
  );
}

/** The user-facing receipt that this cwd's auto-approved commands run sandboxed. Once per cwd, not
 *  per command: the confinement is a property of the session, and a line under every chip
 *  repeating the command the chip already shows doubled the scrollback. Not sent to the model. */
export function sandboxNotice(cwd: string, home = homedir()): string {
  return (
    `Shell commands run sandboxed: writes confined to ${cwd.replace(home, '~')} and temp dirs, ` +
    'network denied except loopback and git/gh. A command you approve at a prompt runs unsandboxed.'
  );
}

// What a Seatbelt network denial looks like from inside the client, measured under the profile:
// curl "Could not resolve host", git the same, node/npm `getaddrinfo ENOTFOUND`, python "nodename
// nor servname provided", ssh "connect to host … port 22: Operation not permitted", Go "no such
// host", wget "unable to resolve host address", pip "Temporary failure in name resolution".
const NET_DENIAL_RE =
  /could ?n.t resolve host|unable to resolve host|ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo|nodename nor servname|no such host|name resolution|network is unreachable|connect to host \S+ port \d+: Operation not permitted/i;

// Where to send the model for the page it wanted. Keyed on the turn's tool list (the #377 rule: a
// result must not point at a tool the model does not have): minimal mode is bash alone, and an
// offline session registers neither web tool, so "use fetch_url" there is a phantom pointer the
// model will spend a round discovering. Unknown reads as the full agent set.
function webRoute(toolNames?: ReadonlySet<string>): string {
  const fetch = toolNames?.has('fetch_url') ?? true;
  const search = toolNames?.has('search') ?? true;
  if (!fetch && !search) {
    return 'There is no route to the web from here: ask the user for the page or the output.';
  }
  const parts: string[] = [];
  if (fetch) parts.push('use the fetch_url tool instead of curl');
  if (search) parts.push('the search tool instead of scraping');
  return `For a web page, ${parts.join(', and ')}.`;
}

// The exec refusal the setuid note at the top of the file is about, as the shell prints it.
const PS_DENIAL_RE = /\b(?:ps|top): Operation not permitted/;

// `curl -s` prints nothing on a denial and exits 6 (could not resolve) or 7 (could not connect) —
// the one shape the output gate cannot see, so the exit status has to carry it.
const CURL_RE = /(?:^|[|;&(]\s*)(?:[A-Za-z_]\w*=\S*\s+)*curl(?![\w./-])/;

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
 * Gated on the OUTPUT carrying a denial's signature, not on the command's name. A name gate
 * (`git`, `npm`, `go`, `cargo`) fired on every red `npm test`, every `cargo test` failure and
 * `git diff --exit-code`'s exit 1 — the exact misattribution the footer exists to prevent, and one
 * that trains the model to blame the sandbox for a genuine failure. `ps` in an argument (`docker
 * ps`, `grep ps`) is the same mistake on the other note.
 */
export function sandboxFooter(
  command: string,
  code: number | null,
  output: string,
  opts: { network: boolean; toolNames?: ReadonlySet<string> },
): string {
  if (code === 0 || code === null) return '';
  const lines: string[] = [];
  if (PS_DENIAL_RE.test(output)) {
    lines.push(
      '`ps`/`top` cannot be run under the local sandbox at all — that "Operation not permitted" is ' +
        'the sandbox, not process state. Read /proc-style equivalents a plain file read can answer ' +
        '(a pid file, `lsof`, the output of the command you started) instead of retrying it.',
    );
  }
  const curlDenied = CURL_RE.test(command) && (code === 6 || code === 7);
  if (!opts.network && (NET_DENIAL_RE.test(output) || curlDenied)) {
    lines.push(
      'Network access is denied — a DNS or host error, a silent empty result, or an auth/proxy ' +
        'complaint from curl/git/npm is most likely the sandbox, not a wrong URL or a missing ' +
        'credential. ' +
        webRoute(opts.toolNames) +
        ' If the command genuinely needs the network, say so and ask the user to run it.',
    );
  }
  if (lines.length === 0) return '';
  return `\n\n(reika: this command ran in a local sandbox, so the failure above may be the sandbox rather than your command. ${lines.join(' ')} Writes are confined to the working directory and temp dirs.)`;
}
