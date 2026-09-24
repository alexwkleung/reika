#!/usr/bin/env tsx
// How much of a session's opening re-derives what an earlier session in the same project already
// established — the measurement #514 asks for before any per-project memory is built. If sessions
// rarely re-fetch the same things, AGENTS.md plus a `/remember` is the whole feature; retrieval only
// earns its complexity when this number is large.
//
// The orientation phase is every tool call in the rounds before the session's first mutation (an
// `edit`/`write`, or a `bash` that changed files). A call there is a repeat when an earlier session
// of the same project made the same call (read path, grep pattern, normalized bash command), and
// same-bytes when it also got the identical payload back — the file had not changed, so the fetch
// bought nothing a memory could not have carried. Repeats are an upper bound on what memory saves:
// a task that needs a file needs it whether or not it was read last week. Same-bytes is the tighter
// bound, and the per-key lists are what say which of the two a repeat was.
//
// A repeat only counts against an earlier session with a DIFFERENT task (its first user message).
// The history holds bench runs — the same prompt run on purpose a dozen times — and a rerun
// re-reading its own files is the experiment, not rediscovery; `--same-task` counts them anyway.
//
// Usage:
//   npx tsx evals/rediscovery-report.ts                       # ~/.config/reika/history, all projects
//   npx tsx evals/rediscovery-report.ts <dir-or-file>...      # specific sessions
//   npx tsx evals/rediscovery-report.ts --top 30 --sessions   # longer key lists, per-session rows
//   npx tsx evals/rediscovery-report.ts --same-task           # count bench reruns as repeats
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Loose on purpose: saved files span every build since #1, and a report must read old shapes
// rather than refuse them.
type SavedCall = { id: string; name: string; args?: Record<string, unknown> };
type SavedMessage = {
  role?: string;
  content?: string;
  display?: string;
  meta?: boolean;
  toolCalls?: SavedCall[];
  callId?: string;
  payload?: string;
  exitCode?: number;
  diff?: unknown;
  changes?: { files?: unknown[] };
  segment?: string;
};
type Header = { savedAt?: string; cwd?: string; model?: string; title?: string };

type Call = {
  key: string;
  tool: string;
  payloadChars: number;
  payloadHash: string | null;
  exitCode?: number;
};

type Session = {
  path: string;
  cwd: string;
  savedAt: string;
  model: string;
  title: string;
  task: string;
  orientation: Call[];
  orientationRounds: number;
  mutated: boolean;
};

const ORIENTATION_TOOLS = new Set(['read', 'list', 'grep', 'glob', 'bash', 'fetch_url', 'search']);

// `/save` redacts the home directory to `~` (auto-saves do not), so the same project arrives
// under two spellings of its cwd and its paths.
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

