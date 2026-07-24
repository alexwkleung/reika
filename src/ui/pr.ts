import { execFile } from 'node:child_process';

// Which PR the current branch is attached to, for the status bar. Only `gh` knows the
// branch↔PR mapping, so this shells out to it — best-effort by design: no git repo, no
// `gh`, no auth, no network, or no PR all collapse to null and the badge just stays off.

const GIT_TIMEOUT_MS = 2_000;
const GH_TIMEOUT_MS = 4_000;
// A PR opened mid-session should appear without a restart; a merged one should stop
// showing eventually. Neither is urgent, so both TTLs sit well above the poll interval.
const MISS_TTL_MS = 60_000;
const HIT_TTL_MS = 300_000;

type CacheEntry = { number: number | null; at: number };

const cache = new Map<string, CacheEntry>();

// Current PR number for the branch checked out in `cwd`, null when there isn't one.
// `now` is passed in so the caller owns the clock (and tests don't need fake timers).
export async function resolvePr(cwd: string, now: number): Promise<number | null> {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const hit = cache.get(branch);
  if (hit && isFresh(hit, now)) return hit.number;
  const number = await lookupPr(cwd, branch);
  cache.set(branch, { number, at: now });
  return number;
}

export function isFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.at < (entry.number == null ? MISS_TTL_MS : HIT_TTL_MS);
}

// Empty output means detached HEAD or not a repo at all — both are "no branch" here.
export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await run('git', ['branch', '--show-current'], cwd, GIT_TIMEOUT_MS);
  return out?.trim() || null;
}

async function lookupPr(cwd: string, branch: string): Promise<number | null> {
  const out = await run('gh', ['pr', 'view', branch, '--json', 'number,state'], cwd, GH_TIMEOUT_MS);
  return out ? parsePrView(out) : null;
}

// `gh` reports the newest PR for the branch whatever its state; a closed or merged number
// is stale the moment it lands, so only an open one earns the status-bar slot. Draft isn't
// a state (drafts are OPEN + isDraft), so they show like any other open PR — deliberate:
// the badge answers "which PR is this branch", not "is it ready".
export function parsePrView(stdout: string): number | null {
  try {
    const data = JSON.parse(stdout) as { number?: unknown; state?: unknown };
    if (typeof data.number !== 'number') return null;
    if (typeof data.state === 'string' && data.state.toUpperCase() !== 'OPEN') return null;
    return data.number;
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
