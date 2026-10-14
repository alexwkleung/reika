import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sandboxPlan, sandboxArgv } from '../tools/_sandbox.js';

// Post-edit typecheck for JS/TS projects. The harness runs this so a weak model doesn't have
// to remember to verify its own work: after edits, we diff the project's type errors against a
// baseline captured before the edit and surface only the ones the edit *introduced*. TS/JS only
// by design (the only ecosystem with a cheap, incremental, whole-program checker on hand); other
// languages fall through to "no checker" — the same no-op as a checker that fails to run.
//
// Two halves, deliberately separated: the pure functions (parse / key / introduced / format) are
// the delta logic and carry the unit tests; the spawn-based runner is the impure shell. Everything
// fails OPEN — a missing tsconfig, absent tsc, timeout, or crashed process all resolve to "didn't
// run", never an error that could block the agent loop.

export type Severity = 'error' | 'warning';

export type Diagnostic = {
  // File path exactly as tsc emits it (relative to cwd when invoked with `-p`).
  file: string;
  line: number;
  col: number;
  severity: Severity;
  code: string; // e.g. "TS2322"
  message: string;
};

export type CheckOutcome =
  | { ran: true; diagnostics: Diagnostic[] }
  // Surfaced only to REIKA_DEBUG, never to the model: "didn't run" and "ran clean" are the same
  // outcome for the agent (proceed), but the reason keeps them distinguishable in the logs so a
  // silently-dead checker doesn't masquerade as a green check. See the debug-output note.
  | { ran: false; reason: string };

export type RunOptions = {
  tsconfigPath?: string;
  tsBuildInfoFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
// One tsc cascade can be hundreds of lines; a 16k-window model can't absorb that. Cap what the
// model sees and tell it how many were elided rather than truncating silently.
const DEFAULT_MAX_SHOWN = 10;
const MAX_MESSAGE_CHARS = 140;

// tsc's non-pretty diagnostic line: `path/to/file.ts(12,5): error TS2322: message`. The path is
// matched lazily up to the `(line,col):` anchor so Windows drive-letter paths still parse. Lines
// that don't match (message continuations, blank lines, the "Found N errors" summary) are dropped.
const DIAG_RE = /^(.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

export function parseTscOutput(raw: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const m = DIAG_RE.exec(rawLine);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4] as Severity,
      code: m[5],
      message: m[6],
    });
  }
  return out;
}

// Identity of a diagnostic for the baseline diff, keyed on file + code + message but NOT line/col.
// Line numbers are the wrong key here: an edit that adds or removes lines shifts every diagnostic
// below it, so a line-keyed diff would flag pre-existing errors as "introduced" the moment the
// edit changes the file's length. Keying on the message tolerates that shift. The tradeoff: two
// identical errors (same code + message) in one file collapse to a single key, so removing one of
// a duplicate pair won't register — a rare case, and erring toward fewer false positives is right
// for a feature whose whole job is to not nag the model about things it didn't break.
export function diagnosticKey(d: Diagnostic): string {
  return `${d.file}\0${d.code}\0${d.message}`;
}

// Errors present now that weren't in the baseline — i.e. the ones this edit is responsible for.
// Any systematic tsc quirk (a solution-style tsconfig's spurious noise, config-wide errors) is in
// both sets and cancels out, so the delta is naturally robust to whole-project weirdness.
export function introducedDiagnostics(baseline: Diagnostic[], current: Diagnostic[]): Diagnostic[] {
  const base = new Set(baseline.map(diagnosticKey));
  return current.filter(d => !base.has(diagnosticKey(d)));
}

// The model-facing block: a one-line header plus one compact line per introduced error, capped.
// Returns the empty string for an empty list so callers can treat falsy as "nothing to surface".
export function formatIntroduced(diags: Diagnostic[], max = DEFAULT_MAX_SHOWN): string {
  if (diags.length === 0) return '';
  const shown = diags.slice(0, max);
  const lines = shown.map(d => {
    const msg =
      d.message.length > MAX_MESSAGE_CHARS
        ? d.message.slice(0, MAX_MESSAGE_CHARS - 1) + '…'
        : d.message;
    return `  ${d.file}:${d.line}:${d.col} ${d.code}: ${msg}`;
  });
  const more = diags.length - shown.length;
  if (more > 0) lines.push(`  … +${more} more`);
  const n = diags.length;
  return (
    `Your edits introduced ${n} new type ${n === 1 ? 'error' : 'errors'}. ` +
    `Fix ${n === 1 ? 'it' : 'them'} before finishing:\n${lines.join('\n')}`
  );
}

