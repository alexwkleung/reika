// Over-cap tool results are persisted to a session-scoped temp file so the bytes the inline page
// drops stay reachable: the model pages the file with `read`/`grep` instead of re-running the
// search with a narrower pattern, which is the shape most observed grep/glob loops take. Nothing
// new is offered to the model — the locator points at tools it already has, which is why this
// needs no schema growth and no learned behavior beyond following a path.
//
// On by default; REIKA_SPILL=0 turns it off (the polarity every other default-on switch uses),
// which is also how the A/B baseline is spelled. Strict no-op when off. Fail-open everywhere: a
// spill that can't be written returns null and the caller keeps its ordinary capped result. A
// successful search must never become an error because a temp file didn't land.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SpillRef = { path: string; bytes: number };

export function spillEnabled(): boolean {
  return process.env.REIKA_SPILL !== '0';
}

// One private directory per process — reika is one process per session, so per-process IS
// session-scoped. Removed on exit so a long-lived machine doesn't accumulate them, and swept at
// the NEXT startup when that exit never happened (`sweepStaleSpills`, #224).
//
// The name is deliberately SHORT (#144). A quantized model has to copy this path verbatim to
// follow the locator, and one was observed dropping a character out of the ~100-char original —
// turning a working recovery path into a failed `cat`, which is the loop spill exists to prevent.
// Every character here is an independent chance to slip, so the pid is gone (it bought debugging
// convenience on a directory that deletes itself) and the random suffix is 3 bytes rather than 4.
let dir: string | undefined;
let seq = 0;

const MAX_DIR_ATTEMPTS = 8;

function spillDir(): string {
  if (dir) return dir;
  // NOT `recursive: true`, which succeeds silently on a directory that already exists. A 6-hex
  // name collides far more readily than pid + 8 hex did, and the one outcome that must not happen
  // is adopting a directory somebody else — or something else — created. Exclusive create turns a
  // collision into an error we retry instead of a stranger's directory we write secrets into.
  for (let attempt = 0; attempt < MAX_DIR_ATTEMPTS; attempt++) {
    const d = join(tmpdir(), `reika-${randomBytes(3).toString('hex')}`);
    try {
      mkdirSync(d, { mode: 0o700 });
    } catch {
      continue;
    }
    // Stamp the owner before anyone can observe the directory as ours. It is what the startup
    // sweep reads to tell an abandoned directory from a live session's, so a failure here is not
    // fatal — the directory just falls back to the sweep's age guard.
    try {
      writeFileSync(join(d, OWNER_FILE), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    } catch {
      // Best effort — see above.
    }
    process.on('exit', () => {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // Best effort — the startup sweep is the backstop.
      }
    });
    dir = d;
    return d;
  }
  // Caller is inside spillResult's try/catch, so this fails open like every other spill failure.
  throw new Error('could not create a private spill directory');
}

// --- Startup sweep (#224) -------------------------------------------------------------------
//
// The `process.on('exit')` handler above only runs on a normal exit. Ctrl-C is one (`cli.tsx`
// sets `exitOnCtrlC: false` and `App` exits through Ink's `exit()`), but SIGHUP — closing the
// terminal window, the common case — SIGTERM, SIGKILL and hard crashes all skip it, leaving up to
// `SPILL_MAX_BYTES` per artifact behind with no bound on how many a session wrote.
//
// Sweeping at startup covers every one of those. Signal handlers would not: registering one
// suppresses Node's default termination, so we would own the exit in an app whose Ctrl-C
// semantics are already custom and whose `bash` sends its own SIGTERM to children — real risk for
// a temp-dir tidy that still could not catch SIGKILL.
//
// This runs even with `REIKA_SPILL=0`. The no-op-when-off rule is about what we write and what we
// offer the model; declining to clean up after an earlier session would just strand the bytes of
// somebody who turned the feature off precisely because they didn't want them.
const OWNER_FILE = '.pid';

// Only our own directories, named exactly as `spillDir` names them.
const SPILL_DIR_RE = /^reika-[0-9a-f]{6}$/;

// How long a directory with no readable owner has to sit untouched before it is reaped. Two things
// look like that: a directory written by a build from before this change, and one caught in the
// window between its `mkdir` and its owner stamp (milliseconds). The second is covered by any
// threshold at all; the first is why this is a full day rather than a few hours — the case that
// must not break is a live older session, idle overnight, whose model may still page an artifact
// it was handed. Owner-stamped directories never consult this: they are decided by liveness at
// any age, so nothing about a long idle session is at risk once one startup has gone by.
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Signal 0 is the portable "does this process exist" probe: no signal is delivered. EPERM means
// it exists and belongs to somebody else, which is emphatically alive and not ours to reap.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isAbandoned(d: string): Promise<boolean> {
  const owner = Number((await readFile(join(d, OWNER_FILE), 'utf8').catch(() => '')).trim());
  // A pid we can read decides it outright, regardless of age — the whole point is that a live
  // session idle for a day keeps its artifacts. A recycled pid reads as alive and the directory
  // survives us; that is the safe direction to be wrong in, and the OS temp reaper (macOS clears
  // `/var/folders` entries untouched for ~3 days) remains the backstop it was before.
  if (Number.isInteger(owner) && owner > 0) return !pidAlive(owner);
  return Date.now() - (await stat(d)).mtimeMs > ORPHAN_MAX_AGE_MS;
}

