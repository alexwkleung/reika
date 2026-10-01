import type { Message } from '../types.js';

// Plan progress tracking (#68/#71). The written plan (the `planFinal` message) is parsed into
// numbered steps, and steps are checked off from harness-observed facts — never from model
// judgment. Three observable facts check a step off, tried in order: a successful edit/write to a
// file the step names (path match); a step-quoted code snippet appearing in a successful edit's
// diff (content match — covers the plan naming the WRONG file while the model correctly edits the
// right one); and a successful bash run whose command contains the step's quoted command (command
// match — covers "run the tests" steps). Deterministic by construction: the same history always
// yields the same checklist, and it's recomputed from history each turn (the same stateless
// recompute discipline as distillPlanHandoff) so progress survives across turns without stored
// state. The checklist feeds the UI unconditionally; the model-facing pieces (the progress ledger
// + the done-gate) are gated behind REIKA_PLAN_ALIGN in loop.ts.

export type PlanStep = {
  // Ordinal position in the plan (1-based), NOT the written number — sections restart written
  // numbering, and n must be unique (it keys planWaived and all gate/ledger references).
  n: number;
  // First line of the step, for the checklist and ledger.
  text: string;
  // File paths the step names. The primary check-off signal and (with commands) what the done-gate
  // enforces.
  paths: string[];
  // Code the step quotes inline (a CSS rule, an old_string, a selector). Fallback check-off signal:
  // the plan may name the wrong file while the quoted code pins the real edit site. Never enforced
  // by the gate — a matching aid only.
  snippets: string[];
  // Shell commands the step quotes (`npm test …`). Checked off by a successful bash run containing
  // them; enforced by the gate like paths. A step with none of the three is display-only.
  commands: string[];
  done: boolean;
  // Set when the done-gate spent its bounce and the model finished anyway: adjudicated, not done.
  // A waived step is never re-asked on later turns and renders distinctly (~) in the UI/ledger.
  waived: boolean;
};

// Bound the model-facing ledger: a very long plan must not eat a small window.
const MAX_LEDGER_STEPS = 20;
const MAX_STEP_TEXT = 90;
// One bounce per turn, like MAX_TYPECHECK_GATE_ROUNDS: a model that ignores the bounce gets an
// honest "still unchecked" notice instead of a loop.
export const MAX_PLAN_GATE_ROUNDS = 1;

// A step-start line: `1. …`, `2) …`, `Step 3: …`, and the heading/bold variants plans actually use
// (`## Step 1: …`, `**Step 2: …**`, `**1.** …`) at (near) column 0 — a heading-styled work step
// must not be invisible while a plain "Verification" list parses (the observed failure: the
// checklist became only the verification items). Indented numbering is a sub-list inside a step,
// not a new step. Two digits cap keeps prose years ("2026.") out.
const STEP_START = /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*)?(?:step\s+)?(\d{1,2})[.):](?:\*\*)?\s+(\S.*)$/i;
// The dash-delimited heading variant: `Step 1 — Title` (em/en dash or hyphen). Requires the literal
// "step" keyword, unlike the punctuation forms above — a bare "1 — cheap option" shape is common in
// prose comparisons and would over-match.
const STEP_DASH = /^\s{0,3}(?:#{1,6}\s+)?(?:\*\*)?step\s+(\d{1,2})\s*[—–-]\s*(\S.*)$/i;
// Path-like tokens. With a slash we trust the shape (groundcheck's PATH_LIKE stance); without one,
// a bare `name.ext` is only a file if the extension is a common source/config kind — otherwise
// backticked property access (`theme.accent`, `opts.config`) would read as files. The optional
// leading `/` accepts absolute paths (plans regularly write `/Users/…/repo/src/x.ts` unbackticked);
// without it the capture must start on a word char and an absolute path extracts as NOTHING, so the
// step carries no path signal and its edit can never check it off. Matching is already
// absolute-safe (pathsMatch's segment-suffix rule maps it onto the relative edit path).
const BARE_PATH = /(?:^|[\s('"[])(\/?(?:[\w.@~-]+\/)+[\w.@~-]+\.[A-Za-z]\w{0,7})/g;
const FILE_SPAN = /^[\w./@~-]+\.([A-Za-z]\w{0,7})$/;
const KNOWN_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'css',
  'scss',
  'html',
  'py',
  'rs',
  'go',
  'java',
  'rb',
  'sh',
  'yml',
  'yaml',
  'toml',
  'txt',
  'sql',
  'c',
  'h',
  'cpp',
  'hpp',
  'vue',
  'svelte',
]);

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '');
}

