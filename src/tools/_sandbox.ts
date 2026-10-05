import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  dropCarriers,
  hasExecutableSubstitution,
  hasRawSubstitution,
  maskQuoted,
  splitSegments,
  words,
  INSPECTION_COMMANDS,
} from './_readonly.js';
import { expandingHeredocBodies, stripHeredocs } from './_writetargets.js';

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
    // The repo's git dir, when it sits ABOVE cwd: a monorepo package (`packages/web/`), a worktree
    // (`.git` is a file pointing into `main/.git/worktrees/x`) or a submodule. Without it every git
    // write there — `add`, `stash`, `checkout`, even `fetch` (writes FETCH_HEAD) — fails on
    // `.git/index.lock: Operation not permitted`, which reads as a stale lock and whose natural next
    // move is `rm -f .git/index.lock` (measured). Bound to WORKDIR when the git dir is inside it or
    // there is no repo, since an unbound param exits 65.
    '(allow file-write* (subpath (param "GITDIR")))',
    // Temp is writable: `mktemp -d`, `cd /tmp && …` and `tempfile` are how a model scratches, and
    // denying them did worse than fail — python's `tempfile.mkdtemp()` fell through TMPDIR and /tmp
    // to its last resort, the cwd, and silently wrote `tmpXXXX` into the project (measured). The
    // bounded-damage argument holds: temp is disposable by definition, and `rm -rf` there is what
    // the model does today. The kernel sees real paths, so these are the `/private/…` forms, and
    // the per-user `$TMPDIR` (`/private/var/folders/…/T`) rides as a param since it is per machine.
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/var/tmp"))',
    '(allow file-write* (subpath (param "TMPDIR")))',
    // Caches too, on the same disposability argument. Some toolchains refuse to run without one: `go
    // build` exits 1 on `failed to initialize build cache at ~/Library/Caches/go-build … operation
    // not permitted` (measured), and Gradle/Maven/Xcode have the same shape. `~/.cargo`, `~/go` and
    // `~/.m2` are still denied — those are registries and artifacts, not caches, and a build that
    // needs them fails loudly with the path named rather than being guessed at here.
    '(allow file-write* (subpath (param "USERCACHE")))',
    '(allow file-write* (subpath (param "XDGCACHE")))',
    '(allow file-write* (subpath "/dev"))',
  ];
  if (!opts.network) {
    lines.push(
      '(deny network*)',
      // Loopback stays open in both directions, every port. `(remote ip)` alone — one allowed port
      // for the model server — refused `network-bind`, so any test suite that starts a local server
      // (`listen(0)` → EPERM; this repo's own transport.test.ts does) went red under the sandbox,
      // with the network footer then blaming the sandbox for the whole run. The confused-model
      // threat is what a command does to the machine and the network, and a loopback listener is
      // neither; opening it wholesale is also what lets the profile need no config at all.
      //
      // THE LOCAL-IP RULES ARE PER OPERATION, NEVER `network*`. `(allow network* (local ip
      // "localhost:*"))` admitted EVERY outbound connection: an unconnected socket has no local
      // address yet and the filter matched it, so `curl http://1.1.1.1/` returned 301 through a
      // profile whose comment said the network was denied — and the only reason `curl example.com`
      // still failed was that DNS runs over a unix socket, which was also denied. Measured, and the
      // reason `_sandbox.test.ts` pins the operation names and `bash.test.ts` connects to a raw
      // non-loopback IP. `local ip` is bind and accept; `remote ip` is connect. Last-match-wins, so
      // all of these come after the deny.
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      // Unix-domain sockets are local IPC, not the network — the docker daemon, a local database, and
      // macOS's own DNS resolver (mDNSResponder) all live there. Denied, `docker ps` failed with
      // "permission denied while trying to connect to the Docker daemon socket … connect: operation
      // not permitted", which reads as "use sudo / join the docker group". With DNS answering, an
      // internet denial now surfaces as connect() failing (`Couldn't connect to server`, EPERM)
      // rather than as an unresolved host — which is the more honest shape anyway.
      '(allow network-outbound (remote unix))',
      '(allow network-bind (local unix))',
      '(allow network-inbound (local unix))',
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
//
// `hf` is the fourth, and `hf download <repo>` is why: downloading a model is a read a user hands
// the model by name, and without this the download ran sandboxed with no network at all — surfacing
// as a connect error the model reads as a bad repo id or a missing token. It is only safe to add
// here because `_danger.ts` holds `hf` to a read-verb allowlist the way it has always held `gh`
// (`HF_READ_VERBS`): the mutating verbs (`repos create`, `jobs run`, `cache rm`, `upload`) are
// flagged, so they prompt rather than arriving unflagged — the invariant this set relies on. NOT
// added: the legacy `huggingface-cli` spelling, the same tool under an older name with its own verb
// set, which would reopen exactly the hole the `gh` allowlist closed (#265) unless it came with a
// table of its own.
const NET_VERBS = new Set(['gh', 'git', 'glab', 'hf']);

// Inspection commands that may sit in a network-allowed pipeline, plus the two other kinds of segment
// that cannot touch the network or run anything of their own:
//
// - `sleep` is inert — it neither connects nor writes nor names a program — and the read it precedes
//   is a POLL: `sleep 5 && gh pr view 609 --json mergeable,mergeStateStatus` asks GitHub to recompute
//   a state it has not finished computing, so running the read on its own reports `UNKNOWN`. Bounded
//   by the tool's own idle and ceiling timeouts, which is what stops a long one.
// - `awk` is out: its program argument can `system("curl …")`, which is the shape the deny exists for.
//   `sed`/`tree` stay — BSD sed has no shell-out, and a `w file` lands inside the write confinement
//   either way.
//
// An unlisted filter in the pipeline still denies it (`| python3 -c`, `| jq`, `| base64 -d`): that is
// the allowlist's own rule, and the model's remedy — gh's built-in `--jq`, or running the read alone —
// is one call away.
const NET_PIPE_COMMANDS = new Set([...INSPECTION_COMMANDS, 'sleep'].filter(c => c !== 'awk'));
// `find`'s exec family runs an arbitrary command per match. `git -c <key>=<value>` can name one
// through more keys than are worth enumerating — `alias.x='!cmd'`, `core.sshCommand`, `core.pager`,
// `credential.helper`, `diff.external`, `core.hooksPath` — so `-c` (and `--config-env`) is refused
// the allow outright: a `git log -c core.pager=cat` loses nothing, since only fetch/pull/clone/
// ls-remote need the network. Same class through the environment (`GIT_SSH_COMMAND=./x.sh git
// fetch`, `PAGER=./x.sh gh pr view`), so an env-assignment prefix keeps the allow only when its name
// is on a short list of settings that cannot name a program.
const FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir)$/;
const GIT_CONFIG_FLAG_RE = /^(?:-c|--config-env(?:=.*)?)$/;
const HARMLESS_ENV = new Set([
  'GIT_TERMINAL_PROMPT',
  'GIT_OPTIONAL_LOCKS',
  'GIT_ADVICE',
  'GH_NO_UPDATE_NOTIFIER',
  'GH_PROMPT_DISABLED',
  'GH_FORCE_TTY',
  'GH_REPO',
  'GH_HOST',
  // Hugging Face's own settings prefixes. A model writes `HF_HUB_ENABLE_HF_TRANSFER=1 hf download …`
  // because that is the documented speedup, and without these the download would lose the allow to
  // its own prefix — a denial with no `blockedBy` to explain it. Each value is a switch, a directory
  // or a host, none of which can name a program, which is the test this list applies. `HF_ENDPOINT`
  // is the host one, kept on the same footing as `GH_HOST` above: both redirect a CLI that is
  // already being given the network, and neither runs what the network returns.
  // `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN` are deliberately absent, on the same line that keeps
  // `GH_TOKEN` out: a credential assigned inline is worth a beat. Nothing about authentication needs
  // it — reads are open here, so `hf` finds the saved token in `~/.cache/huggingface/token` exactly
  // as it does outside the sandbox — and a token that is NOT the saved one has two routes around
  // this list: the `--token` flag (`hf download --token … gated/repo` is a `download` read, so it
  // keeps the allow) and `hf auth login`, which is flagged, prompts, and writes the token into that
  // same cache dir.
  'HF_ENDPOINT',
  'HF_HOME',
  'HF_HUB_CACHE',
  'HF_HUB_DISABLE_PROGRESS_BARS',
  'HF_HUB_DISABLE_SYMLINKS_WARNING',
  'HF_HUB_DISABLE_TELEMETRY',
  'HF_HUB_DISABLE_XET',
  'HF_HUB_ENABLE_HF_TRANSFER',
  'HF_HUB_OFFLINE',
  'HF_HUB_VERBOSITY',
  'HF_XET_HIGH_PERFORMANCE',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'FORCE_COLOR',
  'TERM',
  'LANG',
  'LC_ALL',
  'TZ',
]);
// The pager variables are allowed only when they DISABLE the pager, which is what a model sets them
// for; a value naming a program is a program the output gets piped into.
const PAGER_ENV = new Set(['PAGER', 'GIT_PAGER', 'GH_PAGER']);
const ENV_ASSIGN_RE = /^([A-Za-z_]\w*)=(.*)$/;

// Whether a segment's leading env assignments can all be trusted not to redirect what runs.
function envPrefixHarmless(segment: string): boolean {
  for (const w of words(segment.trim())) {
    const m = ENV_ASSIGN_RE.exec(w);
    if (!m) return true; // past the assignments
    const [, name, value] = m;
    if (PAGER_ENV.has(name)) {
      if (value !== '' && value !== 'cat') return false;
    } else if (!HARMLESS_ENV.has(name)) {
      return false;
    }
  }
  return true;
}
// Stderr/stdout redirection contains `&`, which `splitSegments` reads as a separator: `gh pr view 1
// 2>&1 | head` split into a segment whose verb was `1` and denied the network to the whole pipeline.
// Blanked on the masked view, length-preserving, so the raw slices still line up.
const REDIRECT_AMP_RE = /\d*>&\d*|&>>?/g;

// Wrappers that don't change what a segment runs (the same set `_danger.ts` strips), plus the
// keywords a compound can open with. Stripped before the verb is read.
const VERB_PREFIX_RE =
  /^(?:(?:[A-Za-z_]\w*=\S*|sudo|command|nohup|exec|env|time|if|then|else|elif|do|while|until|!)\s+)+/;

// Substitution runs a nested command the verb check never sees; `_readonly.ts` owns that test
// (`hasExecutableSubstitution`) so the sandbox and the plan gate cannot drift on which contexts are
// DATA.
//
// `xargs` flags that take the next word as their value, so `xargs -I {} gh issue view {}` reads its
// verb as `gh`, not `{}`. `-I{}` attached is one word and drops with the flag.
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-J', '-R', '-S']);

// Shell grammar that runs no program of its own, dropped before the verb check: a `for VAR in WORDS`
// head, whose words are the DATA the loop walks, and the bare `do`/`done` a newline split leaves
// standing alone (`for n in 610 608; do`, `gh pr view $n`, `done` on separate lines is four segments).
// Reading several PRs in one call is exactly this shape (#621), and every command inside the loop
// still has to pass on its own. `while`/`until` are NOT here: their condition is a command, so it
// stays checked — which also keeps the unbounded poll (`while true; do sleep 5; gh pr view …; done`)
// out of the allow.
const SHELL_STRUCTURE_RE = /^(?:do|done)$|^for\s+\w+\s+in(?:\s|$)/;

function effectiveVerb(segment: string): string | undefined {
  // `timeout` and `xargs` each name the command they run rather than being it, so both are skipped to
  // reach it — a carrier inside the command xargs runs included.
  let ws = dropCarriers(words(segment.trim().replace(VERB_PREFIX_RE, '')));
  if (ws[0] === 'xargs') {
    let i = 1;
    while (i < ws.length && ws[i].startsWith('-')) {
      if (XARGS_VALUE_FLAGS.has(ws[i])) i++;
      i++;
    }
    ws = dropCarriers(ws.slice(i));
  }
  return ws[0];
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
  return networkDecision(command).allowed;
}

/**
 * The classifier's verdict with, when denied, the segment that cost a `gh`/`git` pipeline its
 * allow — `git fetch && npm test` is denied because of `npm`, and the footer can say so instead of
 * "ask the user", since the model's own remedy is to run the git half by itself.
 */
export function networkDecision(command: string): { allowed: boolean; blockedBy?: string } {
  // A heredoc body is data: its lines would otherwise split into segments whose "verb" is prose,
  // and `gh issue comment 1 --body-file - <<'EOF' …` — the standard way a model writes a multi-line
  // comment — would be denied every time. That is true of the VERB question only, though: a body
  // whose delimiter was NOT quoted is expanded by the shell, so a `$(…)` in it runs on whatever
  // network the line's `git`/`gh` verb was granted, and the verb split cannot see it there. Dropped
  // bodies answer the verb question and are then re-read for the substitution one.
  const c = stripHeredocs(command).trim();
  const expanding = expandingHeredocBodies(command);
  if (!c || hasExecutableSubstitution(c) || expanding.some(hasRawSubstitution)) {
    return { allowed: false };
  }
  const masked = maskQuoted(c).replace(REDIRECT_AMP_RE, m => ' '.repeat(m.length));
  const segments = splitSegments(c, masked)
    .map(s => s.trim())
    // `cd` carries no read of its own, and the shell grammar around a loop carries no command at all.
    .filter(s => s && !/^cd(?:\s|$)/.test(s) && !SHELL_STRUCTURE_RE.test(s));
  if (segments.length === 0) return { allowed: false };
  let net = false;
  let blockedBy: string | undefined;
  for (const seg of segments) {
    const verb = effectiveVerb(seg);
    if (!verb) return { allowed: false };
    const args = words(seg);
    if (NET_VERBS.has(verb)) {
      if (!envPrefixHarmless(seg)) return { allowed: false };
      if (verb === 'git' && args.some(a => GIT_CONFIG_FLAG_RE.test(a))) return { allowed: false };
      net = true;
    } else if (!NET_PIPE_COMMANDS.has(verb)) {
      blockedBy ??= verb;
    } else if (verb === 'find' && args.some(a => FIND_EXEC_RE.test(a))) {
      return { allowed: false };
    }
  }
  if (!net) return { allowed: false };
  return blockedBy ? { allowed: false, blockedBy } : { allowed: true };
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
    // Exit 0, not just "it ran": nested inside another Seatbelt sandbox the binary exists but
    // sandbox_apply fails (exit 71), and every command would then fail instead of failing open.
    return r.status === 0 && r.error === undefined;
  } catch {
    return false;
  }
}