function relativeTo(cwd: string, raw: string): string {
  const p = expandHome(raw);
  let out = p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p === cwd ? '.' : p;
  out = out.replace(/^\.\//, '');
  return out === '' ? '.' : out;
}

// Two sessions phrase the same shell fetch differently (`git -C /abs log` vs `git log`, extra
// spaces); the key should not. Anything subtler — flag order, `head -50` vs `head -80` — is left
// distinct, which under-counts repeats rather than inventing them.
function normalizeCommand(cwd: string, cmd: string): string {
  const tilde = cwd.startsWith(homedir()) ? '~' + cwd.slice(homedir().length) : cwd;
  return cmd
    .split(tilde + '/')
    .join('')
    .split(tilde)
    .join('.')
    .split(cwd + '/')
    .join('')
    .split(cwd)
    .join('.')
    .replace(/\bgit -C \.\s+/g, 'git ')
    .replace(/^cd \.\s*&&\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function callKey(cwd: string, call: SavedCall): string {
  const a = call.args ?? {};
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (call.name) {
    case 'read':
    case 'list':
      return `${call.name} ${relativeTo(cwd, str('path') || '.')}`;
    case 'grep':
    case 'glob': {
      const where = str('path') ? ` in ${relativeTo(cwd, str('path'))}` : '';
      return `${call.name} ${str('pattern')}${where}`;
    }
    case 'bash':
      return `bash ${normalizeCommand(cwd, str('command'))}`;
    case 'fetch_url':
      return `fetch_url ${str('url')}`;
    case 'search':
      return `search ${str('query')}`;
    default:
      return call.name;
  }
}

function isMutation(call: SavedCall, result: SavedMessage | undefined): boolean {
  if (call.name === 'edit' || call.name === 'write') return true;
  return call.name === 'bash' && (result?.changes?.files?.length ?? 0) > 0;
}

function parseSession(path: string): Session | null {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  let header: Header;
  try {
    header = JSON.parse(lines[0]) as Header;
  } catch {
    return null;
  }
  if (!header.cwd) return null;
  const cwd = expandHome(header.cwd);

  const messages: SavedMessage[] = [];
  for (const line of lines.slice(1)) {
    let m: SavedMessage;
    try {
      m = JSON.parse(line) as SavedMessage;
    } catch {
      continue;
    }
    // The chat side is a separate conversation with no tools that touch the project.
    if (m.segment === 'chat') break;
    messages.push(m);
  }
  const firstUser = messages.find(m => m.role === 'user' && !m.meta);
  const task = (firstUser?.display ?? firstUser?.content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const results = new Map<string, SavedMessage>();
  for (const m of messages) if (m.role === 'tool' && m.callId) results.set(m.callId, m);

  const orientation: Call[] = [];
  let rounds = 0;
  let mutated = false;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    // The whole round that first mutates is excluded: its reads were made alongside the edit,
    // not while the model was still finding its footing.
    if (m.toolCalls.some(c => isMutation(c, results.get(c.id)))) {
      mutated = true;
      break;
    }
    rounds++;
    for (const c of m.toolCalls) {
      if (!ORIENTATION_TOOLS.has(c.name)) continue;
      const r = results.get(c.id);
      const payload = typeof r?.payload === 'string' ? r.payload : null;
      orientation.push({
        key: callKey(cwd, c),
        tool: c.name,
        payloadChars: payload?.length ?? 0,
        payloadHash: payload ? createHash('sha1').update(payload).digest('hex') : null,
        exitCode: r?.exitCode,
      });
    }
  }
  return {
    path,
    cwd,
    savedAt: header.savedAt ?? '',
    model: header.model ?? '?',
    title: header.title ?? '',
    task,
    orientation,
    orientationRounds: rounds,
    mutated,
  };
}

function collectFiles(target: string, out: string[]): void {
  const st = statSync(target, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (target.endsWith('.jsonl')) out.push(target);
    return;
  }
  for (const name of readdirSync(target)) collectFiles(join(target, name), out);
}

// A session is ordered by its file name's start stamp, not `savedAt`: an auto-save rewrites the
// header at every idle, so a long session would otherwise sort after ones it predates.
function startStamp(path: string): string {
  return basename(path);
}

// Counted per distinct task, so a bench prompt run twelve times is one voice, not twelve.
type KeyStats = { tasks: Set<string>; sameBytes: Set<string>; exitZero: Set<string> };
type Prior = { task: string; hash: string | null };

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${Math.round((100 * n) / d)}%`;
}

function kchars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function reportProject(
  cwd: string,
  sessions: Session[],
  top: number,
  perSession: boolean,
  sameTask: boolean,
): void {
  sessions.sort((a, b) => startStamp(a.path).localeCompare(startStamp(b.path)));
  // key → what earlier sessions got back for it. A key repeated within one session is the
  // read-trace's business, not memory's, so each session contributes a key once.
  const seen = new Map<string, Prior[]>();
  const stats = new Map<string, KeyStats>();
  const byTool = new Map<string, { calls: number; repeats: number }>();
  let calls = 0;
  let repeats = 0;
  let sameBytes = 0;
  let repeatChars = 0;
  let sameBytesChars = 0;
  let orientationChars = 0;
  let comparable = 0;
  const rows: string[] = [];
  const tasksSeen = new Set<string>();

  for (const s of sessions) {
    const eligible = (p: Prior): boolean => sameTask || p.task !== s.task;
    // A session with nothing eligible before it (the first, or a rerun of the only task so far)
    // has nothing to repeat, and counting it would only dilute the rate.
    const hasPrior = [...tasksSeen].some(t => sameTask || t !== s.task);
    if (hasPrior) comparable++;
    let sRepeats = 0;
    let sSame = 0;
    const added = new Set<string>();
    for (const c of s.orientation) {
      const prior = (seen.get(c.key) ?? []).filter(eligible);
      const isRepeat = prior.length > 0;
      const isSame = c.payloadHash !== null && prior.some(p => p.hash === c.payloadHash);
      if (hasPrior) {
        calls++;
        orientationChars += c.payloadChars;
        const t = byTool.get(c.tool) ?? { calls: 0, repeats: 0 };
        t.calls++;
        if (isRepeat) {
          repeats++;
          sRepeats++;
          t.repeats++;
          repeatChars += c.payloadChars;
        }
        if (isSame) {
          sameBytes++;
          sSame++;
          sameBytesChars += c.payloadChars;
        }
        byTool.set(c.tool, t);
      }
      const k = stats.get(c.key) ?? { tasks: new Set(), sameBytes: new Set(), exitZero: new Set() };
      k.tasks.add(s.task);
      if (isSame) k.sameBytes.add(s.task);
      if (c.exitCode === 0) k.exitZero.add(s.task);
      stats.set(c.key, k);
      if (!added.has(c.key)) {
        added.add(c.key);
        seen.set(c.key, [...(seen.get(c.key) ?? []), { task: s.task, hash: c.payloadHash }]);
      } else if (c.payloadHash) {
        seen.get(c.key)!.push({ task: s.task, hash: c.payloadHash });
      }
    }
    tasksSeen.add(s.task);
    const label = s.title || s.task;
    rows.push(
      `    ${basename(s.path).slice(0, 19)}  rounds=${s.orientationRounds} calls=${s.orientation.length}` +
        ` repeat=${hasPrior ? sRepeats : '—'} same=${hasPrior ? sSame : '—'}` +
        `${s.mutated ? '' : ' (no mutation)'}  ${s.model}  ${label.slice(0, 50)}`,
    );
  }

  const withOrientation = sessions.filter(s => s.orientation.length > 0).length;
  const noMutation = sessions.filter(s => !s.mutated).length;
  console.log(`\n${cwd}`);
  console.log(
    `  sessions: ${sessions.length}, distinct tasks: ${tasksSeen.size}, with orientation calls: ${withOrientation},` +
      ` never mutated: ${noMutation} (all of theirs counts as orientation)`,
  );
  console.log(
    `  orientation calls in ${comparable} comparable sessions: ${calls}, repeats ${repeats} (${pct(repeats, calls)}),` +
      ` same bytes ${sameBytes} (${pct(sameBytes, calls)})`,
  );
  console.log(
    `  orientation payload: ${kchars(orientationChars)} chars; repeats ${kchars(repeatChars)} (${pct(repeatChars, orientationChars)}),` +
      ` same bytes ${kchars(sameBytesChars)} (${pct(sameBytesChars, orientationChars)}) — ~${kchars(Math.round(sameBytesChars / 4))} tok at char/4`,
  );
  const tools = [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
  console.log(
    `  by tool (repeats/calls): ${tools.map(([t, v]) => `${t} ${v.repeats}/${v.calls}`).join(', ') || '—'}`,
  );

  const recurring = [...stats.entries()].filter(([, v]) => v.tasks.size >= 2);
  recurring.sort(
    (a, b) => b[1].tasks.size - a[1].tasks.size || b[1].sameBytes.size - a[1].sameBytes.size,
  );
  console.log(`  keys fetched by 2+ tasks: ${recurring.length}`);
  for (const [key, v] of recurring.slice(0, top)) {
    const same = v.sameBytes.size > 0 ? ` same-bytes=${v.sameBytes.size}` : '';
    console.log(`    ${String(v.tasks.size).padStart(3)} tasks  ${key.slice(0, 100)}${same}`);
  }

  // What a harvester (#514 step 2) would pick up: shell commands that succeeded across several
  // tasks are facts the harness can record as true without trusting the model.
  const harvest = [...stats.entries()]
    .filter(([key, v]) => key.startsWith('bash ') && v.exitZero.size >= 3)
    .sort((a, b) => b[1].exitZero.size - a[1].exitZero.size);
  if (harvest.length > 0) {
    console.log(`  exit-0 bash commands across 3+ tasks (harvestable):`);
    for (const [key, v] of harvest.slice(0, top)) {
      console.log(`    ${String(v.exitZero.size).padStart(3)} tasks  ${key.slice(5, 105)}`);
    }
  }
  if (perSession) {
    console.log('  per session (oldest first):');
    for (const r of rows) console.log(r);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let top = 15;
  let perSession = false;
  let sameTask = false;
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--top') top = Number(argv[++i]) || top;
    else if (argv[i] === '--sessions') perSession = true;
    else if (argv[i] === '--same-task') sameTask = true;
    else targets.push(argv[i]);
  }
  if (targets.length === 0) targets.push(join(homedir(), '.config', 'reika', 'history'));

  const files: string[] = [];
  for (const t of targets) collectFiles(t, files);
  // Grouped by the header's cwd, not the directory: /save output under the history root carries
  // its cwd too, and belongs with the project's auto-saves.
  const projects = new Map<string, Session[]>();
  for (const f of new Set(files)) {
    const s = parseSession(f);
    if (!s) continue;
    const list = projects.get(s.cwd) ?? [];
    list.push(s);
    projects.set(s.cwd, list);
  }
  if (projects.size === 0) {
    console.log('no saved sessions found');
    return;
  }
  console.log(
    'Repeats are an upper bound on what memory could save; same-bytes (identical payload to an earlier session) is the tighter one.',
  );
  const ordered = [...projects.entries()].sort((a, b) => b[1].length - a[1].length);
  // A project with one task has no earlier task to repeat; a block of zeros for it is noise.
  const skipped: string[] = [];
  for (const [cwd, sessions] of ordered) {
    const tasks = new Set(sessions.map(s => s.task));
    if (tasks.size < 2 && !sameTask) skipped.push(`${cwd} (${sessions.length})`);
    else reportProject(cwd, sessions, top, perSession, sameTask);
  }
  if (skipped.length > 0)
    console.log(`\nsingle-task projects, nothing to compare: ${skipped.join(', ')}`);
}

main();
