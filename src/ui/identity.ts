import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';

// Display-only substitution of the CURRENT USER's identity — the git author name/email that
// `git log` prints, and the account slug in a GitHub/GitLab/HuggingFace remote. Like scrubPaths
// and redactSecrets, this NEVER touches what's sent to the model.
//
// This is deliberately NOT pattern-based. `github.com/<owner>` is structurally identical whether
// the owner is you or `anthropics`, and `octocat/my-quant` is identical to `Qwen/Qwen3-30B` — a
// sweep over those shapes cannot tell you from everyone else, and would scrub third-party slugs
// into unreadability. What IS knowable is who *you* are, so we look that up once and substitute
// those literals, the way scrubPaths substitutes $HOME. Third-party names survive untouched.
//
// Scope, stated plainly: this buys plausible anonymity, not real anonymity. Rewriting the owner
// in `github.com/<user>/reika` leaves the repo name, and anyone who knows the project still knows
// whose it is. It's for casual screenshots and shared transcripts, not an adversary.

export type Identity = {
  // Full name, login/slug, OS username — anything that substitutes to <user>.
  names: string[];
  // Substitutes to <email>. Held separately because these must be replaced FIRST (see below).
  emails: string[];
};

const USER = '<user>';
const EMAIL = '<email>';

// Below this length a token is dropped outright: it stops being an identifier and starts being a
// substring of ordinary words — a user.name of "Al" would rewrite "Already" into "<user>ready".
const MIN_TOKEN_LEN = 3;

// A SINGLE-WORD token shorter than this is only ever matched in a delimited position (see
// `segment`), never as a bare word. Measured motivation: plenty of real account names are also
// ordinary words or code identifiers, and word-boundary matching wrecks them —
//
//   username "max"  →  `const n = Math.max(a, b)`   became  `Math.<user>(a, b)`
//   username "mark" →  `// mark the position`       became  `// <user> the position`
//   username "dev"  →  `dev-build`                  became  `<user>-build`
//
// Silently corrupting displayed code is a far worse failure in a coding agent than leaving a
// handle visible in prose, so short tokens lose the bare-word match. There is no clean length
// cut — "grace", "victor", "oliver" are all names AND words — so this is a judgement call, not a
// derivation: 7 is where a collision with a code identifier or a common word gets rare, while
// distinctive handles (`octocat`, `alexwkleung`) still clear it. Multi-word names are exempt: a
// two-word phrase effectively can't collide, so "Mona Lisa" always matches as a phrase.
//
// The cost, stated plainly: a SHORT handle is scrubbed in paths and URLs (`github.com/max/repo`,
// `models--max--foo`) but NOT in prose (`max opened issue #5`). Raising this trades coverage for
// safety; lowering it trades safety for coverage.
const WORD_MATCH_MIN_LEN = 7;

// Hosts whose remote URLs carry an account slug in the first path segment.
const SLUG_HOSTS = ['github.com', 'gitlab.com', 'huggingface.co', 'hf.co'];

// Detection is async (git subprocesses); the scrubber is sync because it is called from render.
// So the token set lives in module state, empty until a caller loads it. Empty means no-op —
// fail-open, like every other layer here — which also makes "the flag is off" require no branch.
let rules: Array<[RegExp, string]> = [];

// Tracked separately from `rules.length`, which is 0 both when anonymization is off AND when it
// is on but detection found nothing (no git, no remote). Those are different things to report:
// the second means "on, but it has no idea who you are", which the user needs told.
let enabled = false;

// Detection result, kept so a /anon toggle re-run costs nothing after the first. The identity of
// the machine does not change mid-session; a new cwd is the one case that could add a remote
// slug, and re-detecting on /cd is not worth a subprocess batch per directory change.
let cached: Identity | null = null;

export function setIdentity(id: Identity): void {
  rules = buildRules(id);
  enabled = true;
}

export function clearIdentity(): void {
  rules = [];
  enabled = false;
}

export function isAnon(): boolean {
  return enabled;
}

// Turn anonymization on, detecting once and reusing the result thereafter. Returns what it knows
// about you so the caller can say so — "on" with an empty identity is a silent no-op otherwise.
export async function enableAnon(cwd: string): Promise<Identity> {
  if (!cached) cached = await detectIdentity(cwd);
  setIdentity(cached);
  return cached;
}

// Tests only — drops the memoized detection so a fresh one runs.
export function resetIdentityCache(): void {
  cached = null;
  clearIdentity();
}

export function scrubIdentity(s: string): string {
  let out = s;
  for (const [re, repl] of rules) out = out.replace(re, repl);
  return out;
}

// Emails first: `octocat25@example.com` CONTAINS the name token `octocat`, so substituting
// names first would leave the mangled `<user>25@example.com` instead of a clean `<email>`. Within
// each group, longest first, so "Mona Lisa" is consumed before the bare "Mona" can eat half of it.
function buildRules(id: Identity): Array<[RegExp, string]> {
  const out: Array<[RegExp, string]> = [];
  for (const email of dedupe(id.emails)) out.push([literal(email), EMAIL]);
  for (const name of dedupe(id.names)) {
    out.push(wordMatchable(name) ? [bounded(name), USER] : [segment(name), `$1${USER}`]);
  }
  return out;
}

