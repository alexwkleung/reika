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
import { WORD_RE, maskQuoted, splitSegments } from './_readonly.js';
import { stripHeredocs } from './_heredoc.js';
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
const GENERIC_PACKAGE_RE = /^(?:\S+\s+){1,3}?(?:-{1,2}[\w-]+\s+)*(un)?install(?![\w./-])/;
const READ_ONLY_LEAD_RE =
  /^(?:e?grep|fgrep|rg|ag|ack|find|man|which|type|whereis|cat|bat|less|more|head|tail|awk|sed|echo|printf|ls|wc|git)\b/;

// Tools whose own patterns already describe what they do. Without this, `helm uninstall app`
// falls through to the generic label and reads as "removes third-party code" — it removes a
// release from a cluster, and a misleading label is its own bug: the warning text is what the
// user reads to decide.
const SELF_COVERED_LEAD_RE = /^(?:helm|kubectl|oc|docker|podman|terraform|tofu|pulumi)\b/;

function genericPackageLabel(command: string): string | undefined {
  for (const segment of command.split(/[;&|]+/)) {
    const seg = segment.trim();
    if (!seg || READ_ONLY_LEAD_RE.test(seg) || SELF_COVERED_LEAD_RE.test(seg)) continue;
    const m = GENERIC_PACKAGE_RE.exec(seg);
    if (m) {
      return m[1]
        ? 'Uninstall command (removes third-party code)'
        : 'Install command (fetches and runs third-party code)';
    }
  }
  return undefined;
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
const VERB_PREFIX_RE =
  /^(?:(?:[A-Za-z_]\w*=\S*|sudo|command|nohup|exec|env|time|if|then|else|elif|do|while|until|!)\s+)+/;

// Segments split on the operators AND on command substitution, so `$(curl …)` and `` `pkill …` ``
// are seen as the commands they are rather than as arguments of whatever encloses them.
// A separator inside quotes is data — `grep "a\|gh pr\|b"` is one grep, not a `gh pr` — except a
// substitution, which runs inside double quotes too.
const VERB_SEPARATOR_RE = /[\n;&|(){}]+|\$\(|`/g;

function verbSegments(command: string): string[] {
  const masked = maskQuoted(command);
  const segments: string[] = [];
  let start = 0;
  let keep = true;
  VERB_SEPARATOR_RE.lastIndex = 0;
  for (let m = VERB_SEPARATOR_RE.exec(command); m; m = VERB_SEPARATOR_RE.exec(command)) {
    if (keep) segments.push(command.slice(start, m.index));
    start = m.index + m[0].length;
    keep = m[0] === '$(' || m[0] === '`' || masked[m.index] === command[m.index];
  }
  if (keep) segments.push(command.slice(start));
  return segments;
}

function verbLabels(command: string): string[] {
  const hits: string[] = [];
  for (const segment of verbSegments(command)) {
    const seg = segment.trim().replace(VERB_PREFIX_RE, '');
    if (!seg) continue;
    for (const { re, label } of VERB_PATTERNS) {
      if (re.test(seg) && !hits.includes(label)) hits.push(label);
    }
    const cluster = clusterLabel(seg) ?? ghLabel(seg) ?? hfLabel(seg);
    if (cluster && !hits.includes(cluster)) hits.push(cluster);
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
    const words = (raw.trim().match(WORD_RE) ?? []).map(w => w.replace(/['"]/g, ''));
    if (words[0] === 'cd') {
      if (words[1]) dir = resolve(dir, expandHome(words[1]));
      continue;
    }
    yield { dir, words };
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
  for (const label of [
    ...verbLabels(command),
    remoteExecLabel(command, cwd),
    checkoutPathLabel(command, cwd),
  ]) {
    if (label && !hits.includes(label)) hits.push(label);
  }
  // The long-tail fallback only speaks up when nothing more specific did, so a `pip install`
  // reports one precise label instead of two overlapping ones. Every install/uninstall label
  // above contains the word, which is what makes this cheap test sufficient.
  if (!hits.some(h => /install/i.test(h))) {
    const generic = genericPackageLabel(command);
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