// A backticked span that reads as a shell command: starts with a common runner and has arguments.
const COMMAND_SPAN =
  /^(npm|npx|pnpm|yarn|bun|node|make|cargo|go|python3?|pytest|vitest|jest|tsc|eslint|prettier|git)\s+\S/;
// The bare-line variant: `npm run lint` sitting unbackticked on its own line in a step body — the
// "standard routine" blocks plans write with no markup at all. Stricter than COMMAND_SPAN: it drops
// the runners that are also English words (`go to the settings page`, `make sure the tests pass`),
// because a falsely-extracted command makes a prose step gate-enforceable but never checkable.
const BARE_COMMAND =
  /^(npm|npx|pnpm|yarn|bun|node|cargo|python3?|pytest|vitest|jest|tsc|eslint|prettier|git)\s+\S/;
// Non-terminating command shapes — dev servers and watch modes (`npm run dev`, `vite preview`,
// `--watch`). They never exit on their own, so an exit-0 `Ran:` can never be observed and the step
// they belong to ("verify visually in the dev server" — a HUMAN step) would be gate-enforceable but
// forever unchecked: guaranteed bounce-then-waive noise. Excluded from every extraction context.
// \b also matches inside hyphenated scripts (dev-server); a one-shot script named `dev-build` is
// wrongly excluded, which only under-checks (the safe direction).
const NONTERMINATING_COMMAND = /\b(dev|start|serve|watch|preview)\b/;

function isTrackableCommand(c: string): boolean {
  return !NONTERMINATING_COMMAND.test(c);
}

// Normalize a candidate command line — strip a bullet/number marker and a `$ ` prompt — and return
// the collapsed command, or null if the line doesn't read as one (or can't terminate).
function commandLineOf(line: string): string | null {
  const t = line
    .trim()
    .replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, '')
    .replace(/^\$\s+/, '');
  return BARE_COMMAND.test(t) && isTrackableCommand(t) ? collapseWhitespace(t) : null;
}