export type GateDecision =
  // `userNotice` (optional) is a human-facing warning shown when finishing dirty at the cap.
  | { action: 'finish'; userNotice?: string }
  // `modelMessage` carries the introduced errors back to the model; `userNotice` tells the human.
  | { action: 'retry'; modelMessage: string; userNotice: string };

// Pure policy for the post-edit gate: given the pre-edit baseline, the final check outcome, and how
// many times the model has already been sent back this turn, decide whether to finish, send it back
// to fix the errors its edits introduced, or finish dirty because the retry cap is spent. The loop
// owns the side effects (history push, UI notice, continue/return); keeping the decision pure makes
// every branch — fail-open, clean, retry, cap — testable without driving the whole agent loop.
export function decideTypecheckGate(args: {
  baseline: Diagnostic[];
  final: CheckOutcome;
  gateRounds: number;
  maxRounds: number;
}): GateDecision {
  const { baseline, final, gateRounds, maxRounds } = args;
  if (!final.ran) return { action: 'finish' }; // couldn't verify — fail-open, let the turn end
  const introduced = introducedDiagnostics(baseline, final.diagnostics);
  const n = introduced.length;
  if (n === 0) return { action: 'finish' };
  const word = n === 1 ? 'error' : 'errors';
  if (gateRounds < maxRounds) {
    return {
      action: 'retry',
      modelMessage: formatIntroduced(introduced),
      userNotice: `Typecheck: your edits introduced ${n} new type ${word} — sent back to fix.`,
    };
  }
  return {
    action: 'finish',
    userNotice: `Typecheck: ${n} type ${word} from this turn still unresolved after ${maxRounds} attempts — finishing anyway.`,
  };
}

// ── impure shell ──────────────────────────────────────────────────────────────────────────────

// Resolve the tsconfig that governs an edit. Three layers, every one fail-open — any uncertainty
// resolves to null, which disables the gate (the same no-op as a project with no tsconfig at all)
// rather than throwing:
//   1. REIKA_TSCONFIG — explicit escape hatch for layouts auto-detection can't reason about:
//      references-only solution roots, or named-variant-only projects (tsconfig.web.json, …) with
//      no plain tsconfig.json. Honored when it resolves to a real file; a stale or typo'd value
//      falls through to auto-detect rather than silently disabling the gate.
//   2. Walk UP from the edited file to the nearest ancestor tsconfig.json, bounded at cwd so the
//      search never escapes the project root. This mirrors tsc's own config resolution, so in a
//      monorepo an edit under packages/web/ is verified against packages/web/tsconfig.json even
//      when reika runs at the repo root with no tsconfig of its own. Anchoring on the edited file
//      (not globbing names, not crawling down from root) is what gives "which config?" one answer.
//   3. No fromPath, or nothing found up to cwd, degrades to the historical behavior: cwd/tsconfig.json.
// Every fs touch is wrapped in `.catch(() => null)`, so this never rejects.
export async function detectTsProject(cwd: string, fromPath?: string): Promise<string | null> {
  const root = resolve(cwd);
  const override = process.env.REIKA_TSCONFIG;
  if (override) {
    const p = resolve(root, override);
    if (await stat(p).catch(() => null)) return p;
  }
  // Clamp the starting directory inside the project root: an edit path that resolves outside cwd
  // (e.g. "../elsewhere/x.ts") starts the walk at root rather than escaping above it.
  let dir = fromPath ? dirname(resolve(root, fromPath)) : root;
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) dir = root;
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (await stat(candidate).catch(() => null)) return candidate;
    if (dir === root) return null; // reached the project root (inclusive) without a hit
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem-root guard; unreachable while bounded at cwd
    dir = parent;
  }
}