// A multi-word name can't realistically collide with ordinary output, so it always gets the bare
// word match. A single word has to earn it by length. See WORD_MATCH_MIN_LEN.
function wordMatchable(token: string): boolean {
  return /\s/.test(token) || token.length >= WORD_MATCH_MIN_LEN;
}

function dedupe(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (trimmed.length < MIN_TOKEN_LEN) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.sort((a, b) => b.length - a.length);
}

// An email is self-delimiting, so it needs no boundary anchors — only escaping.
function literal(token: string): RegExp {
  return new RegExp(escapeRe(token), 'gi');
}

// A bare name or slug does need anchoring, or `octo` rewrites `octopus`. \b also keeps
// `octocat` from matching inside `octocat25`, which would leave a half-scrubbed token.
// Case-insensitive because remote URLs and logins are, and the display cost of a false positive
// on a differently-cased word is a `<user>` where a word was, not lost information.
function bounded(token: string): RegExp {
  return new RegExp(`\\b${escapeRe(token)}\\b`, 'gi');
}

// A short single-word token, matched ONLY where it sits as a complete path or slug segment:
// after `/` (`/home/max/x`, `github.com/max/repo`) or between the `--` pairs of a HuggingFace
// cache directory (`models--max--foo`). Those are the positions where the token is structurally
// an account name rather than a word that happens to look like one.
//
// The delimiter is captured rather than looked behind so it survives into the replacement, and
// the lookahead deliberately excludes a bare `-` and a bare start-of-string: `^dev-build` and
// `^mark the spot` would otherwise match on a single dash and a following space.
function segment(token: string): RegExp {
  return new RegExp(`(/|--)${escapeRe(token)}(?=/|--|$|[\\s'")\\],;:])`, 'gi');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Gather the current user's identity. Every source is best-effort and independently fallible:
// no git, no remote, a bare `userInfo()` — each just contributes nothing. Never throws.
export async function detectIdentity(cwd: string, timeoutMs = 2000): Promise<Identity> {
  // All four in one batch. The log scan does not depend on the others even though it is filtered
  // by the names they produce — `authorEmails` is pure and applied below, so fetching it here
  // costs nothing and keeps detection one round-trip deep instead of two.
  const [name, email, remotes, history] = await Promise.all([
    git(['config', '--get', 'user.name'], cwd, timeoutMs),
    git(['config', '--get', 'user.email'], cwd, timeoutMs),
    git(['remote', '-v'], cwd, timeoutMs),
    git(['log', '--format=%an%x00%ae', '-n', String(LOG_SCAN_COMMITS)], cwd, timeoutMs),
  ]);

  const names: string[] = [];
  const emails: string[] = [];

  // The OS username is already covered inside $HOME by scrubPaths, but not in the places that
  // spell it without the home prefix — `models--octocat--foo` in the HF cache, `git log` output,
  // a container path. Cheap to add, and it is the one token guaranteed to be present.
  try {
    names.push(userInfo().username);
  } catch {}

  if (name) names.push(name.trim());
  if (email) emails.push(email.trim());
  if (remotes) names.push(...ownerSlugs(remotes));

  // `git config user.email` is only the address you'd commit with RIGHT NOW. A repo can override
  // it locally, and commits made years ago carry whatever was configured then — so `git log` in
  // this very repo prints addresses the config never mentions. Harvest the author emails that
  // travel with a name we already recognise, which is what makes a scrubbed `git log` complete.
  if (history) emails.push(...authorEmails(history, names));

  // buildRules dedupes anyway, but the log scan yields one copy per commit — collapse here so the
  // returned Identity is something a caller can reasonably log or show.
  return { names: dedupe(names), emails: dedupe(emails) };
}

// Deep enough to cover a rename or an address change, shallow enough to stay a few milliseconds.
const LOG_SCAN_COMMITS = 500;

// Pull author emails out of `git log --format=%an%x00%ae` output, keeping only those whose author
// NAME we already recognise as the user's. Matching on the name is what keeps this from hoovering
// up every collaborator's address in a shared repo — those are other people's, and scrubbing them
// would be both wrong and a much bigger over-scrub than anything else in this file.
export function authorEmails(logOutput: string, knownNames: string[]): string[] {
  const known = new Set(knownNames.map(n => n.trim().toLowerCase()).filter(Boolean));
  const out: string[] = [];
  for (const line of logOutput.split('\n')) {
    const [author, email] = line.split('\0');
    if (!author || !email) continue;
    if (known.has(author.trim().toLowerCase())) out.push(email.trim());
  }
  return out;
}

// Pull the account slug out of every remote URL pointing at a known host, in both the SCP-ish
// (`git@github.com:owner/repo.git`) and URL (`https://github.com/owner/repo.git`) forms. A remote
// on some other host contributes nothing rather than a guess at which segment is the account.
export function ownerSlugs(remoteOutput: string): string[] {
  const out: string[] = [];
  for (const host of SLUG_HOSTS) {
    const re = new RegExp(`${escapeRe(host)}[:/]+([A-Za-z0-9._-]+)/`, 'g');
    for (const m of remoteOutput.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function git(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}