// Exported for tests, which need each case to start from a clean probe.
export function resetSandboxCache(): void {
  execAvailable = undefined;
  gitDirs.clear();
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
  // A symlink to `/` is the root too, and would otherwise get `(subpath "/")` under a receipt
  // claiming confinement.
  if (dirname(resolved) === resolved) return { reason: `cwd resolves to the filesystem root` };
  // Same realpath rule for every other allowed dir: `os.tmpdir()` is `/var/folders/…/T`, a symlink
  // hop away from the `/private/var/…` the kernel matches. Each falls back to a path the profile
  // already covers, so an unresolvable dir costs nothing rather than an unbound param (exit 65).
  const home = homedir();
  const params = {
    WORKDIR: resolved,
    GITDIR: gitDirOutside(cwd, resolved) ?? resolved,
    TMPDIR: realOr(tmpdir(), '/private/tmp'),
    USERCACHE: realOr(join(home, 'Library', 'Caches'), resolved),
    XDGCACHE: realOr(process.env.XDG_CACHE_HOME || join(home, '.cache'), resolved),
  };
  const args = ['-p', sandboxProfile(opts)];
  for (const [k, v] of Object.entries(params)) args.push('-D', `${k}=${v}`);
  return { args };
}

function realOr(path: string, fallback: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return fallback;
  }
}

