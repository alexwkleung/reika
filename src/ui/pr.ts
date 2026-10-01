import { execFile } from 'node:child_process';

// Which PR the current branch is attached to, for the status bar. Only `gh` knows the
// branch↔PR mapping, so this shells out to it — best-effort by design: no git repo, no
// `gh`, no auth, no network, or no PR all collapse to null and the badge just stays off.
//
// The badge carries the PR's web URL as well as its number: the number is what the status bar
// shows, the URL is what makes it click (ui/Status.tsx opens an OSC 8 hyperlink on it).

const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 4_000;
// A PR opened mid-session should appear without a restart; a merged one should stop
// showing eventually. Neither is urgent, so both TTLs sit well above the poll interval.
const MISS_TTL_MS = 60_000;
const HIT_TTL_MS = 300_000;

// The number is always there; the URL is optional, because it is only what the terminal click
// needs — `gh` reporting an open PR without one still earns the badge, just not the hyperlink.
export type PrRef = { number: number; url?: string };

type CacheEntry = { pr: PrRef | null; at: number };

const cache = new Map<string, CacheEntry>();

// Current PR for the branch checked out in `cwd`, null when there isn't one. The cached value is
// handed back by reference: App re-polls every 15s and bails out of the re-render on an unchanged
// value, which a fresh object every tick would defeat.
// `now` is passed in so the caller owns the clock (and tests don't need fake timers).
export async function resolvePr(cwd: string, now: number): Promise<PrRef | null> {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const hit = cache.get(branch);
  if (hit && isFresh(hit, now)) return hit.pr;
  const pr = await lookupPr(cwd, branch);
  cache.set(branch, { pr, at: now });
  return pr;
}

export function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.at < (entry.pr == null ? MISS_TTL_MS : HIT_TTL_MS);
}

// Empty output means detached HEAD or not a repo at all — both are "no branch" here.
export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await run('git', ['branch', '--show-current'], cwd, GIT_TIMEOUT_MS);
  return out?.trim() || null;
}

async function lookupPr(cwd: string, branch: string): Promise<PrRef | null> {
  const out = await run(
    'gh',
    ['pr', 'view', branch, '--json', 'number,state,url'],
    cwd,
    GH_TIMEOUT_MS,
  );
  return out ? parsePrView(out) : null;
}

// `gh` reports the newest PR for the branch whatever its state; a closed or merged number
// is stale the moment it lands, so only an open one earns the status-bar slot. Draft isn't
// a state (drafts are OPEN + isDraft), so they show like any other open PR — deliberate:
// the badge answers "which PR is this branch", not "is it ready".
// The URL rides along only when `gh` gave us a usable one: it is the click target, never the
// label, so its absence costs the hyperlink and nothing else.
export function parsePrView(stdout: string): PrRef | null {
  try {
    const data = JSON.parse(stdout) as { number?: unknown; state?: unknown; url?: unknown };
    if (typeof data.number !== 'number') return null;
    if (typeof data.state === 'string' && data.state.toUpperCase() !== 'OPEN') return null;
    const url = typeof data.url === 'string' && data.url ? data.url : undefined;
    return url ? { number: data.number, url } : { number: data.number };
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// Tests only — the cache is module state so a session shares it across polls.
export function resetPrCache(): void {
  cache.clear();
}
