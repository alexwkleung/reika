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
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type SpillRef = { path: string; bytes: number };

export function spillEnabled(): boolean {
  return process.env.REIKA_SPILL !== '0';
}

// One private directory per process — reika is one process per session, so per-process IS
// session-scoped. Removed on exit so a long-lived machine doesn't accumulate them; a crash
// leaves them to the OS's temp reaper.
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
  // Caller is inside spillResult's try/catch, so this fails open like every other spill failure.
  throw new Error('could not create a private spill directory');
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