// Prefer the project's own tsc so we typecheck with the version the project pins. No local tsc →
// skip (rather than reaching for a global/npx that could be a different version or absent).
async function resolveTscBin(cwd: string): Promise<string | null> {
  const name = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const bin = join(cwd, 'node_modules', '.bin', name);
  return (await stat(bin).catch(() => null)) ? bin : null;
}

// Park the incremental build-info file in the system temp dir, keyed by a hash of cwd, so it
// persists across edits (keeping re-checks incremental and fast) without polluting the project
// tree. tsc validates its own staleness, so a stale file across sessions is harmless.
function defaultBuildInfoFile(cwd: string): string {
  const h = createHash('sha1').update(cwd).digest('hex').slice(0, 16);
  return join(tmpdir(), `reika-tsc-${h}.tsbuildinfo`);
}

export async function runTypecheck(cwd: string, opts: RunOptions = {}): Promise<CheckOutcome> {
  const tsconfig = opts.tsconfigPath ?? (await detectTsProject(cwd));
  if (!tsconfig) return { ran: false, reason: 'no tsconfig.json' };
  const tsc = await resolveTscBin(cwd);
  if (!tsc) return { ran: false, reason: 'no local tsc binary' };
  const buildInfo = opts.tsBuildInfoFile ?? defaultBuildInfoFile(cwd);
  // `--incremental` with an explicit `--tsBuildInfoFile` is what makes the re-check cheap and is
  // accepted alongside `--noEmit` across TS versions. `--pretty false` forces the stable
  // one-line-per-diagnostic format regardless of TTY, which DIAG_RE parses. One list, used by both
  // spawns below, so the confined and unconfined runs cannot drift apart.
  const args = [
    '--noEmit',
    '--incremental',
    '--tsBuildInfoFile',
    buildInfo,
    '--pretty',
    'false',
    '-p',
    tsconfig,
  ];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Route the project-local `tsc` through the sandbox wrapper so it runs inside confinement
  // (sandbox-exec + a profile that denies writes outside cwd). The wrapper takes a shell command,
  // so the binary has to be part of the line and both it and every argument must be quoted: a bare
  // flag list would be run *as* the command (`/bin/sh -c "--noEmit …"` is an invalid option, exit
  // 2), and tsc would never start — indistinguishable from a clean check, and so a silently dead
  // gate. When the sandbox is unavailable, fall back to the direct spawn (fail-open), which is the
  // gate's standing design.
  const plan = sandboxPlan(cwd, { network: false });
  if ('args' in plan) {
    const argv = sandboxArgv(plan, [tsc, ...args].map(shellQuote).join(' '));
    if (argv) return runTscProcess(argv.cmd, argv.args, cwd, timeoutMs, opts.signal);
  }
  return runTscProcess(tsc, args, cwd, timeoutMs, opts.signal);
}

// Single-quote one argument for the `/bin/sh -c` line `sandboxArgv` builds. Every path interpolated
// into that line is user-controlled — a cwd, tsconfig, or tsbuildinfo path may contain spaces or
// quotes — so concatenating bare would split one argument into several or let a quote re-parse the
// rest. `'\''` is the only way to carry a single quote inside a single-quoted string.
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function runTscProcess(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CheckOutcome> {
  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd });
    } catch (e) {
      resolve({ ran: false, reason: `spawn failed: ${(e as Error).message}` });
      return;
    }
    let out = '';
    let settled = false;
    const finish = (r: CheckOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ran: false, reason: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ ran: false, reason: 'aborted' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // tsc writes diagnostics to stdout; collect stderr too so a process-level failure isn't lost,
    // and let DIAG_RE ignore any non-diagnostic noise.
    child.stdout?.on('data', d => (out += d.toString()));
    child.stderr?.on('data', d => (out += d.toString()));
    child.on('error', e => finish({ ran: false, reason: `process error: ${e.message}` }));
    child.on('close', () => finish({ ran: true, diagnostics: parseTscOutput(out) }));
  });
}