// Remove spill directories left behind by sessions that are gone. Returns the paths reaped, for
// tests and diagnostics. Best-effort per directory: a race with a second reika doing the same
// sweep, or with the OS reaper, is a caught error and not a failed sweep. `root` is a seam for
// tests; production always sweeps the temp dir we write to.
export async function sweepStaleSpills(root: string = tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SPILL_DIR_RE.test(entry.name)) continue;
    const d = join(root, entry.name);
    // Belt and braces: our own directory is owned by a live pid, so the check below already keeps
    // it. Saying so here means a sweep can never depend on that reasoning holding.
    if (d === dir) continue;
    try {
      if (!(await isAbandoned(d))) continue;
      await rm(d, { recursive: true, force: true });
      removed.push(d);
    } catch {
      // Gone already, or not ours to remove. Either way the next startup tries again.
    }
  }
  return removed;
}

// Every locator handed to the model this session. Kept so the loop can tell that a tool call is
// following a locator rather than doing something unrelated — the payoff half of the spill
// measurement (`_spillstats.ts`). Bounded by the number of over-cap results in a session, which is
// the quantity being measured precisely because it is small.
const handedOut = new Set<string>();

// Whether `text` names an artifact we handed out. Substring rather than equality: the model
// reaches for these inside a shell command (`tail -50 <path>`) as often as in a `read` path arg.
export function referencesSpill(text: string): boolean {
  for (const path of handedOut) if (text.includes(path)) return true;
  return false;
}

// Reset between tests; also the escape hatch if a session ever wants a fresh directory. The
// counter resets with it so a fresh directory starts numbering from 1 again.
export function resetSpillDir(): void {
  dir = undefined;
  seq = 0;
  handedOut.clear();
}

// Write `content` to a fresh file and return its locator. `name` is a hint, not a path — it is
// sanitized to one short path segment. Returns null when disabled or when anything at all goes
// wrong. Keep `name` to a few characters: it is half of what the model has to retype.
export async function spillResult(name: string, content: string): Promise<SpillRef | null> {
  if (!spillEnabled()) return null;
  try {
    // Dots are stripped along with separators: the name is a label, we supply the extension, and
    // a surviving `..` in a shared temp dir is a traversal shape nobody needs to reason about.
    // The 12-char cap is a length guard, not sanitization — a caller passing something verbose
    // shouldn't be able to hand the model a locator it can't copy.
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 12) || 'result';
    // A counter, not random hex: the directory is private to this process, so nothing else can
    // be writing into it, and `1` is four characters the model cannot transpose. `wx` below still
    // guarantees we never overwrite if that reasoning is ever wrong.
    const path = join(spillDir(), `${safe}-${++seq}.txt`);
    // 'wx' + 0600: exclusive and owner-only, so a planted symlink in a shared temp dir can't
    // redirect the write.
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    handedOut.add(path);
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
  // What the file actually holds. The search tools save everything they collected, but a caller
  // that spills a bounded window (bash keeps a tail) must say so — "Full result" would be a lie,
  // and a model told the file is complete won't think to doubt a gap in it.
  saved?: string;
  // The noun in "do not re-run this ___": a search for grep/glob, a command for bash.
  subject?: string;
}): string {
  const { shown, total, unit, ref } = opts;
  const note = opts.note ? `${opts.note} ` : '';
  const saved = opts.saved ?? 'Full result';
  return (
    `\n\n(Showing ${shown} of ${total} ${unit}. ${note}${saved} saved to ${ref.path} — ` +
    `read that path with offset/limit to page through it, or grep it to narrow. ` +
    `Do not re-run this ${opts.subject ?? 'search'} to see the rest.)`
  );
}

// The honest fallback when the result was capped but the spill didn't land (disk full, no temp
// dir). Says the rest is gone rather than pointing at a file that isn't there.
export function buildCappedFooter(opts: {
  shown: number;
  total: string;
  unit: string;
  note?: string;
  // How to get at the rest by hand, when narrowing a pattern isn't the move (bash can pipe).
  advice?: string;
}): string {
  const note = opts.note ? `${opts.note} ` : '';
  const advice = opts.advice ?? 'narrow the pattern or scope to see them';
  return (
    `\n\n(Showing ${opts.shown} of ${opts.total} ${opts.unit}. ${note}The rest could not be saved — ` +
    `${advice}.)`
  );
}
