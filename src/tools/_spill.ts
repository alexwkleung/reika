// Over-cap tool results are persisted to a session-scoped temp file so the bytes the inline page
// drops stay reachable: the model pages the file with `read`/`grep` instead of re-running the
// search with a narrower pattern, which is the shape most observed grep/glob loops take. Nothing
// new is offered to the model — the locator points at tools it already has, which is why this
// needs no schema growth and no learned behavior beyond following a path.
//
// Gated behind REIKA_SPILL so it can be A/B'd; strict no-op when off. Fail-open everywhere: a
// spill that can't be written returns null and the caller keeps its ordinary capped result. A
// successful search must never become an error because a temp file didn't land.
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SpillRef = { path: string; bytes: number };

export function spillEnabled(): boolean {
  return process.env.REIKA_SPILL === '1';
}

// One private directory per process — reika is one process per session, so per-process IS
// session-scoped. Removed on exit so a long-lived machine doesn't accumulate them; a crash
// leaves them to the OS's temp reaper.
let dir: string | undefined;

function spillDir(): string {
  if (dir) return dir;
  const d = join(tmpdir(), `reika-spill-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  process.on('exit', () => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best effort — the OS temp reaper is the backstop.
    }
  });
  dir = d;
  return d;
}

// Reset between tests; also the escape hatch if a session ever wants a fresh directory.
export function resetSpillDir(): void {
  dir = undefined;
}

// Write `content` to a fresh file and return its locator. `name` is a hint, not a path — it is
// sanitized to one path segment. Returns null when disabled or when anything at all goes wrong.
export async function spillResult(name: string, content: string): Promise<SpillRef | null> {
  if (!spillEnabled()) return null;
  try {
    // Dots are stripped along with separators: the name is a label, we supply the extension, and
    // a surviving `..` in a shared temp dir is a traversal shape nobody needs to reason about.
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'result';
    const path = join(spillDir(), `${safe}-${randomBytes(3).toString('hex')}.txt`);
    // 'wx' + 0600: exclusive and owner-only, so a planted symlink in a shared temp dir can't
    // redirect the write.
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    return { path, bytes: Buffer.byteLength(content) };
  } catch {
    return null;
  }
}

// The line appended to a capped payload. It lives in the payload rather than the summary on
// purpose: the summary is what survives payload aging, and by then the locator is stale advice —
// the model needs it at the point of recency, alongside the results it can see. Spells out both
// follow-up calls explicitly, since weak models don't infer paging from a bare path.
// `total` is a string so a caller that stopped at its own ceiling can say "1000+" rather than
// claiming an exact count it never established.
export function buildSpillFooter(opts: {
  shown: number;
  total: string;
  unit: string;
  ref: SpillRef;
  // An extra sentence about how the page was chosen, when the caller did something other than
  // take the head — the model cannot tell a sampled page from a truncated one by looking.
  note?: string;
}): string {
  const { shown, total, unit, ref } = opts;
  const note = opts.note ? `${opts.note} ` : '';
  return (
    `\n\n(Showing ${shown} of ${total} ${unit}. ${note}Full result saved to ${ref.path} — ` +
    `read that path with offset/limit to page through it, or grep it to narrow. ` +
    `Do not re-run this search to see the rest.)`
  );
}

// The honest fallback when the result was capped but the spill didn't land (disk full, no temp
// dir). Says the rest is gone rather than pointing at a file that isn't there.
export function buildCappedFooter(opts: {
  shown: number;
  total: string;
  unit: string;
  note?: string;
}): string {
  const note = opts.note ? `${opts.note} ` : '';
  return (
    `\n\n(Showing ${opts.shown} of ${opts.total} ${opts.unit}. ${note}The rest could not be saved — ` +
    `narrow the pattern or scope to see them.)`
  );
}