// Fence languages whose content is a command list rather than example code. A tagged code fence
// (```go, ```ts) must NOT contribute commands — `go func() {` would read as a `go` run.
const SHELL_FENCE_LANGS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'text']);
const FENCE_BLOCK = /```([^\n`]*)\n([\s\S]*?)```/g;
// Content snippets must be real code fragments, not bare identifiers: an identifier (`parseThing`,
// `opts.config.model`) recurs across files (imports, call sites) and would mis-match, so a snippet
// needs a char outside identifier/dot shape (space, colon, brace, arrow…) and some length.
const MIN_SNIPPET_CHARS = 8;
const NON_IDENTIFIER_CHAR = /[^A-Za-z0-9_$.]/;
const MAX_SNIPPETS_PER_STEP = 6;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Extract the check-off signals one step's body names: file paths (backticked file-looking spans
// plus unbackticked slash-paths), quoted shell commands, and quoted code snippets. One-directional
// fuzziness on purpose — missing a signal just leaves a step manual; inventing one mis-checks it.
function extractStepRefs(body: string): {
  paths: string[];
  snippets: string[];
  commands: string[];
} {
  const paths: string[] = [];
  const snippets: string[] = [];
  const commands: string[] = [];
  const seen = new Set<string>();
  const addPath = (raw: string) => {
    const p = normalizePath(raw);
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  };
  const addCommand = (c: string) => {
    if (!commands.includes(c)) commands.push(c);
  };
  // Shell-ish fences in the step body contribute COMMANDS only (a "run the checks" step often
  // fences its command list), never paths/snippets — example code is full of incidental
  // identifiers (the groundcheck stance). Tagged code fences contribute nothing.
  for (const f of body.matchAll(FENCE_BLOCK)) {
    if (!SHELL_FENCE_LANGS.has(f[1].trim().split(/\s+/)[0].toLowerCase())) continue;
    for (const line of f[2].split('\n')) {
      const c = commandLineOf(line);
      if (c) addCommand(c);
    }
  }
  // Everything below works on the fence-stripped body: fenced numbering/paths must stay invisible.
  const noFences = body.replace(/```[\s\S]*?```/g, ' ');
  for (const m of noFences.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    const span = raw.replace(/:\d+(?::\d+)?$/, '');
    const ext = FILE_SPAN.exec(span)?.[1];
    if (ext && (span.includes('/') || KNOWN_EXTS.has(ext.toLowerCase()))) {
      addPath(span);
      continue;
    }
    if (COMMAND_SPAN.test(raw)) {
      if (isTrackableCommand(raw)) addCommand(collapseWhitespace(raw));
      continue;
    }
    if (
      raw.length >= MIN_SNIPPET_CHARS &&
      NON_IDENTIFIER_CHAR.test(raw) &&
      snippets.length < MAX_SNIPPETS_PER_STEP &&
      !snippets.includes(raw)
    ) {
      snippets.push(raw);
    }
  }
  // Bare command lines (no backticks, no fence): `npm run lint` on its own line.
  for (const line of noFences.split('\n')) {
    const c = commandLineOf(line);
    if (c) addCommand(c);
  }
  for (const m of noFences.replace(/`[^`\n]*`/g, ' ').matchAll(BARE_PATH)) addPath(m[1]);
  return { paths, snippets, commands };
}

// A top-level bullet line. `+` is deliberately excluded — unfenced diff lines start with it.
const BULLET_START = /^\s{0,3}[-*•]\s+(\S.*)$/;

// Whether a line quotes a trackable shell command inline — the promotion test for bullets (below).
// A dev-server/watch command doesn't promote: its bullet is a human instruction, not a work item.
function lineQuotesCommand(text: string): boolean {
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    if (COMMAND_SPAN.test(raw) && isTrackableCommand(raw)) return true;
  }
  return false;
}

