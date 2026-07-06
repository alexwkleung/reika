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
// Path-like tokens. With a slash we trust the shape (groundcheck's PATH_LIKE stance); without one,
// a bare `name.ext` is only a file if the extension is a common source/config kind — otherwise
// backticked property access (`theme.accent`, `opts.config`) would read as files.
const BARE_PATH = /(?:^|[\s('"[])((?:[\w.@~-]+\/)+[\w.@~-]+\.[A-Za-z]\w{0,7})/g;
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
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim();
    const span = raw.replace(/:\d+(?::\d+)?$/, '');
    const ext = FILE_SPAN.exec(span)?.[1];
    if (ext && (span.includes('/') || KNOWN_EXTS.has(ext.toLowerCase()))) {
      addPath(span);
      continue;
    }
    if (COMMAND_SPAN.test(raw)) {
      const c = collapseWhitespace(raw);
      if (!commands.includes(c)) commands.push(c);
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
  for (const m of body.replace(/`[^`\n]*`/g, ' ').matchAll(BARE_PATH)) addPath(m[1]);
  return { paths, snippets, commands };
}

// A top-level bullet line. `+` is deliberately excluded — unfenced diff lines start with it.
const BULLET_START = /^\s{0,3}[-*•]\s+(\S.*)$/;

// Whether a line quotes a shell command inline — the promotion test for bullets (below).
function lineQuotesCommand(text: string): boolean {
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    if (COMMAND_SPAN.test(m[1].trim())) return true;
  }
  return false;
}

// Parse a written plan into steps. Fenced code blocks are stripped first (example snippets carry
// incidental numbering and paths); each step's body runs to the next step-start line, so paths
// named in a step's sub-bullets still attach to it. `n` is ORDINAL (position in the plan), not the
// written number: plans routinely restart numbering per section ("Step 1: …" then a Verification
// list starting back at 1.), and n must be unique — it keys the waive marker (planWaived) and every
// gate/ledger/receipt reference. The step text disambiguates for the model when the display number
// drifts from a section-relative written one.
//
// Bullets: a top-level bullet normally merges into the preceding step's body (it's a detail of that
// step) — EXCEPT a bullet quoting a shell command, which is promoted to its own step. Unpromoted, a
// trailing "Test checks: • npm test …" section would attach its commands to the last numbered step,
// so running the tests would mis-check THAT step (observed), and the checks themselves would never
// show as work items. And when the plan has no numbered lines at all, its top-level bullets ARE the
// plan — all of them promote — since otherwise a bullet-formatted plan gets no tracking at all.
export function parsePlanSteps(planText: string): PlanStep[] {
  const lines = planText.replace(/```[\s\S]*?```/g, '').split('\n');
  const hasNumbered = lines.some(l => STEP_START.test(l));
  const steps: PlanStep[] = [];
  let body: string[] = [];
  const closeStep = () => {
    if (steps.length > 0) {
      Object.assign(steps[steps.length - 1], extractStepRefs(body.join('\n')));
    }
    body = [];
  };
  for (const line of lines) {
    const m = STEP_START.exec(line);
    const b = m ? null : BULLET_START.exec(line);
    const text = m ? m[2] : b && (!hasNumbered || lineQuotesCommand(b[1])) ? b[1] : null;
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

// Rebuild the checklist from history: the most recent written plan, with every successful
// edit/write (path or content match), successful bash run (command match), and gate waiver marker
// after it replayed. null when there's no plan or it yields no numbered steps — ordinary agent
// turns cost one backwards scan and nothing else.
export function seedPlanProgress(history: Message[]): PlanStep[] | null {
  let planIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.planFinal) {
      planIdx = i;
      break;
    }
  }
  if (planIdx < 0) return null;
  const plan = history[planIdx];
  if (plan.role !== 'assistant') return null;
  const steps = parsePlanSteps(plan.content ?? '');
  if (steps.length === 0) return null;
  for (let i = planIdx + 1; i < history.length; i++) {
    const m = history[i];
    const edited = editedPathFrom(m);
    if (edited && m.role === 'tool') {
      applyEdit(steps, edited, m.diff?.text);
    } else if (m.role === 'tool' && m.summary.startsWith('Ran: ') && m.command?.text) {
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
  lines.push(
    'You are executing the written plan. [x] steps were observed done; [~] steps were reviewed:',
  );
  for (const s of steps.slice(0, MAX_LEDGER_STEPS)) lines.push(stepLine(s));
  if (steps.length > MAX_LEDGER_STEPS) lines.push(`… and ${steps.length - MAX_LEDGER_STEPS} more.`);
  lines.push(
    // Read-before-edit (#72): stated here, in the regenerated suffix, because the equivalent static
    // prompt rule decays — the deterministic backstop is the read-first gate (loop.ts READ_FIRST).
    'Work the unchecked steps in plan order. Do not re-do checked steps. Read a file before your',
    'first edit to it — old_string must match its current text exactly. Finish only when every',
    'step is done or you have said specifically why a remaining step no longer applies.',
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