const gitDirs = new Map<string, string | null>();

/** The repo's common git dir when it lies outside cwd, resolved; null inside cwd or without a repo.
 *  Cached per cwd — a property of the checkout, and `git rev-parse` per command is a process. */
function gitDirOutside(cwd: string, resolvedCwd: string): string | null {
  const cached = gitDirs.get(cwd);
  if (cached !== undefined) return cached;
  let dir: string | null = null;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    const abs = realOr(isAbsolute(out) ? out : resolve(cwd, out), '');
    if (abs && abs !== resolvedCwd && !abs.startsWith(resolvedCwd + sep)) dir = abs;
  } catch {
    // not a repo, or no git — nothing to allow
  }
  gitDirs.set(cwd, dir);
  return dir;
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
  // The ROOT of an external volume, not every project on one: `/Volumes/SSD/code/proj` is an
  // ordinary cwd, and telling its owner "most of your files" are exposed would be false.
  return cwd === home || cwd === '/' || /^\/Volumes\/[^/]+\/?$/.test(cwd);
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
    `Shell commands run sandboxed: writes confined to ${cwd.replace(home, '~')}, temp and cache ` +
    'dirs; network denied except loopback and git/gh/hf. A command you approve at a prompt runs unsandboxed.'
  );
}

// What a Seatbelt network denial looks like from inside the client, measured under the profile. DNS
// answers (it runs over a unix socket, which is allowed), so the denial lands on connect(): curl and
// git "Couldn't connect to server" (rc 7), node `connect EPERM`, npm `code EPERM`, python "[Errno 1]
// Operation not permitted", ssh "connect to host … port 22: Operation not permitted", docker
// "connect: operation not permitted". The resolver shapes stay for a machine whose DNS goes another
// way: "Could not resolve host", `getaddrinfo ENOTFOUND`, "nodename nor servname", "no such host".
// Python's `[Errno 1] Operation not permitted` is a network denial only WITHOUT a trailing quoted
// path — with one (`PermissionError: [Errno 1] Operation not permitted: '/Users/x/f'`) it is a write.
const NET_DENIAL_RE =
  /couldn.t connect to server|connect EPERM|code EPERM|\[Errno 1\] Operation not permitted(?!: ')|connect(?: to host \S+ port \d+)?: operation not permitted|could ?n.t resolve host|unable to resolve host|ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo|nodename nor servname|no such host|name resolution|network is unreachable/i;

// A write outside the allowed dirs, as the shell (`/bin/sh: /Users/x/f: Operation not permitted`),
// mkdir/cp/… (`mkdir: /Users/x/d: Operation not permitted`), node (`EPERM: operation not permitted,
// mkdir '/Users/x/d'`) and python (`Operation not permitted: '/Users/x/f'`) each print it — a PATH
// next to the message is what tells it apart from the network and exec shapes above.
const FS_DENIAL_RE =
  /\/[^\s:'"]+: operation not permitted|EPERM: operation not permitted, \w+ '|operation not permitted: '\//i;

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

/** True when a sandboxed command's output shows a write the profile refused. The user-facing half:
 *  the footer tells the model not to fight it, this tells the user the flag exists (`bash.ts`). */
export function sandboxRefusedWrite(output: string): boolean {
  return FS_DENIAL_RE.test(output) && !PS_DENIAL_RE.test(output);
}

/**
 * What the model is told when a sandboxed command exits non-zero.
 *
 * Three things it has to stop, all failure text a model repairs in the wrong direction. Filesystem
 * denials name the path, so they get one line only — that it is the sandbox, not something sudo
 * fixes. The other two kinds do more:
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
  if (code === null) return '';
  const lines: string[] = [];
  const ps = PS_DENIAL_RE.test(output);
  // The ps and network notes are gated on a non-zero exit as well as the text: a red run is when
  // they are read, and `curl …; echo rc=$?` exiting 0 is the model already handling it. A refused
  // write is gated on its shape alone — `mkdir ~/x; echo ok` exits 0 with the denial in its output,
  // and nothing else would attribute it.
  const failed = code !== 0;
  if (ps && failed) {
    lines.push(
      '`ps`/`top` cannot be run under the local sandbox at all — that "Operation not permitted" is ' +
        'the sandbox, not process state. Read /proc-style equivalents a plain file read can answer ' +
        '(a pid file, `lsof`, the output of the command you started) instead of retrying it.',
    );
  }
  const curlDenied = CURL_RE.test(command) && (code === 6 || code === 7);
  if (failed && !opts.network && (NET_DENIAL_RE.test(output) || curlDenied)) {
    // A gh/git/hf pipeline denied because of a sibling command has a remedy the model can apply
    // itself, and "ask the user" would be the wrong one.
    const { blockedBy } = networkDecision(command);
    lines.push(
      blockedBy
        ? `Network access is denied — this pipeline ran without it because it also contained \`${blockedBy}\`; git, gh and hf keep the network only when run on their own (pipes into grep/head/sed/wc, a \`timeout N\` wrapper, a \`sleep N &&\` wait and a \`for …; do …; done\` loop all keep it). Run the git/gh/hf command as its own bash call.`
        : 'Network access is denied — a DNS or host error, a silent empty result, or an auth/proxy ' +
            'complaint from curl/git/npm is most likely the sandbox, not a wrong URL or a missing ' +
            'credential. ' +
            webRoute(opts.toolNames) +
            ' If the command genuinely needs the network, say so and ask the user to run it.',
    );
  }
  // `/bin/ps: Operation not permitted` is a path too, and already explained above.
  if (!ps && FS_DENIAL_RE.test(output)) {
    lines.push(
      'A write outside the working directory, temp and cache dirs was refused by the sandbox — not ' +
        'a permissions problem, so do not reach for sudo or chmod. If the command must write there, ' +
        'say so and ask the user to run it.',
    );
  }
  if (lines.length === 0) return '';
  return `\n\n(reika: this command ran in a local sandbox, so the failure above may be the sandbox rather than your command. ${lines.join(' ')} Writes are confined to the working directory, temp and cache dirs.)`;
}