// Parse a written plan into steps. Fence state informs structure — numbering and bullets inside a
// fence are snippet content, never steps — but bodies KEEP their fence lines so extractStepRefs can
// mine shell fences for commands. Each step's body runs to the next step-start line, so paths named
// in a step's sub-bullets still attach to it. `n` is ORDINAL (position in the plan), not the
// written number: plans routinely restart numbering per section ("Step 1: …" then a Verification
// list starting back at 1.), and n must be unique — it keys the waive marker (planWaived) and every
// gate/ledger/receipt reference. The step text disambiguates for the model when the display number
// drifts from a section-relative written one.
//
// Bullets: a top-level bullet normally merges into the preceding step's body (it's a detail of that
// step) — EXCEPT a bullet carrying a shell command (backticked or bare), which is promoted to its
// own step. Unpromoted, a trailing "Test checks: • npm test …" section would attach its commands to
// the last numbered step, so running the tests would mis-check THAT step (observed), and the checks
// themselves would never show as work items. And when the plan has no numbered lines at all, its
// top-level bullets ARE the plan — all of them promote — since otherwise a bullet-formatted plan
// gets no tracking at all.
export function parsePlanSteps(planText: string): PlanStep[] {
  const lines = planText.split('\n');
  let f = false;
  const fenced = lines.map(line => {
    if (/^\s{0,3}```/.test(line)) {
      f = !f;
      return true;
    }
    return f;
  });
  const stepStartText = (line: string): string | null => {
    const m = STEP_START.exec(line) ?? STEP_DASH.exec(line);
    return m ? m[2] : null;
  };
  const hasNumbered = lines.some((l, i) => !fenced[i] && stepStartText(l) !== null);
  const steps: PlanStep[] = [];
  let body: string[] = [];
  const closeStep = () => {
    if (steps.length > 0) {
      Object.assign(steps[steps.length - 1], extractStepRefs(body.join('\n')));
    }
    body = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let text: string | null = null;
    if (!fenced[i]) {
      text = stepStartText(line);
      if (text === null) {
        const b = BULLET_START.exec(line);
        if (b && (!hasNumbered || lineQuotesCommand(b[1]) || commandLineOf(b[1]) !== null)) {
          text = b[1];
        }
      }
    }
    if (text !== null) {
      closeStep();
      steps.push({
        n: steps.length + 1,
        text: text.replace(/\*\*/g, '').trim(),
        paths: [],
        snippets: [],
        commands: [],
        done: false,
        waived: false,
      });
    }
    if (steps.length > 0) body.push(line);
  }
  closeStep();
  return steps;
}

// Segment-boundary suffix match in either direction, so a plan's `config.ts` matches an edit to
// `src/config.ts` and a plan's repo-prefixed `reika/src/config.ts` matches `src/config.ts`.
function pathsMatch(planPath: string, editedPath: string): boolean {
  const a = normalizePath(planPath);
  const b = normalizePath(editedPath);
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

export type StepMatch = { index: number; by: 'path' | 'content' };

// Check off the EARLIEST pending step matching a successful edit. Earliest-first is what keeps two
// steps touching the same file from both flipping on one edit — plan order is the only
// deterministic tiebreak available. Path match is tried across all steps first; only when NO step
// names the edited file does the content fallback run: a step-quoted snippet appearing verbatim in
// the edit's diff pins the step even though the plan named a different (wrong) file — the observed
// failure where the model correctly routes around a mis-pathed plan and the tracker used to sit at
// 0 forever. Returns null when nothing matches.
export function applyEdit(
  steps: PlanStep[],
  editedPath: string,
  diffText?: string,
): StepMatch | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.done && !s.waived && s.paths.some(p => pathsMatch(p, editedPath))) {
      s.done = true;
      return { index: i, by: 'path' };
    }
  }
  if (diffText) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.done && !s.waived && s.snippets.some(sn => diffText.includes(sn))) {
        s.done = true;
        return { index: i, by: 'content' };
      }
    }
  }
  return null;
}

// Check off the EARLIEST pending step whose quoted command is contained in a successful bash run
// (whitespace-collapsed on both sides, so wrapping/`cd x && …` prefixes still match). This is what
// lets "run typecheck/tests" steps complete instead of sitting unchecked after a green run.
export function applyCommand(steps: PlanStep[], commandText: string): number {
  const ran = collapseWhitespace(commandText);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.done && !s.waived && s.commands.some(c => ran.includes(c))) {
      s.done = true;
      return i;
    }
  }
  return -1;
}

// Adjudicate the leftovers once the done-gate's bounce budget is spent: the model was asked about
// these steps once and finished anyway, so re-asking every later turn would just nag. Waived is an
// honest third state — "reviewed, not observed done" — not a claim of completion. Returns the
// waived step numbers (stamped on the notice message so the state survives the per-turn recompute).
export function waiveUnchecked(steps: PlanStep[]): number[] {
  const waived: number[] = [];
  for (const s of steps) {
    if (!s.done && !s.waived && (s.paths.length > 0 || s.commands.length > 0)) {
      s.waived = true;
      waived.push(s.n);
    }
  }
  return waived;
}

// The `Edited path (…)` / `Wrote path (…)` success summaries from tools/edit.ts and tools/write.ts.
// The diff's relative path is preferred; the summary token is the fallback for a message that lost
// its diff.
function editedPathFrom(msg: Message): string | undefined {
  if (msg.role !== 'tool') return undefined;
  if (msg.summary.startsWith('Edited ') || msg.summary.startsWith('Wrote ')) {
    return msg.diff?.path ?? msg.summary.split(' ')[1];
  }
  return undefined;
}

// Did this bash result come back green? Reads the exit status as data when the result carries it,
// and falls back to the old `Ran: ` prefix reading when it doesn't (#200). The fallback is not
// cosmetic: this function replays history from the plan message forward and re-derives progress by
// scanning, so a message written before `exitCode` existed — a resumed session, a loaded transcript,
// any tool result that isn't bash — would evaluate `exitCode === 0` to false and silently un-check
// steps that were checked off a moment earlier. `exitCode: null` (signal-killed) is a status, not an
// absence, so it correctly reads as not-green. Callers still scope to bash themselves: the exit code
// says how a command ended, not that one ran.
export function ranSuccessfully(m: { summary: string; exitCode?: number | null }): boolean {
  return m.exitCode !== undefined ? m.exitCode === 0 : m.summary.startsWith('Ran: ');
}

// The live plan on the history, with the steps it parses to — possibly none, since loop.ts stamps
// `planFinal` on ANY final plan-mode message and a force-written spiral stop ends a plan turn
// without being one (#126). One definition of "the live plan", shared by seedPlanProgress,
// distillPlanHandoff and plan mode's refinement turn (#46), so the three cannot drift about which
// plan is current. `message` identifies it by object rather than by index: a mid-turn fold splices
// the history, and an index resolved at turn start then names some other message.
export type PlanMarker = { index: number; message: Message; content: string; steps: PlanStep[] };

// Newest `planFinal` first. A step-less one is normally the answer (a dead-ended plan turn, which
// callers read as "no plan"), EXCEPT when it came out of a plan-mode follow-up to a real plan: a
// user asking "why step 3?" gets a prose reply that is stamped planFinal too, and letting it bury
// the plan one message up would cost the next refinement, the /implement checklist and the handoff.
export function latestPlanMarker(history: Message[]): PlanMarker | null {
  let newest: PlanMarker | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant' || !m.planFinal) continue;
    // The grounding/URL notes appended at commit (planChecks.at) are reika's, not the plan's: a
    // refinement handed them as its own plan text copies a stale advisory into the revision.
    const content = (m.content ?? '').slice(0, m.planChecks?.at);
    const marker = { index: i, message: m, content, steps: parsePlanSteps(content) };
    const isPlan = marker.steps.length > 0 && !isAnswerToQuestion(history, i, marker.steps);
    if (!newest) {
      if (isPlan) return marker;
      newest = marker;
    } else if (!onlyPlanTurnsBetween(history, i, newest.index)) {
      return newest;
    } else if (isPlan) {
      return marker;
    }
  }
  return newest;
}

// A numbered reply to a plan-mode question ("why this order?") parses as steps, and taking it as the
// plan hands /implement a checklist of the explanation. It names no file and no command, which a
// plan written for a question-phrased request ("how should we fix X instead?") does. Only ever a
// reason to look further back: with no plan above it, the scan still returns it.
function isAnswerToQuestion(history: Message[], at: number, steps: PlanStep[]): boolean {
  if (steps.some(s => s.paths.length > 0 || s.commands.length > 0)) return false;
  for (let i = at - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user' || m.harness || m.meta) continue;
    return m.mode === 'plan' && m.content.trim().endsWith('?');
  }
  return false;
}

// Is every model message in (from, to] part of a plan-mode turn? The opening user message carries
// the recorded mode — the loop stamps 'plan' on its own copy for a refinable plan turn, the session
// stamps the recorded one on what it emits (so a resumed history says 'vibe' or 'agent' there). A
// turn that ran in plan mode and ended without a new plan — aborted, spiral-stopped, a prose answer
// — changed nothing the plan is about; any other turn (an implementation, a vibe chain) means the
// plan belongs to an earlier exchange. Harness nudges and command echoes open no turn.
function onlyPlanTurnsBetween(history: Message[], from: number, to: number): boolean {
  let planTurn = false;
  for (let i = from + 1; i <= to && i < history.length; i++) {
    const m = history[i];
    if (m.role === 'user' && !m.harness && !m.meta) planTurn = m.mode === 'plan';
    else if (m.role === 'assistant' && !planTurn) return false;
  }
  return true;
}

// The plan a plan-mode turn is *refining* (#46): the live plan, when nothing but plan-mode turns
// came after it — the user is iterating on it. A follow-up that was aborted, spiral-stopped or
// answered in prose leaves it the plan to revise, since those turns wrote nothing in its place. A
// step-less marker is a dead-ended plan turn, not a plan (a refinement round told to "revise the
// plan above" would be revising "I couldn't determine which file handles this"), so it reads as a
// fresh planning pass instead. Same 0-step line seedPlanProgress draws, deliberately.
//
// "Only plan turns since" keeps refinement scoped to the plan's own exchange: an implementation
// turn (or any other model turn) after the plan means it belongs to an earlier one. It does NOT do
// the whole job for vibe: vibe's plan phase right after a written plan (a mode switch, or a
// plan-mode plan followed by a chat detour and back) looks exactly like a follow-up, and framing a
// new task as a revision would carry the earlier chain's steps into it. That half is the explicit
// gate — ui/commands.ts turnRefines, threaded through RunTurnOptions.allowRefine — so the two
// together are what "vibe never refines" actually means.
export function refineTarget(history: Message[]): PlanMarker | null {
  const marker = latestPlanMarker(history);
  if (!marker || marker.steps.length === 0) return null;
  return onlyPlanTurnsBetween(history, marker.index, history.length - 1) ? marker : null;
}

// Did a refinement round change the plan it was given? Compared on the PARSED steps rather than the
// raw text: a model that re-emits the same plan renumber, reheads or reformats it freely, and the
// question the caller is asking is whether the user's request landed in it, not whether the bytes
// match. A next plan with no steps at all reads as changed (it isn't a revision of this plan, and
// whether it is a dead end is the caller's own question — see planWritten). On step TEXT (first
// lines) only: a revision that reworks a step's body without touching its heading reads as
// unchanged — the accepted trade, since comparing bodies would let the notes appended at plan
// commit (grounding, URL) mask a no-op, which is the failure the caller is watching for.
export function planChanged(previous: string, next: string): boolean {
  const before = parsePlanSteps(previous);
  const after = parsePlanSteps(next);
  if (after.length === 0 || after.length !== before.length) return true;
  return before.some((s, i) => s.text !== after[i].text);
}

// Rebuild the checklist from history: the most recent written plan, with every successful
// edit/write (path or content match), successful bash run (command match), and gate waiver marker
// after it replayed. null when there's no plan or it yields no numbered steps — ordinary agent
// turns cost one backwards scan and nothing else.
export function seedPlanProgress(history: Message[]): PlanStep[] | null {
  const marker = latestPlanMarker(history);
  if (!marker || marker.steps.length === 0) return null;
  const steps = marker.steps;
  for (let i = marker.index + 1; i < history.length; i++) {
    const m = history[i];
    const edited = editedPathFrom(m);
    if (edited && m.role === 'tool') {
      applyEdit(steps, edited, m.diff?.text);
    } else if (m.role === 'tool' && m.command?.text && ranSuccessfully(m)) {
      applyCommand(steps, m.command.text);
    } else if (m.role === 'system' && m.planWaived) {
      for (const s of steps) if (m.planWaived.includes(s.n) && !s.done) s.waived = true;
    }
  }
  return steps;
}

function stepLine(s: PlanStep): string {
  const text = s.text.length > MAX_STEP_TEXT ? s.text.slice(0, MAX_STEP_TEXT - 1) + '…' : s.text;
  return `[${s.done ? 'x' : s.waived ? '~' : ' '}] ${s.n}. ${text}`;
}

// Model-facing progress block (REIKA_PLAN_ALIGN), appended to the agent system suffix each round
// like the loop ledgers — regenerated, never in history, so compaction can't age it out and the
// plan stays salient however long the run gets.
export function buildPlanProgressLedger(steps: PlanStep[]): string {
  const lines = ['--- plan progress (reika, auto-generated — not user input) ---'];
  // The state is a checkmark, not a verdict. A step is checked the moment the harness sees its
  // FIRST observable signal (an edit to one of the files it names, one of the commands it quotes),
  // so a step that names one file while needing many edits — the common shape — is checked while
  // the model is still inside it. The wording has to say so: the model reads its own tick, and the
  // line this replaced ("Do not re-do checked steps") turned an early tick into permission to skip
  // the rest of the step's own work, the exact confusion the checklist exists to prevent. Nothing
  // about the tracker changes — only what the model is told the tick means (under-checking stays
  // the safe direction, so the fix is here and not in applyEdit).
  lines.push(
    '[x] = the harness has seen evidence for that step (a file it names was edited, or a command it',
    'quotes ran). That is not proof the step is finished: a step showing [x] can still have work left.',
    '[~] = reviewed, not observed done:',
  );
  for (const s of steps.slice(0, MAX_LEDGER_STEPS)) lines.push(stepLine(s));
  if (steps.length > MAX_LEDGER_STEPS) lines.push(`… and ${steps.length - MAX_LEDGER_STEPS} more.`);
  lines.push(
    // Read-before-edit (#72): stated here, in the regenerated suffix, because the equivalent static
    // prompt rule decays — the deterministic backstop is the read-first gate (loop.ts READ_FIRST).
    'Work the steps in plan order, and finish the step you are on before starting the next one —',
    "the tick only means the harness saw evidence. Don't redo work you have already finished. Read",
    'a file before your first edit to it — old_string must match its current text exactly. Finish',
    'only when every step is really done, or you have said specifically why a remaining step no',
    'longer applies.',
  );
  return lines.join('\n');
}

// Done-gate decision, the plan analogue of decideTypecheckGate: when an implementing turn tries to
// finish with enforceable steps unchecked, send the model back once; past the budget, finish with
// an honest notice instead of looping. Enforceable = names a file or a command (both observable);
// a step with neither can never be observed done, so gating on it would bounce forever, and a
// waived step was already adjudicated in an earlier turn (fail-open on both).
export function decidePlanGate(opts: {
  steps: PlanStep[];
  gateRounds: number;
  maxRounds: number;
}): { action: 'pass' | 'retry' | 'waive'; modelMessage?: string; userNotice?: string } {
  const pending = opts.steps.filter(
    s => !s.done && !s.waived && (s.paths.length > 0 || s.commands.length > 0),
  );
  if (pending.length === 0) return { action: 'pass' };
  const names = pending.map(s => `${s.n}`).join(', ');
  if (opts.gateRounds >= opts.maxRounds) {
    return {
      action: 'waive',
      userNotice: `Plan gate: step${pending.length > 1 ? 's' : ''} ${names} not observed done after retry — waived (won't be re-asked).`,
    };
  }
  const lines = [
    'You stopped, but these steps of the plan appear unfinished (their files were never edited and',
    'their commands never ran):',
    ...pending.map(stepLine),
    'Continue with the first unfinished step now. If a step is already satisfied or no longer',
    'applies, say so specifically and then finish.',
  ];
  return {
    action: 'retry',
    modelMessage: lines.join('\n'),
    userNotice: `Plan gate: step${pending.length > 1 ? 's' : ''} ${names} unchecked — sending the model back to continue.`,
  };
}
