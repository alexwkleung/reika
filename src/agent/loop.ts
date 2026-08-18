import type {
  ApprovalRequest,
  Config,
  ContextBundle,
  EditFailure,
  Message,
  Tool,
  ToolResult,
  Usage,
  WebBudget,
} from '../types.js';
import { buildSystemPrompt, type PromptMode } from './prompt.js';
import { callModel } from '../provider/client.js';
import { estimateRequestTokens } from '../provider/tokens.js';
import { computeMaxTokens, shouldRetryTruncated } from '../provider/budget.js';
import {
  compactHistory,
  shouldCompact,
  compactThreshold,
  gatherPlanFindings,
  distillPlanHandoff,
  batchAgePayloads,
  AGE_LOW_FRACTION,
  buildRestartHistory,
} from './compaction.js';
import { ReadTrace, type LoopingRead } from './readtrace.js';
import { PrefixTrace } from './prefixtrace.js';
import {
  selfRepeatRatio,
  repeatedSelfShingles,
  ReasoningTrace,
  liveSpinSignal,
  verbatimAbortThreshold,
} from './reasoningtrace.js';
import { biasableShingles, buildRuminationLogitBias } from './logitrecovery.js';
import { exciseSpiral, buildAppliedLedger, formatAppliedLedger } from './selfheal.js';
import { EntropyTrace, formatEntropyReading } from './entropytrace.js';
import {
  extractPlanReferences,
  verifyPlanReferences,
  buildGroundingNote,
  shouldSuppressGrounding,
} from './groundcheck.js';
import { groundUrlsForPlan } from '../tools/_urls.js';
import { referencesSpill } from '../tools/_spill.js';
import { recordFollowed, spillStatsEnabled } from '../tools/_spillstats.js';
import {
  seedPlanProgress,
  applyEdit as applyPlanEdit,
  applyCommand as applyPlanCommand,
  buildPlanProgressLedger,
  decidePlanGate,
  waiveUnchecked,
  MAX_PLAN_GATE_ROUNDS,
  type PlanStep,
} from './plantrack.js';
import { ReadFirstGate, buildReadFirstDirective } from './readfirst.js';
import { debugEnabled, debugLog } from '../debug.js';
import type { PayloadStore } from '../store/payloads.js';
import {
  type Diagnostic,
  decideTypecheckGate,
  detectTsProject,
  runTypecheck,
} from '../check/typecheck.js';

// Navigation/inspection tools whose repeats we watch for loops. Re-issuing one and getting
// the same result is a no-progress loop. `bash` is included because weak models run `grep`/
// `ls` through it; its summary carries the output byte count, so a repeat only fires on
// byte-identical output (a flaky/changed command differs and is left alone).
const TRACKED_TOOLS = new Set(['read', 'grep', 'list', 'glob', 'bash']);
// Tools whose whole purpose is mutation. They reset the repeat memory, since repo state may
// have changed, so a legitimate read-after-edit is never mistaken for a loop. Deliberately
// NOT including `bash`: it's used for read-only greps far more than mutation here, and letting
// it clear would wipe read-tracking between every interspersed `bash grep`.
const MUTATING_TOOLS = new Set(['write', 'edit']);

// The repeat key for a call. `read` normalizes away `limit` and keys on (path, offset): a
// model that re-reads from the same position with a different window — read(path, limit=100)
// then limit=300 then limit=80, all starting at line 1 — is looping even though each summary
// differs. Other tracked tools key on their result summary, which encodes their semantic
// identity (grep pattern, list/glob dir+pattern, bash command + byte count).
function repeatKey(name: string, args: Record<string, unknown>, summary: string): string {
  if (name === 'read') return `read\0${String(args.path ?? '')}\0${Number(args.offset ?? 1)}`;
  return `${name}\0${summary}`;
}

// On a repeat of the same tracked call within a turn, append an escalating redirect to the
// payload so a looping model gets a "this won't change" signal at the point of recency.
// Untracked tools (fetch/search/subagent/unknown) pass through; mutating tools reset memory.
export function flagRepeatedCall(
  seen: Map<string, number>,
  name: string,
  args: Record<string, unknown>,
  summary: string,
  payload: string | undefined,
): string | undefined {
  if (MUTATING_TOOLS.has(name)) {
    seen.clear();
    return payload;
  }
  if (!TRACKED_TOOLS.has(name)) return payload;
  const key = repeatKey(name, args, summary);
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  if (count <= 1) return payload;
  // For reads, point at the exact range (the summary names path + lines) so a weak model gets a
  // concrete redirect, not a generic "do something different". The claim is anchored on the always-
  // true fact — re-reading the same start line returns identical bytes — rather than on where any
  // prior copy lives: this read's own payload is live in the next request by construction, so the
  // nudge needs no liveness check and can't mislead the model into skipping a genuine refetch.
  if (name === 'read') {
    return (
      (payload ?? '') +
      `\n\n(reika: you have re-read this same range ${count} times this turn (${summary}) — ` +
      `re-reading the same start line returns identical bytes and won't make progress. Act on what ` +
      `you already have, page to a different part of the file, or open another file.)`
    );
  }
  return (
    (payload ?? '') +
    `\n\n(reika: you have run this ${name} ${count} times this turn with the same result — it ` +
    `will not change by repeating it. Make a different move: page to a different part of the ` +
    `file, search for the specific symbol you need, open a different file, or act on what you ` +
    `already have.)`
  );
}

// EXPERIMENT (plan mode): when to force the write (withdraw tools, transform reasoning→plan).
// The trigger is *novelty*, not a fixed round count: keep exploring while the model surfaces new
// information, force the write once it stops. Crucially this can't reintroduce spiraling — "no new
// information" IS the spiral signature, so the same rule stops both a finished model and a stuck
// one. A big/unfamiliar repo gets as many rounds as it keeps finding new files; a converged or
// looping model is cut off PLAN_STALL_ROUNDS rounds after it stops making progress. PLAN_HARD_CEILING
// is a backstop against a model that keeps finding trivially-new things forever.
const PLAN_STALL_ROUNDS = 2;
// 12 is right for ~16k: the model over-gathers vs the transform's findings budget well before then
// (measured ~26k tokens read against a ~10k budget), so more rounds are wasted. On a larger window
// this is too low — scale it with contextWindow, tuned by the gathered-payloads vs transform-budget
// ratio (visible under REIKA_DEBUG). Don't add the scaling speculatively; pick the curve with data.
const PLAN_HARD_CEILING = 12;
// Generation room reserved for the plan at force-write — the rest of the window budgets the
// transform's reference material. These models emit a few thousand tokens of reasoning *before*
// the plan, so 2048 left them cut off mid-write (finishReason=length → a wasted retry); 4096 fits
// reasoning+plan in one shot while still leaving ample window for grounding. The truncation-retry
// remains the backstop for an unusually long generation.
const PLAN_WRITE_RESERVE_TOKENS = 4096;
// EXPERIMENT (reasoning-loop break, Layer 2): force a plan-mode commit when the model's reasoning
// goes cross-round circular — re-deriving the same analysis instead of converging. Gated behind
// REIKA_REASONING_LOOP so it can be A/B'd; strict no-op when off (the ReasoningTrace still records
// for the debug diagnostic, but its verdict is never acted on). Calibrated from real transcripts:
// healthy runs topped out at crossSim ~0.21 even on long reasoning rounds, while the observed loop
// locked at crossSim=1.00 — so 0.6 sits in the wide dead zone between them. A streak of 2 fires one
// round after the loop locks (the lock was observed to happen within a round of onset), trading one
// wasted round for near-zero false-positive risk. n=1 on the trigger so far — confirm over more runs
// ([[testing-small-models-needs-multiple-runs]]) before hardwiring (or lowering) these.
//
// Two-tier activation by similarity strength. The streak-2 wait is the conservative path for the
// 0.6-0.9 band, where a single high round could be coincidental. But near-IDENTICAL reasoning two
// rounds running is never coincidental — the model is provably stuck — so above REASONING_LOOP_IMMEDIATE
// we fire at streak 1, the earliest a cross-round signal can (you need one comparison to know it
// repeated). 0.9 sits clear of the observed transient near-misses that self-resolved (~0.75), so it
// only short-circuits a real lock, not a model about to break out.
const REASONING_LOOP_THRESHOLD = 0.6;
const REASONING_LOOP_STREAK = 2;
const REASONING_LOOP_IMMEDIATE = 0.9;
const REASONING_LOOP_BREAK = process.env.REIKA_REASONING_LOOP === '1';
// EXPERIMENT (issue #137, REIKA_SELF_HEAL): the last rung of the ladder, in front of the honest
// stop. Every rung before it ends the turn if it fails; this one instead rebuilds the turn as a
// clean conversation — spiral excised, request and any converged plan verbatim — and gives the model
// a genuine second start. Two per turn: enough to be a real second chance, and the digest for the
// second is built from the ORIGINAL history rather than the first digest, so the losses of
// summarizing a summary never compound. Off by default while unproven.
const SELF_HEAL = process.env.REIKA_SELF_HEAL === '1';
const MAX_SELF_HEAL_RESTARTS = 2;
// EXPERIMENT (Tier 2 logit recovery): one biased round before the rumination terminal stop, gently
// down-weighting the loop's recurring tokens to nudge the model off the rut. Gated for A/B; strict
// no-op when off, and self-gating on /tokenize being reachable (so non-llama.cpp backends just stop
// honestly). Only ever fires at the rumination dead-end, which is structurally non-edit-recovery —
// the case where biased tokens are filler, not the work. See agent/logitrecovery.ts.
const LOGIT_RECOVERY = process.env.REIKA_LOGIT_RECOVERY === '1';
// EXPERIMENT (issue #134, measurement only): ask the engine for per-token logprobs so the drift
// instrumentation can report the model's REAL predictive entropy instead of the empirical entropy of
// its own output. Flag-gated because it is the one part of this that changes the request the engine
// sees (a few extra request fields, and a materially larger SSE payload — top-k candidates on every
// token); client.ts degrades to a plain request if a backend rejects it. Requires REIKA_DEBUG, since
// the debug log is the only consumer — without logprobs the text-derived measurements still run, so
// leaving this off costs the entropy precision, not the drift signal. Nothing here steers the model.
const ENTROPY_LOGPROBS = process.env.REIKA_ENTROPY === '1';
// Candidates per position. Small on purpose: the payload cost is per generated token, and 5 covers
// enough mass on a peaked distribution to be informative (the reading carries `cover` so a heavy
// unmeasured tail is visible rather than assumed away).
const ENTROPY_TOP_K = 5;
// Milder bias for the plan-mode force-write than the agent terminal's default (−4): that round writes
// the deliverable (the plan), so it's more output-sensitive — a polluted-but-not-spiraling plan would
// ship, where the agent round's pollution only collapses to a stop. Conservative; tune via A/B.
const PLAN_LOGIT_BIAS = -3;
// EXPERIMENT (plan→agent grounding): when a plan is finalized, verify the symbols/paths it names
// actually exist in the codebase and append an advisory listing any that don't — the upstream cause
// of the agent loops is plans referencing code that isn't there (0-match grep loops, edits whose
// old_string is in no file). The note rides in the plan message, so it's visible to the user and
// carried verbatim into the executing agent turn. Gated for A/B; strict no-op when off. See
// agent/groundcheck.ts and [[reika-reasoning-loop-break]].
const PLAN_VERIFY = process.env.REIKA_PLAN_VERIFY === '1';
// Recompute the live reasoning-spin hint at most every this many new reasoning chars — cheap, but no
// need to re-scan a trailing window on every token. Display-only; see reasoningtrace.ts liveSpinSignal.
const REASONING_SPIN_DEBOUNCE = 400;
// Auto-abort a reasoning stream that's stuck — either a near-verbatim decoder loop (provably stuck at
// any length) or a long block that's gone moderately repetitive (a semantic spiral, which we won't
// judge at normal length but which past a pathological length is clearly not deliberation). The bar
// is length-aware (verbatimAbortThreshold): 0.75 below ~healthy-max length, scaling toward 0.4 as the
// block grows, so it never touches a normal-length block and genuinely-long DISTINCT reasoning (low
// ratio) is left alone. The one place mid-stream abort is sound; without it the only backstop is the
// max_tokens wall, ~17k+ tokens away on a near-empty context. Gated behind REIKA_VERBATIM_ABORT,
// independent of the always-on soft hint. Bounded per turn so the abort→recover cycle can't loop.
// 2 (not 1) so the force-write *recovery round* is itself abort-protected — a deeply-stuck model
// spirals in the force-write too, and the first budget unit is spent cutting the original spiral.
const MAX_VERBATIM_RECOVERIES = 2;
// Absolute reasoning-length backstop (chars): cut a single uninterrupted reasoning block past this
// REGARDLESS of ratio. Catches a low-repetition *semantic* spiral (ratio ~0.3) that the ratio curve
// won't — which is exactly what a spiraling force-write looks like. 32000 ≈ 8000 tokens, ~2x the
// healthy single-block max, so genuine long deliberation is untouched. The force-write round uses a
// tighter ceil: a transform legitimately reasons only a few hundred tokens (observed ~300-400t), so
// anything near 3000t there is stuck and there's no reason to let it run to 8000.
const REASONING_HARD_CEIL = 32000;
const FORCE_WRITE_REASONING_CEIL = 12000;
const VERBATIM_ABORT = process.env.REIKA_VERBATIM_ABORT === '1';
// EXPERIMENT (converge retry): instead of giving up the moment the model can't converge — a plan-mode
// force-write that spiraled, or an agent reasoning loop that reached its terminal — spend ONE more
// *steered* attempt first: a strong, failure-naming directive ("you looped and kept re-questioning
// yourself; commit to one analysis/action and do it") rather than a cold stop. Capped at
// MAX_CONVERGE_RETRIES, and in plan mode the retry round gets a tighter reasoning ceil so a re-spiral
// is cut fast — cheap-to-fail. Worst case is unchanged (the same honest stop fires once the budget is
// spent); we just insert a best-effort push before it. Motivated by a manual finding: a third retry
// with exactly this steer converged where two unsteered attempts (one logit-biased) spiraled — the
// natural-language steer reaches the behavioral self-questioning spiral that token bias can't. Strict
// no-op when off. See AGENTS.md "Loop breaking".
const CONVERGE_RETRY = process.env.REIKA_CONVERGE_RETRY === '1';
const MAX_CONVERGE_RETRIES = 1; // one strong push; the user can retry fully after. Bump later if worth it.
// Tighter reasoning ceil for a steered plan-mode retry than a normal force-write (12000): if the steer
// is ignored and it re-spirals, cut it fast (~2k tokens) rather than burning the full force-write ceil.
const STEER_RETRY_REASONING_CEIL = 8000;
// EXPERIMENT (plan→agent handoff): fold the plan-mode exploration that precedes a written plan into
// a compact digest at the start of each agent turn, so the plan stays salient instead of being
// buried under the raw read transcript (agent/compaction.ts distillPlanHandoff). Off by default for
// a clean A/B; independent of REIKA_PLAN_EXPERIMENT (which only sets the *starting* mode, so reusing
// it would skip distillation whenever plan mode is reached via /plan). Strict no-op when off.
const PLAN_HANDOFF_DISTILL = process.env.REIKA_PLAN_HANDOFF === '1';
// EXPERIMENT (plan alignment, #68): during agent turns that execute a written plan, keep the
// harness-tracked step checklist in the system suffix each round (buildPlanProgressLedger) and
// bounce a turn that tries to finish with file-bearing steps unchecked (decidePlanGate, the plan
// analogue of the typecheck gate). The *tracking* is always on and deterministic (it feeds the UI
// checklist); this flag gates only the model-facing pressure, off by default for a clean A/B.
const PLAN_ALIGN = process.env.REIKA_PLAN_ALIGN === '1';
// EXPERIMENT (prefix-stable context, #69): keep consecutive requests append-only between shrink
// events so the inference engine's prompt-prefix cache stays valid. Three per-round prefix
// rewriters move to event-driven or tail-positioned equivalents: payload aging becomes sticky +
// batched (compaction.ts batchAgePayloads), reasoning pruning follows the same sticky boundary,
// and the regenerated ledgers/nudges ride a transient trailing user message instead of a system
// suffix (a system change invalidates the cache from token 0; the tail is rewritten every round
// anyway). Rationale: every mid-history byte change forces the engine to re-process from that
// point — and SWA/hybrid-memory models (no partial-prefix restore) re-process the WHOLE prompt on
// ANY divergence, observed at ~3 min/request on a 35B. Requires REIKA_CONTEXT_WINDOW (sticky
// liveness needs the batch-aging watermark to bound it); silently inactive without one. Off by
// default for A/B; strict no-op when off.
const PREFIX_STABLE = process.env.REIKA_PREFIX_STABLE === '1';
// EXPERIMENT (read-first gate, #72): during agent turns that execute a written plan, withhold a
// blind edit — one to a file with no read or successful edit/write this turn — ONCE per file, with
// a directive to read it first. The prevention analogue of the edit-recovery ledger: a fresh step's
// old_string is a guess (the handoff digest keeps the plan, not file bytes), and when it misses the
// model burns the failure round and sometimes spirals; a withheld round costs one read it needed
// anyway. Fail-open (a re-issued edit runs as-is), suspended while inspection tools are withdrawn
// (the directed read would be refused — deadlock), and plan-scoped because that is where the
// observed failure lives; ordinary turns keep refreshedFile + edit-recovery. See agent/readfirst.ts.
const READ_FIRST = process.env.REIKA_READ_FIRST === '1';

// EXPERIMENT (plan mode): the force-write turn is a *transformation*, not another exploration
// round. Asking the exploring model to "stop and write prose" fights its action prior and lets
// the plan it already has decay across turns; but the plan is reliably in its reasoning. So at
// the cap we discard the exploration history (and its read-momentum) and feed the model only the
// task + its own accumulated reasoning, with no tools, asking it to convert that into a plan.
// "Summarize your analysis into a plan" is a task weak models do far better than "decide to stop".
export function buildPlanWritePrompt(steer = false): string {
  // Deliberately positive and permissive. Heavy negative constraints ("output ONLY … no preamble,
  // no code") make ruminating thinking models burn their whole generation budget litigating the
  // rules instead of writing — they cut off mid-plan and retry. A short snippet or preamble is fine;
  // the only thing that matters is a grounded, file-specific plan.
  const lines = [
    'You are in PLAN MODE. Exploration is finished and you have no tools.',
    'The next message has the original request and your exploration notes (file contents + analysis).',
    'Write a numbered implementation plan from them. For each step, name the file and the change to',
    'make — a short code snippet is fine. Keep every step grounded in the notes: use their exact file',
    'paths and identifiers, and do not invent paths, filenames, or class names.',
  ];
  // Steered retry (CONVERGE_RETRY): the prior force-write looped. Name the failure mode the way that
  // empirically broke the loop ("don't overcomplicate / don't keep questioning yourself") — a strong
  // last push before the honest stop. Kept short; this round also runs under a tighter reasoning ceil.
  if (steer) {
    lines.push(
      '',
      'Your previous attempt to write this plan looped and kept re-questioning itself. Do NOT',
      'overcomplicate this. Commit to ONE analysis: do not re-explore, do not weigh alternatives, and',
      'do not repeatedly second-guess yourself. State the cause in a sentence or two and write the plan',
      'directly. Shorter is better.',
    );
  }
  return lines.join('\n');
}

// Steered directive appended to the agent-mode system suffix on the one converge-retry round before
// commitAgentLoopStop. Agent analogue of buildPlanWritePrompt's steer: names the self-questioning
// spiral and pushes the model to commit to an action, echoing the phrasing that broke the loop in
// practice. Exported + pure for tests.
export function buildConvergeSteer(): string {
  return [
    '--- reika status (auto-generated — not user input) ---',
    'You have repeated the same step without converging — re-questioning your approach instead of',
    'acting. Do NOT overcomplicate this. Commit to ONE concrete action now: make the edit the task',
    'needs, or give the final answer. Do not deliberate further, do not re-read or re-check, and do',
    'not keep second-guessing yourself — act on what you already have.',
  ].join('\n');
}

// Gather the model's accumulated thinking this turn (reasoning preferred, content as fallback) —
// the substance that carries the plan. Used both as the transform input and the empty-commit salvage.
function gatherPlanAnalysis(history: Message[]): string {
  return history
    .filter((m): m is Message & { role: 'assistant' } => m.role === 'assistant')
    .map(m => m.reasoning?.trim() || m.content?.trim() || '')
    .filter(Boolean)
    .join('\n\n');
}

// The single synthetic user turn sent on the force-write call: task + the findings (as reference)
// + the model's own analysis, all budgeted to fit the window. The explicit "use EXACT paths from
// the reference, do not invent" is load-bearing — small models otherwise fall back to generic
// React/CSS priors with made-up paths. `budgetChars` bounds the whole turn so a large task that
// read more than the window holds degrades to partial grounding rather than overflowing (400).
export function buildPlanTransformInput(
  history: Message[],
  budgetChars: number,
  dropAnalysis = false,
): string {
  const task = (
    history.find((m): m is Message & { role: 'user' } => m.role === 'user' && !m.meta)?.content ??
    ''
  ).slice(0, 2000);
  // When the force-write was loop-triggered, the accumulated reasoning IS the spiral — feeding it back
  // as "your analysis" can re-prime the loop at the transform level. Drop it and rebuild the plan from
  // the findings (clean grounding) instead. For a normal (converged) force-write the analysis carries
  // the conclusion (Fix-5: the model often reaches the answer, then ruminates), so keep it then.
  const analysisRaw = dropAnalysis ? '' : gatherPlanAnalysis(history);
  // Keep the most recent analysis (where the converged plan lives) within a fixed cap.
  const analysis = analysisRaw.length > 4000 ? `…${analysisRaw.slice(-4000)}` : analysisRaw;
  const findingsBudget = Math.max(2000, budgetChars - task.length - analysis.length - 600);
  return (
    `Original request:\n${task}\n\n` +
    `Reference material you gathered (file contents and search results):\n${gatherPlanFindings(history, findingsBudget)}\n\n` +
    (analysis ? `Your analysis:\n${analysis}\n\n` : '') +
    'Exploration is over. Write the numbered, file-specific plan for the request now, grounded in ' +
    'the reference material above — use its exact file paths and identifiers, and do not invent ' +
    'paths, filenames, or class names.'
  );
}

// EXPERIMENT (plan mode): a deterministic exploration ledger appended to the system prompt
// each round. It surfaces what the model has already examined (so it stops re-treading) and
// applies escalating, round-count-driven pressure to stop exploring and write the plan — the
// closure signal a read-only mode otherwise lacks. The model maintains none of this; it is
// derived in code from this turn's tool calls, so it cannot drift or be hallucinated.
function buildPlanLedger(history: Message[], round: number): string {
  const files = new Set<string>();
  const searches = new Set<string>();
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if (typeof tc.args.path === 'string') files.add(tc.args.path);
      if (typeof tc.args.pattern === 'string') searches.add(tc.args.pattern);
    }
  }
  const cap = (s: Set<string>): string => {
    const shown = [...s].slice(0, 8).join(', ');
    return s.size > 8 ? `${shown}, +${s.size - 8} more` : shown;
  };
  const lines = ['', '--- plan-mode status (reika, auto-generated — not user input) ---'];
  if (files.size > 0) lines.push(`Files examined: ${cap(files)}`);
  if (searches.size > 0) lines.push(`Searches run: ${cap(searches)}`);
  if (files.size === 0 && searches.size === 0) {
    lines.push(
      'Nothing examined yet — start by grepping the relevant symbol or reading the entry file.',
    );
  }
  // Escalating convergence pressure, driven by round count rather than model judgement.
  if (round >= 6) {
    lines.push('STOP. Call no more tools. Write the numbered plan from what you already have.');
  } else if (round >= 3) {
    lines.push(
      `You have explored across ${round} rounds and very likely have enough. Write the numbered ` +
        'plan now unless one specific unknown truly blocks you.',
    );
  } else if (files.size > 0 || searches.size > 0) {
    lines.push(
      'If you can already describe the steps, STOP exploring and write the numbered plan.',
    );
  }
  return lines.join('\n');
}

// Steady-state (prefix-stable OFF) system for round `round` — the base prompt plus the
// deterministic non-loop ledgers (plan mode's exploration ledger; the PLAN_ALIGN progress
// checklist). The round loop layers its loop/recovery ledgers on the same base (the agent path
// composes the identical parts inline so it can route them to the trailing note under
// REIKA_PREFIX_STABLE). At round 0 of a fresh turn all loop state is empty, so flag-off this IS
// the round-0 system — which is what lets the speculative KV warm (agent/warm.ts) reproduce it
// outside runTurn; the drift tests in warm.test.ts hold the two compositions together.
export function buildSteadySystem(opts: {
  baseSystem: string;
  promptMode?: PromptMode;
  history: Message[];
  round: number;
  planSteps: PlanStep[] | null;
}): string {
  if (opts.promptMode === 'plan') {
    return opts.baseSystem + '\n\n' + buildPlanLedger(opts.history, opts.round);
  }
  const planLedger =
    PLAN_ALIGN && opts.planSteps && opts.planSteps.some(s => !s.done)
      ? '\n\n' + buildPlanProgressLedger(opts.planSteps)
      : '';
  return opts.baseSystem + planLedger;
}

// Whether the prefix-stable experiment governs requests for this window config — the same
// condition runTurn uses (REIKA_PREFIX_STABLE needs a known window for its sticky watermarks).
// Exported so the warm path (agent/warm.ts) serializes its request under the same regime.
export function prefixStableActive(contextWindow?: number): boolean {
  return PREFIX_STABLE && !!contextWindow;
}

// Reproduce runTurn's exact round-0 request prefix outside the loop, for the speculative KV
// warm (agent/warm.ts): the same pre-round-0 history transform (plan→agent handoff
// distillation, flag-gated) and the same round-0 system. Lives here to share the
// module-private flags and stay in lockstep with the pre-pass in runTurn below. Mutates
// `history` in place (splice-only — message objects are never touched), exactly like that
// pre-pass, so callers pass their own copy. The ledger builders never read a trailing user
// message, so the history-without-user this receives yields the same system runTurn computes
// after pushing one. Under REIKA_PREFIX_STABLE the ledgers ride the transient trailing note
// instead of the system block (which the warm never sends — the note lands after the warm's
// whole prefix), so the round-0 system is the bare base prompt.
export function buildRoundZeroPrefix(opts: {
  history: Message[];
  bundle: ContextBundle;
  promptMode: PromptMode;
  contextWindow?: number;
  calibration: number;
  minGenTokens: number;
}): string {
  if (PLAN_HANDOFF_DISTILL && opts.promptMode === 'agent') {
    distillPlanHandoff(opts.history, opts.contextWindow, opts.calibration, opts.minGenTokens);
  }
  const baseSystem = buildSystemPrompt({ bundle: opts.bundle, mode: opts.promptMode });
  if (prefixStableActive(opts.contextWindow)) return baseSystem;
  const planSteps = opts.promptMode === 'agent' ? seedPlanProgress(opts.history) : null;
  return buildSteadySystem({
    baseSystem,
    promptMode: opts.promptMode,
    history: opts.history,
    round: 0,
    planSteps,
  });
}

// Confirmed-loop thresholds, split by class (see ReadTrace.loopingReads). dup-aged: the content
// aged out, so a single re-read can be a rational refetch — only 3+ identical passes is a loop.
// dup-live: the content is still in context, so re-reading it is never a refetch — 2 is already a
// loop, and firing a round sooner matters because live re-reads re-emit full payloads that inflate
// the uncompactable fresh block (observed: a dup-live loop drove payloads 35k→42k while compaction
// shed nothing). Both still leave the per-payload soft nudge (fires on the 2nd) its first shot.
const LOOP_AGED_REPEATS = 3;
const LOOP_LIVE_REPEATS = 2;
// Only treat a loop as active if its last re-read was within this many rounds — so the ledger
// disappears once the model breaks out, rather than nagging for the rest of the turn.
const LOOP_RECENT_ROUNDS = 2;

// Read-only/inspection tools withdrawn when a loop persists past the ledger (the loop-break tier).
// edit/write/bash stay, so the model can still complete the task — it just can't keep hiding in the
// read it's circling. Enforced at dispatch too, because this model emits reads as in-band XML and
// would otherwise route around an omitted tool.
const INSPECTION_TOOLS = new Set(['read', 'grep', 'glob', 'list']);
// Rounds a loop must stay active (ledger shown and ignored) before escalating from the directive to
// withdrawing the inspection tools. 2 gives the ledger one full round to work first. This is the
// agent-mode analogue of plan mode's forced tool-withdrawal: directives get ignored by these
// models (observed twice — soft nudge, then ledger); "a weak quant can't call a tool that isn't
// there" is what actually forces the explore→act transition (the stop-and-commit failure).
const LOOP_WITHDRAW_AFTER = 2;
// Rounds a reasoning loop must persist before the agent turn is terminally stopped. Withdrawal pulls
// read/grep/glob/list but NOT bash — a verification-spiraling model escapes via `bash tail/grep/wc`
// and loops to maxTurns (observed: model finished the file, then ran `tail -5` with byte-identical
// reasoning every round). Rather than chase every escape tool, end the turn once a confirmed
// reasoning loop has been through the ledger+withdrawal and still persists — the agent-mode analogue
// of plan mode's commitSpiralStop. 3 is the FLOOR: the soft ledger (loopActiveRounds=1) and the
// withdrawal (=2, whose ledger already says "if complete, say so and stop") each get exactly one
// round to work — both genuinely recover other loop types (a search loop pivots once read is pulled)
// — then terminal at =3. Can't go lower: terminal at =2 would fire BEFORE the withdrawn call runs,
// skipping withdrawal entirely. A model that heeds either step resets loopActiveRounds, so terminal
// only fires on a loop that ignored both.
const LOOP_TERMINAL_AFTER = 3;
// Post-edit typecheck gate: how many times a turn may be sent back to fix type errors its own
// edits introduced before it's allowed to finish anyway. The harness verifies so the weak model
// doesn't have to remember to — but a model that can't clear the errors must commit rather than
// loop, same bounded-recovery contract as MAX_LENGTH_RETRIES and the loop-withdrawal ladder. 2
// gives one fix attempt plus a re-check; beyond that, finishing dirty (with a user notice) beats
// spiralling. See check/typecheck.ts.
const MAX_TYPECHECK_GATE_ROUNDS = 2;
// Floor on the learned calibration when it drives the COMPACTION decision (not the UI gauge). The
// calibration = real-tokens / char-4-estimate; a prose-heavy session drives it below 1 (~0.9), which
// makes the trigger assume content is even sparser than the char/4 baseline. That optimism is what let
// a dense turn (SVG/CSS/code in the kept reasoning, ~1.6 chars/token) sail past compaction and 400 the
// window (see provider/toolcall.ts CAP_DENSITY_FLOOR). Flooring at 1 removes only the below-baseline
// optimism — it never assumes SPARSER than char/4 — so compaction fires at least at the heuristic
// threshold. Dense-content *safety* is the cap's job (the hard guarantee); this just fires compaction
// sooner so the cap has to truncate less often. Deliberately not the cap's 2.5 floor: that would
// compact at ~40% of a normal prose window and waste most of the context.
const COMPACTION_CALIBRATION_FLOOR = 1;
// Shell commands that only READ — the ones a withdrawn model uses to keep circling via bash. Kept to
// commands with no in-place-write mode reachable without a flag isReadOnlyShell already rejects.
const READ_ONLY_SHELL = new Set([
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'find',
  'sort',
  'uniq',
  'cut',
  'nl',
  'column',
  'stat',
  'tree',
  'basename',
  'dirname',
  'realpath',
  'which',
  'type',
  'pwd',
  'echo',
  'sed',
  'awk',
]);

// True only when we're CONFIDENT a bash command is pure read-only inspection — the "grep via bash"
// escape a withdrawn model uses to keep looping. Conservative by design: any write signal (output
// redirection, tee, sed/find in-place or destructive modes) or an unrecognized command anywhere in
// the pipeline returns false, so mutating/build bash (npm, git, mkdir) is never refused. False
// negatives (a bash-grep slips through) are cheap — the terminal stop still catches it; a false
// positive (blocking a real build mid-loop) is the expensive mistake, so we avoid it. Pure + exported.
export function isReadOnlyShell(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  // Strip quoted regions first: a grep pattern like "a\|b" or ">" carries shell metacharacters (| and
  // >) that are DATA, not a pipe/redirection — splitting or write-checking on them would misread a
  // read-only grep as a pipeline or a write. Command names are never quoted, so this loses nothing we
  // check. Malformed/nested quotes just leave junk that fails the command-name test → allowed (safe).
  const bare = c.replace(/"[^"]*"|'[^']*'/g, ' ');
  // Any sign of a write: file redirection, tee, sed -i, find -exec/-delete. Bail to "not read-only".
  if (/[>]|(^|\s)tee(\s|$)|(^|\s)-i\b|(^|\s)-exec\b|(^|\s)-delete\b/.test(bare)) return false;
  // Every pipeline/chain segment must start with a read-only command. Leading `cd <path>` hops (the
  // observed loops prefix these) are stripped; an empty remainder is not read-only.
  const segments = bare
    .split(/\|\||&&|;|\|/)
    .map(s => s.trim())
    .filter(Boolean);
  const meaningful = segments.filter(s => !/^cd\s/.test(s));
  if (meaningful.length === 0) return false;
  return meaningful.every(s => READ_ONLY_SHELL.has(s.split(/\s+/)[0]));
}

// Returned in place of a withdrawn inspection call. No content, so it can't re-fuel the loop or
// inflate context; it just states the rule and the way out.
const WITHDRAWAL_DIRECTIVE =
  '(reika: inspection tools (read/grep/glob/list, and read-only shell commands like grep/cat/tail) ' +
  'are paused because you have repeated the same reads or searches without making progress. You ' +
  'already have what you need. Make the edit the task requires with the edit/write tools, state ' +
  'what is specifically blocking you, or — if the change is already complete — say so and stop. ' +
  'Reading and searching are unavailable until you make progress.)';

// Whether to escalate from the loop ledger to withdrawing the inspection tools. Fires once a loop has
// stayed active LOOP_WITHDRAW_AFTER rounds (the ledger got its shot first), with exactly one
// exemption: edit-recovery (editRecovery=true, an unresolved failed edit). A model failing the same
// edit needs to READ to rebuild old_string — pausing inspection only forces more failing edits
// (observed: it oscillated edit-fail ↔ re-read at crossSim=1.0). That dead-end gets a graceful stop
// (see runTurn), not withdrawal.
//
// There used to be a second exemption — read loops were suppressed once editing had begun, on the
// theory that a post-edit re-read is usually re-fetching bytes that aged out rather than looping. It
// was already wrong once (a reasoning loop post-edit never broke out, which is why reasoningLoop was
// threaded in to override it), and it was wrong again on a kimi-k3 turn that edited five times and
// then re-read App.tsx lines 600-659 NINE times while withdrawal stayed off, because editingStarted
// was true and no edit was currently failing.
//
// The suppression is redundant with the detector it guards. `loopingReads` already demands 3 identical
// passes over the same (path, offset) within LOOP_RECENT_ROUNDS — a genuine post-aging refetch is one
// pass, maybe two, and never recent-and-repeated three times over. Anything that clears that bar is a
// loop whether or not an edit has landed, and `editRecovery` covers the one case where reading is the
// legitimate response. So the loop type no longer changes the answer, and neither reasoningLoop nor
// editingStarted is consulted here any more.
export function shouldWithdrawInspection(opts: {
  loopActiveRounds: number;
  editRecovery: boolean;
}): boolean {
  if (opts.loopActiveRounds < LOOP_WITHDRAW_AFTER) return false;
  return !opts.editRecovery;
}

// Agent-mode counterpart to the plan ledger: a persistent, non-aging stop signal for a confirmed
// loop — either a tight read repeat (ReadTrace.loopingReads, which names the files via `looping`) or
// cross-round reasoning rumination (caller passes an empty `looping`, so the message names the symptom
// generically). The per-payload nudge (flagRepeatedCall) can't break a period >= 2 loop on a one-round
// liveness window — it ages out before the loop returns to that call — so the signal must live in
// the system suffix, which is regenerated each round and never ages. Emitted ONLY while a loop is
// active, so a healthy turn never sees it. The "or state what is blocking you" escape is load-bearing:
// it gives a cornered model an out that isn't a premature wrong edit (e.g. naming a symbol its
// searches can't find — exactly the observed 0-match grep loop). `withdrawn` adds the harder line
// once we've escalated to pulling the inspection tools.
export function buildAgentLoopLedger(looping: LoopingRead[], withdrawn = false): string {
  const files = looping
    .slice(0, 8)
    .map(l => (l.offset > 1 ? `${l.path}:L${l.offset}` : l.path))
    .join(', ');
  const lines = ['', '--- reika status (auto-generated — not user input) ---'];
  // `looping` is empty for a pure reasoning loop (cross-round rumination, where each read pages a
  // fresh region or re-runs the same fruitless search so ReadTrace sees no repeat) — name the symptom
  // generically there; name the specific files when there's a tight read repeat to point at.
  lines.push(
    files
      ? `You have re-read the same file(s) several times this turn and the content has not changed: ${files}.`
      : 'You have repeated the same reasoning and searches several times this turn without converging on the task.',
  );
  if (withdrawn) {
    lines.push(
      'Reading and searching are now PAUSED. Make the edit the task requires with the edit/write',
      'tools, state specifically what is still blocking you, or — if the change is already complete —',
      'say so and stop.',
    );
  } else if (files) {
    lines.push(
      'Re-reading them returns identical bytes — it will not surface anything new. Stop gathering and',
      'either make the change the task needs, or state specifically what is still blocking you.',
    );
  } else {
    lines.push(
      'Repeating them will not surface anything new. Decide from what you already have: make the change',
      'the task needs, or state specifically what is blocking you — for example, a symbol your searches',
      'cannot find.',
    );
  }
  return lines.join('\n');
}

// Persistent, non-aging recovery directive for a `diverged` edit failure (anchor present, one line
// off) that has started looping. The edit tool already reports the divergence in its result summary,
// but that string ages out under compaction before a period >= 2 loop returns to it — the same reason
// the loop ledger lives in the regenerated system suffix rather than a per-call nudge. This lifts the
// exact divergence AND the verbatim current bytes into the suffix and frames the single fix the model
// must make: copy old_string character-for-character from the text shown. Emitted for one round only.
export function buildEditRecoveryLedger(failure: EditFailure): string {
  if (failure.kind !== 'diverged') return '';
  return [
    '',
    '--- reika status (auto-generated — not user input) ---',
    `Your edit to ${failure.path} failed because line ${failure.divergentLine} does not match your ` +
      `old_string: you expected "${failure.expected}", but the file actually has "${failure.actual}".`,
    'Re-reading will not change this — here is the current text of that region, verbatim:',
    '',
    failure.excerpt,
    '',
    'Make ONE edit whose old_string is copied character-for-character from the text above (the part ' +
      'after the line-number gutter), so it matches the file exactly. If the change does not belong ' +
      'here after all, say so and stop instead of retrying.',
  ].join('\n');
}

// Payload attached to an `absent` edit failure when the file's bytes are not in the model's context
// (see the call site). Rides the tool result rather than the system suffix: unlike the diverged
// recovery ledger — which must survive several rounds to reach a period-2 loop — this is consumed by
// the very next round, and the failure result is always live for that round.
//
// Says the quiet part explicitly. A model in this state reliably invents an explanation (the observed
// one: "a formatter must have rewritten the file"), and a rationalization it believes is what turns a
// one-round correction into a spiral — so the directive names the real cause and forecloses the retry
// from memory.
export function buildAbsentGrounding(failure: Extract<EditFailure, { kind: 'absent' }>): string {
  const head =
    `(reika: this edit was NOT applied. Your old_string matches nothing in ${failure.path} — not even ` +
    "ignoring whitespace — and that file's current contents are not in your context, so it was " +
    'written from memory rather than from the file. Nothing has rewritten the file: do not retry the ' +
    'same old_string, and do not assume a formatter or linter changed it.';
  if (failure.excerpt === undefined) {
    return (
      `${head} Nothing in the file closely resembles what you sent, so there is no region to show ` +
      `you — read ${failure.path} before retrying. The change may belong in another file, or to code ` +
      'that does not exist yet.)'
    );
  }
  return (
    `${head} The closest region is around line ${failure.at}; here it is verbatim:\n\n` +
    `${failure.excerpt}\n\n` +
    'Build your next old_string character-for-character from the text above — only what follows the ' +
    `\`NNNNN│\` gutter, indentation included. If the change belongs elsewhere, read ${failure.path} ` +
    'instead of guessing again.)'
  );
}

export async function runTurn(opts: {
  userInput: string;
  userDisplay?: string;
  history: Message[];
  bundle: ContextBundle;
  config: Config;
  tools: Tool[];
  payloads: PayloadStore;
  onMessage: (msg: Message) => void;
  onContentDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onPhase?: (phase: 'thinking' | 'tool') => void;
  // Ephemeral, human-only pulse for the post-edit typecheck: true while a check runs, false when it
  // settles. Drives the busy indicator's label so the user can see the harness verifying in the
  // dispatch gap. Never touches model-facing history — purely a UI signal.
  onTypecheck?: (checking: boolean) => void;
  // Ephemeral, human-only pulse for a loop-recovery round (edit re-grounding or the logit-bias nudge):
  // true while that one round runs, false when it settles. Drives the busy indicator's label so the
  // in-progress intervention is visible; the durable record is the persistent system receipt, not this.
  onRecovering?: (active: boolean) => void;
  // Ephemeral, human-only hint that the current reasoning block looks like it may be spinning (long
  // AND locally repetitive). Drives a busy-indicator relabel so the user can decide to abort or wait
  // — a soft signal, never an automated cutoff (mid-stream we can't know if a semantic spiral will
  // escape, so we don't guess; the human judges). Never touches model-facing history. See
  // agent/reasoningtrace.ts liveSpinSignal.
  onReasoningStatus?: (spinning: boolean) => void;
  // Discard the in-flight reasoning *preview* (the live "Thinking" block) — fired when a degenerate
  // reasoning stream is cut and recovered. The cut reasoning is garbage we never commit, so hiding it
  // (rather than leaving the long looped block sitting below the recovery notice, where it buries the
  // notice and the next round's reasoning appends onto it) makes the notice visible and lets the
  // recovery round stream into a fresh block. UI-only; never touches model-facing history. See #55.
  onReasoningReset?: () => void;
  onUsage?: (usage: Usage) => void;
  // Pre-send estimate of the next request's prompt tokens. Fires before each model
  // call so the UI can show context fill before the provider's real count arrives.
  onContextEstimate?: (tokens: number) => void;
  // Calibration of the char-based estimate against the provider's real token count,
  // threaded across turns (each turn re-seeds the full history, so the learned factor
  // must persist for the first call's compaction decision to be accurate).
  priorCalibration?: number;
  onCalibration?: (factor: number) => void;
  onToolProgress?: (chunk: string) => void;
  // Deterministic plan-progress snapshots (#68/#71): fired at agent turn start when the history
  // holds a written plan, and again whenever a step checks off (a successful edit/write touched a
  // file the step names). Drives the UI checklist; never model-facing (the model-facing ledger and
  // done-gate are gated behind REIKA_PLAN_ALIGN). The array is the loop's live tracker — copy it.
  onPlanProgress?: (steps: PlanStep[]) => void;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  promptMode?: PromptMode;
}): Promise<void> {
  const userMsg: Message = {
    role: 'user',
    content: opts.userInput,
    ...(opts.userDisplay ? { display: opts.userDisplay } : {}),
  };
  opts.history.push(userMsg);
  opts.onMessage(userMsg);

  const baseSystem = buildSystemPrompt({ bundle: opts.bundle, mode: opts.promptMode });
  // In plan mode the system is recomputed each round with a fresh, pinned exploration ledger
  // (never enters history, so compaction can't evict it). Other modes leave this untouched.
  let system = baseSystem;
  const turnStart = Date.now();
  // One budget per user turn — caps total search + fetch calls across all
  // internal model→tool rounds. Subagent calls get their own budget.
  const webBudget: WebBudget = {
    searches: { used: 0, max: opts.config.maxSearchesPerTurn },
    fetches: { used: 0, max: opts.config.maxFetchesPerTurn },
  };
  // Track URLs successfully fetched this turn. Stamped onto the final assistant
  // message as `sources` for deterministic citation rendering (no model recall).
  const fetchedUrls = new Set<string>();
  // Dependencies whose installed type surface has been injected this turn, so each imported
  // dep is grounded at most once per turn (tools/_deps.ts). Per-turn like fetchedUrls: a
  // fresh turn may have lost the surface to compaction, so re-grounding then is fine.
  const resolvedDeps = new Set<string>();
  // URLs grounded (fetched on the model's behalf) this turn, so a URL a write/edit introduces is
  // fetched at most once per turn. Per-turn like resolvedDeps. See tools/_urls.ts.
  const groundedUrls = new Set<string>();
  // Notify the user at most once per turn that compaction kicked in, even if it runs
  // again across the turn's tool rounds.
  let notifiedCompaction = false;
  // Consecutive length-stops recovered from. Reset on any clean (non-truncated) round so
  // the budget is per-spiral, not per-turn.
  let lengthRetries = 0;
  // Consecutive plan-mode rounds that surfaced no new information (seenReadOnly didn't grow). Drives
  // the adaptive force-write: a converged or looping model stalls here; a productive one resets it.
  let planStaleRounds = 0;
  // Consecutive rounds an agent-mode read loop has stayed active (ledger showing). Once it crosses
  // LOOP_WITHDRAW_AFTER the directive has demonstrably been ignored, so we escalate to withdrawing
  // the inspection tools. Resets the moment the loop clears, restoring normal exploration.
  let loopActiveRounds = 0;
  // Verbatim auto-abort bookkeeping: how many times this turn we've cut a degenerate reasoning stream
  // (bounded by MAX_VERBATIM_RECOVERIES so the cut→recover cycle can't loop), and a one-shot flag set
  // when a plan-mode cut should force the plan write on the next iteration. See VERBATIM_ABORT.
  let verbatimRecoveries = 0;
  let forceVerbatimPlanWrite = false;
  // The intra-block repeated span captured from a degenerate reasoning block at verbatim-abort, stashed
  // so the next round's plan force-write can bias off it (the block itself is discarded). Empty unless a
  // verbatim abort just set forceVerbatimPlanWrite. See the plan force-write branch + logitrecovery.ts.
  let verbatimRepeatedSpan: string[] = [];
  // Whether the model has made any edit/write this turn. Tool withdrawal exists to force the
  // explore→act transition; once the model has acted, that job is done. After the first edit a
  // re-read is usually edit-recovery (re-fetching exact bytes to build old_string after the content
  // aged out), NOT gratuitous looping — withdrawing read there forces it onto bash-grep and makes
  // edits *harder* to land (observed). So withdrawal is scoped to the pre-edit explore loop; the
  // soft ledger still fires after, since it's harmless and the re-reads are genuinely redundant.
  let editingStarted = false;
  // Edit-recovery state for the reasoning-loop dead-end: true while the model's most recent edit
  // FAILED (e.g. old_string not in the file) with no successful edit since. A failed edit needs a
  // re-read to recover, so withdrawal is suppressed here; if it persists alongside a reasoning loop
  // (the model retrying an edit it can't apply, ignoring the failure), the turn stops gracefully
  // rather than looping. lastEditFailure carries the structured divergence (when the edit tool
  // produced one) so the grounded recovery round can quote it; undefined for failures without one
  // (multiple/mixed matches, or a successful edit clearing the state).
  let lastEditFailed = false;
  let lastEditFailure: EditFailure | undefined;
  // One-shot guard for the grounded edit-recovery round: a `diverged` failure (anchor present, one
  // line off) gets exactly ONE round with the divergence lifted into the system suffix before the
  // dead-end stop — the same "each tier gets one round" discipline as the rumination ladder. Set when
  // that round fires so a still-looping turn falls through to the stop instead of grounding forever.
  let editRecoveryGroundingTried = false;
  // One-shot guard for the Tier 2 logit-recovery round (REIKA_LOGIT_RECOVERY): the rumination
  // dead-end gets exactly ONE biased round before the terminal stop. Set when it fires so a
  // still-looping turn falls through to commitAgentLoopStop instead of biasing every round.
  let logitRecoveryTried = false;
  // Converge-retry bookkeeping (CONVERGE_RETRY): how many steered last-push attempts this turn has
  // spent (bounded by MAX_CONVERGE_RETRIES). steerRetryActive is true only during a plan-mode steered
  // force-write retry — it appends the steer to the force-write prompt, tightens that round's reasoning
  // ceil, and keeps the retry abort-protected so a re-spiral is still cut. See CONVERGE_RETRY.
  let convergeRetries = 0;
  let steerRetryActive = false;
  // Pre-edit baseline for the post-edit typecheck gate. Captured lazily, immediately before the
  // turn's FIRST mutating tool runs, so it reflects the project's type-error state *before* the
  // model's edits; the done-gate diffs the final state against it and surfaces only what the edits
  // introduced. null = not captured (a turn that never edits, a non-TS project, or a checker that
  // couldn't run) and disables the gate — fail-open. A non-null (possibly empty) array = captured.
  let typecheckBaseline: Diagnostic[] | null = null;
  // One-shot guard so the baseline is captured at most once per turn (and a fail-open capture
  // isn't re-probed on every subsequent edit).
  let typecheckBaselineAttempted = false;
  // The tsconfig governing this turn's edits, resolved once (walk-up from the first edited file,
  // bounded at cwd) at baseline capture and reused for the final check, so both diff the same
  // config. undefined = not yet resolved / nothing found → runTypecheck falls back to detection.
  let typecheckTsconfig: string | undefined;
  // Consecutive done-gate send-backs this turn. Bounds the fix loop at MAX_TYPECHECK_GATE_ROUNDS.
  let typecheckGateRounds = 0;
  // Consecutive plan done-gate send-backs this turn. Bounds the plan gate at MAX_PLAN_GATE_ROUNDS.
  let planGateRounds = 0;
  // Per-turn memory of read-only calls already made, keyed by tool + result summary, so the
  // dispatch loop can flag a model that re-issues the same read/grep/list/glob and stalls.
  // Cleared by any mutating tool, since repo state may have changed. See READONLY_TOOLS.
  const seenReadOnly = new Map<string, number>();
  // REIKA_DEBUG-only instrumentation: classifies each read as unique / changed / dup-live /
  // dup-aged so a run reveals whether re-reads are redundant loops or rational refetches of
  // aged-out content. Model-invisible — only the debug log reads it. See agent/readtrace.ts.
  let readTrace = new ReadTrace();
  // Read-first gate state (#72): per-turn path grounding — reads and successful edits/writes ground
  // a path; the first blind edit to an ungrounded path is bounced once with a read directive.
  // Recorded unconditionally (cheap); only the READ_FIRST flag lets it withhold anything.
  let readFirst = new ReadFirstGate(opts.bundle.cwd);
  // Self-healing restarts spent this turn (#137, REIKA_SELF_HEAL). Bounded by
  // MAX_SELF_HEAL_RESTARTS. This is the OUTERMOST retry budget — every other cap in this turn
  // (length retries, converge retries, the gate rounds) sits inside it and is reset by a restart, so
  // it has to be the boundary or the worst case multiplies instead of adding.
  let selfHealRestarts = 0;
  // The history as it stood before the FIRST restart. The second restart digests from this rather
  // than from the first restart's output: re-summarizing a summary compounds the losses, and the
  // failure mode is perverse — attempt two ends up worse-informed than attempt one.
  let preRestartHistory: Message[] | null = null;
  // Cross-round reasoning-loop detector (Layer 2). Records each round's reasoning to spot the model
  // re-deriving the same analysis instead of converging. Always recorded (cheap, and the debug
  // diagnostic reads it); its verdict only drives a force-commit when REASONING_LOOP_BREAK is set.
  // See agent/reasoningtrace.ts.
  let reasoningTrace = new ReasoningTrace();
  // Whether the detector currently sees a sustained reasoning loop. Set after each round's model
  // call (from round i-1's reasoning); read at the top of round i to decide the force-commit.
  let reasoningLoopActive = false;
  // Which channel that verdict was drawn from (see ReasoningTrace's channel fallback). Hoisted for
  // the same reason as the flag above — the logit-recovery sites read round i-1's value — and read
  // ONLY to exempt the content channel from logit bias. See LOGIT_RECOVERY_CHANNELS.
  let reasoningChannel: 'reasoning' | 'content' = 'reasoning';

  const window = opts.config.contextWindow;
  // Prefix-stable mode is self-gating on a known window: sticky payload liveness without the
  // batch-aging watermark would grow requests unbounded, so no window → default behavior.
  const prefixStable = PREFIX_STABLE && !!window;
  // The per-round harness note (ledgers/nudges) when prefix-stable moves it out of the system
  // suffix: sent as a transient trailing user message, regenerated each round, never in history.
  let roundSuffix: string | undefined;
  // Prefix-divergence instrumentation (REIKA_DEBUG-only): measures, per request, how much of the
  // prompt an LCP prompt cache could reuse vs the previous request, and which mechanism broke it.
  // Turn-scoped so concurrent subagent turns don't cross-contaminate the comparison.
  const prefixTrace = new PrefixTrace();
  // Entropy/KL drift instrumentation (REIKA_DEBUG-only, issue #134): per-round uncertainty and how
  // far each round's output distribution has moved from the previous round and from the turn's
  // first. Turn-scoped for the same reason as prefixTrace — the baseline must be this request's own
  // starting point. Model-invisible; measures only. See agent/entropytrace.ts.
  const entropyTrace = new EntropyTrace();
  // The char-based estimate systematically diverges from a model's real tokenizer (code,
  // JSON and CJK tokenize denser). Calibrate it against the provider's reported
  // promptTokens so the compaction trigger fires at the *real* threshold, not a heuristic
  // one. Seeded from the prior turn's learned factor since each turn re-seeds the full
  // history from the UI scrollback.
  let calibration = opts.priorCalibration && opts.priorCalibration > 0 ? opts.priorCalibration : 1;
  const rawEstimate = (hist: Message[] = opts.history, tls: Tool[] = opts.tools): number =>
    estimateRequestTokens(system, hist, tls, {
      contextWindow: window,
      calibration,
      reasoningRounds: opts.config.reasoningRounds,
      minGenTokens: opts.config.minGenTokens,
      prefixStable,
      trailingNote: roundSuffix,
    });

  // Run a typecheck while pulsing the UI indicator around it (and clearing on any exit). The
  // pulse is human-only; the CheckOutcome flows to the gate logic, never to the model.
  const typecheck = async () => {
    opts.onTypecheck?.(true);
    try {
      return await runTypecheck(opts.bundle.cwd, {
        signal: opts.signal,
        tsconfigPath: typecheckTsconfig,
      });
    } finally {
      opts.onTypecheck?.(false);
    }
  };

  // EXPERIMENT (plan→agent handoff): one-shot pre-pass before the round loop. Folds the plan-mode
  // exploration that produced the plan into a compact digest so the executing agent sees the plan
  // verbatim plus findings, not the full transcript. Operates on the per-turn opts.history copy
  // (UI scrollback untouched), recomputed deterministically each turn; a cheap no-op without a
  // plan-final marker (every ordinary agent turn) and idempotent on re-runs. Runs before the
  // in-loop shouldCompact so that compaction sees the already-shrunk history.
  if (PLAN_HANDOFF_DISTILL && opts.promptMode === 'agent') {
    const { folded, reason } = distillPlanHandoff(
      opts.history,
      window,
      calibration,
      opts.config.minGenTokens,
    );
    // Log every agent turn (debug-gated), including the no-op: a bare folded=0 is otherwise
    // indistinguishable from "feature never ran", which the A/B needs to tell apart.
    debugLog(`[reika:debug] plan-handoff folded=${folded} reason=${reason}\n`);
  }

  // Plan progress (#68/#71): rebuild the step checklist from history — the latest written plan with
  // every successful edit/write after it replayed — so progress carries across turns with no stored
  // state (the same recompute-each-turn discipline as the distillation above). null on plan-less
  // histories, i.e. every ordinary agent turn.
  const planSteps: PlanStep[] | null =
    opts.promptMode === 'agent' ? seedPlanProgress(opts.history) : null;
  if (planSteps) {
    opts.onPlanProgress?.(planSteps);
    debugLog(
      `[reika:debug] plan-track steps=${planSteps.length} done=${planSteps.filter(s => s.done).length}\n`,
    );
  }

  // Self-healing restart (#137). Rebuild the turn as a clean conversation and reset every per-turn
  // counter, so the next round starts genuinely fresh instead of carrying the spiral's bookkeeping
  // forward. Returns false when the budget is spent, the flag is off, or there is no user request to
  // rebuild around — the caller then falls through to the honest stop it was already headed for.
  // Fail-closed in the safe direction: a restart that cannot be built degrades to the stop, never to
  // a half-reset turn.
  const attemptSelfHeal = (round: number): boolean => {
    if (!SELF_HEAL || selfHealRestarts >= MAX_SELF_HEAL_RESTARTS) return false;

    // Attempt 2 digests the ORIGINAL history, not attempt 1's output — see preRestartHistory.
    const source = preRestartHistory ?? opts.history;
    const excised = exciseSpiral(source, {
      shingles: reasoningTrace.repeatedShingles(),
      loopingReads: readTrace
        .loopingReads(round, LOOP_RECENT_ROUNDS, LOOP_AGED_REPEATS, LOOP_LIVE_REPEATS)
        .map(r => r.path),
    });
    // The ledger reads the FULL source, not the excised copy: excision stubs duplicate read
    // payloads, and an edit whose evidence was trimmed must still count as applied.
    const applied = formatAppliedLedger(buildAppliedLedger(source));
    const rebuilt = buildRestartHistory(excised.history, {
      attempt: selfHealRestarts + 1,
      maxAttempts: MAX_SELF_HEAL_RESTARTS,
      contextWindow: window,
      calibration,
      minGen: opts.config.minGenTokens,
      applied,
    });
    if (!rebuilt) {
      debugLog(`[reika:debug] round=${round} self-heal declined — no user request to restart\n`);
      return false;
    }

    if (!preRestartHistory) preRestartHistory = [...opts.history];
    selfHealRestarts++;
    // Replace in place: the caller holds this array reference.
    opts.history.splice(0, opts.history.length, ...rebuilt.history);

    // Reset the per-turn state the spiral built up. Everything bounded per turn resets, because the
    // turn is starting over; the typecheck baseline deliberately does NOT — it was captured before
    // the edits that are already on disk, and recapturing now would adopt those edits' errors as the
    // baseline and hide them.
    reasoningTrace = new ReasoningTrace();
    readTrace = new ReadTrace();
    readFirst = new ReadFirstGate(opts.bundle.cwd);
    seenReadOnly.clear();
    reasoningLoopActive = false;
    // reasoningChannel is deliberately NOT reset: record() reassigns it every round, and its only
    // readers sit behind the loop terminal, which needs several loop-active rounds to reach — so it
    // cannot be read stale after a restart. Leaving it alone also keeps the content-channel work
    // independently revertable from this feature.
    // withdrawInspection is declared per-round inside the loop, so it needs no reset here.
    loopActiveRounds = 0;
    logitRecoveryTried = false;
    convergeRetries = 0;
    steerRetryActive = false;
    lengthRetries = 0;
    typecheckGateRounds = 0;
    planGateRounds = 0;
    lastEditFailed = false;
    lastEditFailure = undefined;
    editRecoveryGroundingTried = false;

    debugLog(
      `[reika:debug] round=${round} self-heal attempt=${selfHealRestarts}/${MAX_SELF_HEAL_RESTARTS} ` +
        `droppedRounds=${excised.droppedRounds} strippedReasoning=${excised.strippedReasoning} ` +
        `stubbed=${excised.stubbedPayloads} nudges=${excised.droppedNudges} ` +
        `freed=${excised.freedChars} plan=${rebuilt.carriedPlan} applied=${applied ? 'yes' : 'none'}\n`,
    );
    // Persistent receipt — this must NOT read as an abrupt stop. Names the budget so the user can
    // see it is bounded rather than churning.
    opts.onMessage({
      role: 'system',
      tone: 'warn',
      content:
        `Stuck — restarting with a summary of the work so far ` +
        `(${selfHealRestarts} of ${MAX_SELF_HEAL_RESTARTS}).`,
    });
    opts.onRecovering?.(true);
    return true;
  };

  for (let i = 0; i < opts.config.maxTurns; i++) {
    if (opts.signal?.aborted) {
      commitAborted(opts, '', undefined, turnStart, fetchedUrls);
      return;
    }
    opts.onPhase?.('thinking');

    // One-shot per-token bias for this round, set only by the Tier 2 logit recovery at the rumination
    // dead-end below; undefined on every normal round. Threaded into callModel for this iteration.
    let logitBias: Record<number, number> | undefined;
    // Regenerated per round like `system`; the branches below set it when prefix-stable moves a
    // ledger/nudge to the tail. rawEstimate reads it, so reset before any estimate this round.
    roundSuffix = undefined;

    // Up to the cap: append the ledger + escalating nudge to the exploration prompt. At the cap:
    // switch to the transform — a tool-less call over a synthetic task+notes context, NOT the
    // exploration history. callHistory/callTools below are what actually get sent.
    // Force the plan write when exploration has stalled (novelty), run too long (ceiling), or — when
    // enabled — the reasoning has gone cross-round circular. The reasoning-loop arm catches the case
    // the novelty proxy misses: tool results that look new each round keep planStaleRounds reset while
    // the reasoning is identical (the observed crossSim=1.00 loop). reasoningLoopActive reflects round
    // i-1 here (set after that round's call), so a loop confirmed at i-1 force-writes at i.
    const planForceWrite =
      opts.promptMode === 'plan' &&
      (planStaleRounds >= PLAN_STALL_ROUNDS ||
        i >= PLAN_HARD_CEILING ||
        (REASONING_LOOP_BREAK && reasoningLoopActive) ||
        forceVerbatimPlanWrite);
    // Was the force-write triggered by a LOOP (reasoning-loop or verbatim abort) rather than normal
    // convergence (novelty stall / ceiling)? If so the accumulated analysis IS the spiral, so the
    // transform drops it and rebuilds from findings instead of feeding the loop back to itself.
    const planForceWriteLoopTriggered =
      (REASONING_LOOP_BREAK && reasoningLoopActive) || forceVerbatimPlanWrite;
    if (planForceWrite && REASONING_LOOP_BREAK && reasoningLoopActive) {
      debugLog(
        `[reika:debug] round=${i} plan-force-write trigger=reasoning-loop analysis=dropped\n`,
      );
    } else if (planForceWrite && forceVerbatimPlanWrite) {
      debugLog(
        `[reika:debug] round=${i} plan-force-write trigger=verbatim-abort analysis=dropped\n`,
      );
    }
    // Loop-break escalation: when a confirmed agent-mode loop persists past the ledger, withdraw the
    // inspection tools this round to force the explore→act transition. Recomputed each round, so it
    // lifts as soon as the loop clears. Never set in plan mode (which has its own force-write).
    let withdrawInspection = false;
    // Converge retry requested for this round (agent terminal). Composed into the suffix below —
    // NOT appended to `system` directly, which the suffix composition would overwrite.
    let convergeSteerNow = false;
    if (opts.promptMode === 'plan') {
      if (planForceWrite) {
        system = buildPlanWritePrompt(steerRetryActive);
        // Logit recovery, plan-mode host: the force-write IS plan mode's loop recovery, so bias that
        // round off the loop's recurring tokens — the same last-resort nudge as the agent terminal,
        // here on the round that writes the plan. Gated to a LOOP-triggered force-write
        // (planForceWriteLoopTriggered) — never the novelty/ceiling convergence, where there's no rut
        // and biasing would only pollute a healthy plan. One-shot (logitRecoveryTried). Unlike the
        // agent terminal, a null bias just proceeds with the unbiased force-write (the force-write is
        // the real recovery; the bias is an enhancement), rather than stopping.
        if (LOGIT_RECOVERY && planForceWriteLoopTriggered && !logitRecoveryTried) {
          logitRecoveryTried = true;
          const span = forceVerbatimPlanWrite
            ? verbatimRepeatedSpan // intra-block span from the aborted block (Layer 1)
            : biasableShingles(reasoningTrace.repeatedShingles(), reasoningChannel); // cross-round rumination (Layer 2)
          const bias = await buildRuminationLogitBias({
            baseURL: opts.config.baseURL,
            apiKey: opts.config.apiKey,
            shingles: span,
            toolNames: opts.tools.map(t => t.name),
            signal: opts.signal,
            bias: PLAN_LOGIT_BIAS,
          });
          if (bias) {
            logitBias = bias;
            debugLog(
              `[reika:debug] round=${i} logit-recovery (plan force-write) tokens=${Object.keys(bias).length}\n`,
            );
            opts.onMessage({
              role: 'system',
              tone: 'info',
              content: `Recovering: nudging the plan write off a repeated reasoning span.`,
            });
            opts.onRecovering?.(true); // live pulse; cleared after the call returns
          } else {
            debugLog(`[reika:debug] round=${i} logit-recovery (plan force-write) unavailable\n`);
          }
        }
      } else if (prefixStable) {
        // The ledger changes every round (files examined, escalating pressure); in the system
        // suffix that re-processes the whole prompt each round. As the tail note it costs nothing.
        system = baseSystem;
        roundSuffix = buildPlanLedger(opts.history, i).trimStart();
      } else {
        system = buildSteadySystem({
          baseSystem,
          promptMode: 'plan',
          history: opts.history,
          round: i,
          planSteps: null,
        });
      }
    } else {
      // Agent/chat: surface a persistent stop directive while a loop is active. Two independent
      // signals drive the same ladder:
      //  - a tight read repeat (ReadTrace), reflecting rounds 0..i-1 (updated during dispatch); and
      //  - when enabled, cross-round reasoning rumination (reasoningLoopActive, from round i-1). This
      //    catches what ReadTrace can't: a model paging fresh regions of a huge file / re-running the
      //    same 0-match grep forever — every read is `unique`, so loopingReads stays empty, but the
      //    reasoning is byte-identical (observed crossSim=1.00 from round 14 while it scanned a
      //    2149-line file looking for a symbol that did not exist). Reset to baseSystem otherwise, so
      //    a recovered model — or a turn that never looped — isn't nagged. Chat mode has neither.
      const looping = readTrace.loopingReads(
        i,
        LOOP_RECENT_ROUNDS,
        LOOP_AGED_REPEATS,
        LOOP_LIVE_REPEATS,
      );
      const reasoningLoop = REASONING_LOOP_BREAK && reasoningLoopActive;
      const loopDetected = looping.length > 0 || reasoningLoop;
      loopActiveRounds = loopDetected ? loopActiveRounds + 1 : 0;
      // Any confirmed loop that survives the ledger withdraws, regardless of type — UNLESS there's an
      // unresolved failed edit, where the model needs reading to recover and withdrawal would only
      // force more failing edits. See shouldWithdrawInspection.
      withdrawInspection = shouldWithdrawInspection({
        loopActiveRounds,
        editRecovery: lastEditFailed,
      });
      // Edit-recovery dead-end: a persistent reasoning loop on top of an unresolved failed edit is the
      // model retrying an edit it can't apply. It ignores the failure message (crossSim≈1.0) and
      // re-reading on its own never produces a matching old_string (observed: it oscillated
      // edit-fail ↔ re-read for 17+ rounds). Two sub-cases, split by the structured failure:
      //  - `diverged` (anchor present, one line off): mechanically recoverable. Spend ONE grounded
      //    round first — the exact divergence + verbatim current bytes lifted into the non-aging system
      //    suffix (the tool's own hint rides in the tool result, which ages out under compaction). The
      //    one-shot guard (editRecoveryGroundingTried) then lets a still-looping turn fall through to
      //    the stop next round, the same bounded "one round per tier" discipline as the rumination ladder.
      //  - otherwise (`absent`, or a failure type with no structured divergence): re-reading can't
      //    produce a matching old_string — the target isn't in the file (a plan referencing code that
      //    doesn't exist there) — so grounding is futile. Stop now with a clear report.
      let editRecoveryGrounding: EditFailure | undefined;
      if (reasoningLoop && lastEditFailed && loopActiveRounds >= LOOP_WITHDRAW_AFTER) {
        if (lastEditFailure?.kind === 'diverged' && !editRecoveryGroundingTried) {
          editRecoveryGrounding = lastEditFailure;
          editRecoveryGroundingTried = true;
          debugLog(
            `[reika:debug] round=${i} edit-recovery-grounding file=${lastEditFailure.path} ` +
              `line=${lastEditFailure.divergentLine}\n`,
          );
          // Persistent receipt: a failed edit started looping and the harness is re-grounding it on
          // the file's exact bytes for one round. User-must-see — it explains the next round's shift.
          opts.onMessage({
            role: 'system',
            tone: 'info',
            content: `Recovering: re-grounding a repeated failed edit to ${lastEditFailure.path} on the file's exact text.`,
          });
          opts.onRecovering?.(true); // live pulse for this one round; cleared after the call returns
          // fall through: don't stop — the grounded directive is injected into `system` below.
        } else {
          const file = lastEditFailure?.path;
          debugLog(`[reika:debug] round=${i} edit-recovery-stuck file=${file ?? '?'}\n`);
          const stuck: Message = {
            role: 'assistant',
            content:
              `I kept trying to edit ${file ? `\`${file}\`` : 'the file'} but the text I expected ` +
              `isn't in the file, so the change can't be applied as planned — the plan may reference ` +
              `code that doesn't exist there. I've stopped instead of looping. Please confirm the ` +
              `change belongs in that file, or point me at the right location.`,
            durationMs: Date.now() - turnStart,
            ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
          };
          opts.history.push(stuck);
          opts.onMessage(stuck);
          return;
        }
      }
      // Reasoning-loop dead-end (agent mode's commitSpiralStop): a confirmed reasoning loop that has
      // ignored the ledger AND survived withdrawal for LOOP_TERMINAL_AFTER rounds. Withdrawal only
      // pulls read/grep/glob/list, so a model spiraling via `bash` (e.g. re-running `tail`/`grep` to
      // "verify") routes around it and would otherwise run to maxTurns. End the turn instead — the
      // work it did (if any) is already on disk; say so honestly rather than loop.
      if (reasoningLoop && loopActiveRounds >= LOOP_TERMINAL_AFTER) {
        // Converge retry (REIKA_CONVERGE_RETRY) — strongest lever first: spend ONE steered round before
        // the stop, a failure-naming directive (buildConvergeSteer) to commit and act, appended to this
        // round's system suffix. Capped at MAX_CONVERGE_RETRIES; loopActiveRounds is NOT reset, so if
        // the loop persists the terminal fires again next round and (budget spent) falls through to the
        // logit round / honest stop. The natural-language steer reaches the behavioral self-questioning
        // spiral that token-level bias can't.
        if (CONVERGE_RETRY && convergeRetries < MAX_CONVERGE_RETRIES) {
          convergeRetries++;
          convergeSteerNow = true; // composed into the suffix below, LAST (#83)
          opts.onMessage({
            role: 'system',
            tone: 'warn',
            content: 'Still looping — one focused attempt to commit and act before stopping.',
          });
          opts.onRecovering?.(true); // live pulse; cleared after the call returns
          debugLog(`[reika:debug] round=${i} converge-retry (agent) attempt=${convergeRetries}\n`);
          // fall through: the steered round runs below with the steer appended to system.
        } else if (LOGIT_RECOVERY && !logitRecoveryTried) {
          // Tier 2 last resort (REIKA_LOGIT_RECOVERY): before the honest stop, spend ONE biased round —
          // mine the loop's recurring tokens and down-weight their entry tokens so the model is nudged
          // off the rut. This site is structurally pure rumination (an unresolved failed edit would have
          // stopped/grounded at the earlier edit-recovery dead-end), so the biased tokens are filler,
          // not the work. Fail-open: flag off, already tried, or no /tokenize → stop exactly as before.
          logitRecoveryTried = true;
          const bias = await buildRuminationLogitBias({
            baseURL: opts.config.baseURL,
            apiKey: opts.config.apiKey,
            shingles: biasableShingles(reasoningTrace.repeatedShingles(), reasoningChannel),
            toolNames: opts.tools.map(t => t.name),
            signal: opts.signal,
          });
          if (bias) {
            logitBias = bias;
            debugLog(
              `[reika:debug] round=${i} logit-recovery tokens=${Object.keys(bias).length}\n`,
            );
            // Persistent receipt: the harness is spending its one biased round to nudge the model off
            // a reasoning loop. User-must-see — it's a logit-level intervention that shapes the output.
            opts.onMessage({
              role: 'system',
              tone: 'info',
              content: `Recovering: nudging the model off a reasoning loop (one biased round before stopping).`,
            });
            opts.onRecovering?.(true); // live pulse for this one round; cleared after the call returns
            // fall through: don't stop — the biased round runs below with the loop ledger still set.
          } else {
            debugLog(`[reika:debug] round=${i} logit-recovery unavailable — stopping\n`);
            commitAgentLoopStop(opts, turnStart, fetchedUrls, editingStarted);
            return;
          }
        } else if (attemptSelfHeal(i)) {
          // Tier 3, the last rung (#137): everything cheaper has failed, so rebuild the turn and
          // give the model a genuine second start instead of ending here. attemptSelfHeal has
          // already replaced the history and reset the per-turn counters; `continue` re-enters the
          // round loop on the fresh conversation. Returns false when the budget is spent or there
          // is no request to rebuild around, in which case we fall through to the stop below.
          continue;
        } else {
          debugLog(
            `[reika:debug] round=${i} agent-loop-stop loopActiveRounds=${loopActiveRounds} ` +
              `edited=${editingStarted} restarts=${selfHealRestarts}\n`,
          );
          commitAgentLoopStop(opts, turnStart, fetchedUrls, editingStarted, selfHealRestarts);
          return;
        }
      }
      // Plan alignment (REIKA_PLAN_ALIGN): while unchecked steps remain, the checklist rides the
      // regenerated per-round suffix — like the loop ledgers, it never enters history, so
      // compaction can't age the plan out from under a long implementation run. Flag-off, this
      // composition produces exactly buildSteadySystem(...) + ledgers — the warm path
      // (buildRoundZeroPrefix) reproduces round 0 through that helper, and the drift tests in
      // warm.test.ts lock the two together.
      const suffixParts: string[] = [];
      if (PLAN_ALIGN && planSteps && planSteps.some(s => !s.done)) {
        suffixParts.push(buildPlanProgressLedger(planSteps));
      }
      // The grounded edit-recovery directive is more specific and actionable than the generic loop
      // ledger, so it replaces it for the one round it fires.
      if (editRecoveryGrounding) {
        suffixParts.push(buildEditRecoveryLedger(editRecoveryGrounding));
      } else if (loopDetected) {
        suffixParts.push(buildAgentLoopLedger(looping, withdrawInspection));
      }
      // Last, so the strongest directive sits closest to generation. (Composed here rather than
      // `system +=` in the terminal branch above, which this composition used to overwrite — the
      // steer previously never reached a request; #83.)
      if (convergeSteerNow) suffixParts.push(buildConvergeSteer());
      const suffix = suffixParts.map(p => '\n\n' + p).join('');
      if (prefixStable) {
        // Tail note instead of system suffix: a ledger appearing/changing/clearing in the system
        // block invalidates the engine's prefix cache from token 0; the tail is rewritten every
        // round anyway. The builders' own "auto-generated — not user input" headers keep a
        // user-role note from reading as user input.
        system = baseSystem;
        roundSuffix = suffix ? suffix.trimStart() : undefined;
      } else {
        system = baseSystem + suffix;
      }
      if (loopDetected) {
        debugLog(
          `[reika:debug] round=${i} loop-active reads=${looping.length} reasoning=${reasoningLoop} ` +
            `loopActiveRounds=${loopActiveRounds} withdrawn=${withdrawInspection} ` +
            `editRecovery=${lastEditFailed}\n`,
        );
      }
    }
    // Empty tool lists are already a supported path (chat mode with no search provider). On a loop
    // break, drop the inspection tools so the offered set steers a tool-list-respecting model
    // straight to edit/write; the dispatch layer enforces it for one that emits reads in-band.
    const callTools = planForceWrite
      ? []
      : withdrawInspection
        ? opts.tools.filter(t => !INSPECTION_TOOLS.has(t.name))
        : opts.tools;
    // Char budget for the transform turn: the window minus the plan's generation reserve, in chars
    // (calibration ≈1 here), with a safety margin. Without this, dumping every read into one turn
    // overflows the window on a large task — the real cause of the large-repo 400s.
    const planTransformBudget = window
      ? Math.floor((window - PLAN_WRITE_RESERVE_TOKENS) * 4 * 0.85)
      : Number.MAX_SAFE_INTEGER;
    const callHistory = planForceWrite
      ? [
          {
            role: 'user',
            content: buildPlanTransformInput(
              opts.history,
              planTransformBudget,
              planForceWriteLoopTriggered,
            ),
          } as Message,
        ]
      : opts.history;

    // Keep the request under the window: if the calibrated estimate crosses the threshold,
    // collapse the oldest turns into a recap before calling. Compaction mutates this turn's
    // history copy; the UI scrollback is untouched, so the user keeps the full log.
    // Pessimistic calibration for the compaction decision (never below the char/4 baseline). The UI
    // gauge (onContextEstimate below) keeps the raw learned value; only the compact-or-not choice and
    // how much to fold use this floored one. See COMPACTION_CALIBRATION_FLOOR.
    const compactCalibration = Math.max(calibration, COMPACTION_CALIBRATION_FLOOR);
    if (debugEnabled()) {
      const e = rawEstimate();
      // Raw composition of the stored history (pre-aging), to see what dominates the request.
      let rsnChars = 0;
      let sumChars = 0;
      let payChars = 0;
      for (const m of opts.history) {
        if (m.role === 'assistant' && m.reasoning) rsnChars += m.reasoning.length;
        else if (m.role === 'tool') {
          sumChars += m.summary.length;
          payChars += m.payload?.length ?? 0;
        }
      }
      debugLog(
        `[reika:debug] round=${i} mode=${opts.promptMode ?? 'agent'} histLen=${opts.history.length} ` +
          `forceWrite=${planForceWrite} estimate=${e} calib=${calibration.toFixed(3)} ` +
          `adjusted=${Math.round(e * compactCalibration)} ` +
          `threshold=${window ? Math.round(compactThreshold(window, opts.config.minGenTokens)) : 'n/a'} ` +
          `willCompact=${window ? shouldCompact(e * compactCalibration, window, opts.config.minGenTokens) : false} ` +
          `sys≈${Math.round(system.length / 4)}t reasoning≈${Math.round(rsnChars / 4)}t ` +
          `summaries≈${Math.round(sumChars / 4)}t payloads≈${Math.round(payChars / 4)}t ` +
          `reasoningRounds=${opts.config.reasoningRounds}\n`,
      );
    }
    // Prefix-stable shrink event: payloads stay live (byte-frozen) across rounds, so shed them in
    // one oldest-first batch when the estimate crosses the same threshold compaction uses — and do
    // it immediately before the compaction check so the two rewrites land in the SAME request (one
    // amortized prefix-cache invalidation, not two on consecutive rounds).
    let agedThisRound = false;
    if (prefixStable && window && !planForceWrite) {
      const marked = batchAgePayloads(
        opts.history,
        // compactCalibration, not the raw learned factor: batch aging replaces the per-round
        // collapse as the shrink mechanism, so it must fire under the same floored trigger as
        // compaction — a low learned calibration deferring the shrink until overflow is exactly
        // what the floor exists to prevent.
        () => rawEstimate() * compactCalibration,
        window,
        opts.config.minGenTokens,
      );
      agedThisRound = marked > 0;
      if (marked > 0) {
        debugLog(`[reika:debug] round=${i} prefix-stable batch-age marked=${marked}\n`);
      }
    }
    // Aging stops at the protected tail, so on a small window (system prompt + the active round's
    // reads can be most of it) it may land just UNDER the compaction threshold without reaching the
    // low watermark — and the next round's growth immediately re-fires a shrink event: consecutive
    // full re-processes, the exact pattern this mode exists to prevent (observed as back-to-back
    // batch-age rounds on a 24k window). This round is already paying the invalidation, so when
    // aging fired but couldn't reach the watermark, pull compaction into the SAME event instead of
    // letting the shrink straddle two requests. Never triggers on a quiet (append-only) round.
    const agedButAboveWatermark =
      agedThisRound &&
      !!window &&
      rawEstimate() * compactCalibration >
        compactThreshold(window, opts.config.minGenTokens) * AGE_LOW_FRACTION;
    // Force-write sends the tiny synthetic context, not opts.history, so there is nothing to
    // compact — skip it. Otherwise collapse the oldest turns if the estimate crosses the threshold.
    if (
      !planForceWrite &&
      window &&
      (shouldCompact(rawEstimate() * compactCalibration, window, opts.config.minGenTokens) ||
        agedButAboveWatermark)
    ) {
      const removed = compactHistory(
        opts.history,
        window,
        compactCalibration,
        opts.config.minGenTokens,
      );
      debugLog(`[reika:debug] round=${i} compaction removed=${removed}\n`);
      if (removed > 0 && !notifiedCompaction) {
        notifiedCompaction = true;
        opts.onMessage({
          role: 'system',
          tone: 'info',
          content: `Context compacted — folded ${removed} earlier message${
            removed === 1 ? '' : 's'
          } into a recap (older tool output still re-readable).`,
        });
      }
    }
    const sentEstimate = rawEstimate(callHistory, callTools);
    opts.onContextEstimate?.(Math.round(sentEstimate * calibration));
    // Live reasoning-spin hint (human-only): accumulate THIS round's reasoning and, debounced every
    // SPIN_DEBOUNCE chars, flag when it looks like it's spinning so the UI can prompt abort-or-wait.
    // Per-round state, reset here. Active when a UI listener is attached OR REIKA_DEBUG is on (so a
    // headless debug run still logs the signal + ratio for threshold tuning); otherwise it falls
    // through to the plain delta callback, zero-cost. Cleared after the call (block done).
    let roundReasoning = '';
    let spinCheckedAt = 0;
    let spinning = false;
    let verbatimAborted = false;
    // Combined abort signal for this round's call: aborts on user ctrl-c (forwarded from opts.signal)
    // OR on a verbatim auto-abort (below). callModel gets THIS signal; the loop's own user-abort
    // checks still read the original opts.signal, so the two causes stay distinguishable afterward.
    const callAbort = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) callAbort.abort();
      else opts.signal.addEventListener('abort', () => callAbort.abort(), { once: true });
    }
    // steerRetryActive keeps the one steered force-write retry abort-protected even after the normal
    // recovery budget is spent, so an ignored steer is still cut (cheap-to-fail) rather than running
    // to the max_tokens wall.
    const canAbortVerbatim =
      VERBATIM_ABORT && (verbatimRecoveries < MAX_VERBATIM_RECOVERIES || steerRetryActive);
    const trackSpin = !!opts.onReasoningStatus || debugEnabled() || canAbortVerbatim;
    const onReasoningDelta = trackSpin
      ? (delta: string): void => {
          opts.onReasoningDelta?.(delta);
          roundReasoning += delta;
          if (roundReasoning.length - spinCheckedAt < REASONING_SPIN_DEBOUNCE) return;
          spinCheckedAt = roundReasoning.length;
          const { spinning: next, ratio } = liveSpinSignal(roundReasoning);
          if (next !== spinning) {
            spinning = next;
            opts.onReasoningStatus?.(next);
            debugLog(
              `[reika:debug] reasoning-spin ${next ? 'on' : 'off'} round=${i} ` +
                `ratio=${ratio.toFixed(2)} chars=${roundReasoning.length}\n`,
            );
          }
          // Degenerate reasoning → cut the stream now rather than burn the rest of the window. Two
          // ways to trip it: (a) length-aware ratio (high bar for a short block = verbatim only,
          // lower as it grows = a repetitive spiral); or (b) an absolute length ceil regardless of
          // ratio, which catches a LOW-repetition semantic spiral the ratio curve misses (e.g. a
          // spiraling force-write at ratio ~0.3). The force-write round uses a tighter ceil. Only
          // while a recovery budget remains this turn.
          const abortAt = verbatimAbortThreshold(roundReasoning.length);
          const hardCeil = planForceWrite
            ? steerRetryActive
              ? STEER_RETRY_REASONING_CEIL
              : FORCE_WRITE_REASONING_CEIL
            : REASONING_HARD_CEIL;
          const tooLong = roundReasoning.length >= hardCeil;
          if (canAbortVerbatim && !verbatimAborted && (ratio >= abortAt || tooLong)) {
            verbatimAborted = true;
            debugLog(
              `[reika:debug] verbatim-abort round=${i} reason=${tooLong ? 'length' : 'ratio'} ` +
                `ratio=${ratio.toFixed(2)} threshold=${abortAt.toFixed(2)} ceil=${hardCeil} ` +
                `chars=${roundReasoning.length}\n`,
            );
            callAbort.abort();
          }
        }
      : opts.onReasoningDelta;
    const response = await callModel({
      system,
      history: callHistory,
      tools: callTools,
      config: opts.config,
      onContentDelta: opts.onContentDelta,
      onReasoningDelta,
      signal: callAbort.signal,
      calibration,
      // Per-turn backstop: cap generation to the room actually left in the window so a
      // spiraling small/quantized model can't run to the context end. The cap only fires
      // on a genuine spiral — compaction keeps the prompt small enough that a normal turn
      // has minGen-plus tokens to work with. See provider/budget.ts.
      maxTokens: computeMaxTokens({
        contextWindow: window,
        promptTokens: Math.round(sentEstimate * calibration),
        userMaxTokens: opts.config.maxTokens,
      }),
      // Set only on the one-shot Tier 2 logit-recovery round (see the rumination dead-end above);
      // undefined otherwise, so a normal turn's request is byte-identical to before.
      logitBias,
      prefixStable,
      trailingNote: roundSuffix,
      // Measurement only (issue #134), and only when something will read it: the debug log is the
      // sole consumer, so an un-logged run never pays the larger streaming payload.
      logprobs: ENTROPY_LOGPROBS && debugEnabled() ? ENTROPY_TOP_K : undefined,
      // Prefix-divergence line (issue #69): where this request stopped matching the previous one,
      // and which mechanism class broke it. Measured on the exact serialized request.
      onRequest: debugEnabled()
        ? msgs => {
            const d = prefixTrace.record(msgs);
            const pct = d.totalChars > 0 ? Math.round((d.stableChars / d.totalChars) * 100) : 100;
            debugLog(
              `[reika:debug] prefix-cache round=${i} cause=${d.cause} ` +
                `stable=${d.stableChars}/${d.totalChars}c (${pct}%) ` +
                `msgs=${d.stableMessages}/${d.totalMessages}` +
                (d.changedRole ? ` firstChanged=${d.changedRole}` : '') +
                `\n`,
            );
          }
        : undefined,
    });

    // The recovery round (if this was one) has now run — clear the live "recovering" pulse. Idempotent
    // and unconditional: a no-op on every normal round, so it can't leak the indicator into the next.
    opts.onRecovering?.(false);

    // Reasoning block is done streaming — clear any lingering spin hint so it doesn't bleed into the
    // tool/answer phase (the UI also clears at turn boundaries; this is the per-round clear). If it
    // was still flagged at block end, log it: the model ended a spiraling block (natural stop or the
    // max_tokens cap), which is worth seeing next to the round-level reasoning-loop line.
    if (spinning) {
      opts.onReasoningStatus?.(false);
      debugLog(`[reika:debug] reasoning-spin off round=${i} (block ended while flagged)\n`);
    }

    if (response.usage) opts.onUsage?.(response.usage);

    // Recalibrate from what the provider actually counted vs. what we estimated for the
    // request we just sent. Clamped to a sane band to ignore one-off outliers.
    if (response.usage?.promptTokens && sentEstimate > 0) {
      const factor = response.usage.promptTokens / sentEstimate;
      if (factor > 0.2 && factor < 8) {
        calibration = factor;
        opts.onCalibration?.(calibration);
      }
    }
    debugLog(
      `[reika:debug] round=${i} sentEstimate=${sentEstimate} ` +
        `usage.promptTokens=${response.usage?.promptTokens ?? 'MISSING'} ` +
        `finishReason=${response.finishReason ?? '?'}\n`,
    );

    if (opts.signal?.aborted) {
      commitAborted(opts, response.content, response.reasoning, turnStart, fetchedUrls);
      return;
    }

    // Verbatim auto-abort recovery: we cut a degenerate (near-verbatim) reasoning stream. This is NOT
    // a user abort (checked above on the original opts.signal). Discard the spiral reasoning — it's
    // garbage and would only bloat context — and recover by mode: plan mode force-writes the plan from
    // the findings already gathered (the clean, validated recovery); agent/chat nudges the model to
    // act on what it has. Bounded by MAX_VERBATIM_RECOVERIES (canAbortVerbatim above), so after the
    // budget is spent a re-spiral runs to the max_tokens wall and the length-retry path takes over.
    if (verbatimAborted) {
      verbatimRecoveries++;
      opts.onReasoningStatus?.(false);
      // The cut reasoning is degenerate and never committed; hide its live preview so the recovery
      // notice below isn't buried under it and the recovery round streams into a fresh block (#55).
      opts.onReasoningReset?.();
      // Plan mode, first cut on a normal exploration round → write the plan from the findings already
      // gathered (the clean recovery). NOT when the force-write itself spiraled (planForceWrite) — a
      // model this stuck loops in the transform too, so re-triggering it would just loop.
      if (
        opts.promptMode === 'plan' &&
        !planForceWrite &&
        verbatimRecoveries < MAX_VERBATIM_RECOVERIES
      ) {
        opts.onMessage({
          role: 'system',
          tone: 'warn',
          content: 'Reasoning was repeating itself — writing the plan from what was gathered.',
        });
        // Capture the repeated span now — the degenerate block is discarded after this, but the plan
        // force-write next round can bias off it (logit recovery). No-op if logit recovery is off.
        verbatimRepeatedSpan = repeatedSelfShingles(roundReasoning);
        forceVerbatimPlanWrite = true;
        continue;
      }
      // Agent/chat, first cut within budget → nudge to act on what it has.
      if (opts.promptMode !== 'plan' && verbatimRecoveries < MAX_VERBATIM_RECOVERIES) {
        opts.onMessage({
          role: 'system',
          tone: 'warn',
          content: 'Reasoning was repeating itself — stopped it.',
        });
        opts.history.push({
          role: 'user',
          harness: true,
          content:
            '(your reasoning was repeating the same text and was stopped — decide from what you ' +
            'already have and call a tool or give the answer concisely, without long reasoning)',
        });
        continue;
      }
      // The force-write itself spiraled. Before the honest stop, spend ONE steered retry: re-run the
      // force-write with a strong "commit, stop re-questioning" directive (buildPlanWritePrompt(steer))
      // and a tighter reasoning ceil (cheap-to-fail). Capped at MAX_CONVERGE_RETRIES; falls through to
      // the stop once spent. forceVerbatimPlanWrite is already true, so the next round re-force-writes.
      if (CONVERGE_RETRY && opts.promptMode === 'plan' && convergeRetries < MAX_CONVERGE_RETRIES) {
        convergeRetries++;
        steerRetryActive = true;
        opts.onMessage({
          role: 'system',
          tone: 'warn',
          content: 'Still looping — one more focused attempt with a tighter steer before stopping.',
        });
        opts.onRecovering?.(true);
        debugLog(`[reika:debug] round=${i} converge-retry (plan) attempt=${convergeRetries}\n`);
        continue;
      }
      // Last rung before the stop (#137): rebuild the turn and try again from a clean conversation.
      // In plan mode a converged plan rides through verbatim — it is the surviving deliverable, not
      // exploration to fold away — so a restart here resumes with the plan intact.
      if (attemptSelfHeal(i)) {
        // planForceWriteLoopTriggered is recomputed per round from the (now reset) detector state.
        forceVerbatimPlanWrite = false;
        continue;
      }
      // The force-write spiraled (and any steered retry is spent), or the recovery budget is gone: stop
      // honestly rather than loop or commit spiral garbage as a "plan". This model is stuck; say so.
      commitSpiralStop(opts, turnStart, fetchedUrls, selfHealRestarts);
      return;
    }

    // In plan force-write mode the request carried no tools, but some local models still emit
    // in-band `<tool_call>` text that the parser recovers (client.ts strips it from content first).
    // Drop those recovered calls so the turn commits the plan instead of looping on a tool we
    // already withdrew — withdrawing tools from the *request* alone doesn't stop an in-band caller.
    const toolCalls = planForceWrite ? [] : (response.toolCalls ?? []);
    const isFinal = toolCalls.length === 0;

    // Record this round's reasoning for the Layer-2 loop detector and refresh the active flag (read
    // by the next round's force-commit decision). Detection always runs; the action is gated above by
    // REASONING_LOOP_BREAK. The debug line classifies the thinking-block failure mode: selfRepeat
    // high (+ finishReason=length) = Layer 1 verbatim degeneration; crossSim/streak high while never
    // finalizing = Layer 2 rumination. Model-invisible. See reasoningtrace.ts.
    const rsn = response.reasoning ?? '';
    // Content rides along as the fallback channel: a model with no reasoning channel (non-thinking,
    // or reasoning stripped by the dialect handling) would otherwise reset the streak every round and
    // get no Layer-2 coverage at all. The trace picks one channel per turn and sticks to it.
    const { sim, streak, channel } = reasoningTrace.record(
      { reasoning: rsn, content: response.content },
      REASONING_LOOP_THRESHOLD,
    );
    // Fire on a sustained streak, OR immediately on a near-identical round (no point waiting out the
    // streak when the reasoning is provably stuck). See REASONING_LOOP_IMMEDIATE.
    reasoningLoopActive =
      streak >= REASONING_LOOP_STREAK || (streak >= 1 && sim >= REASONING_LOOP_IMMEDIATE);
    reasoningChannel = channel;
    if (debugEnabled()) {
      debugLog(
        `[reika:debug] reasoning-loop round=${i} selfRepeat=${selfRepeatRatio(rsn).toFixed(2)} ` +
          `crossSim=${sim.toFixed(2)} ch=${channel} streak=${streak} active=${reasoningLoopActive} ` +
          `finishReason=${response.finishReason ?? '?'} final=${isFinal} ` +
          `reasoning≈${Math.round(rsn.length / 4)}t\n`,
      );
    }

    // Drift measurements for the same round (issue #134). Sits beside the reasoning-loop line
    // deliberately: that line gives the categorical verdict, this one the continuous quantities
    // behind it — a rumination lock should show klPrev collapsing toward 0 as crossSim climbs, and
    // an entropy collapse is visible here rounds before either detector fires. Purely observational;
    // no threshold reads these yet, by design.
    if (debugEnabled()) {
      const reading = entropyTrace.record({
        text: `${rsn}\n${response.content}`,
        sampled: response.sampled,
      });
      if (reading) {
        debugLog(`[reika:debug] entropy round=${i} ${formatEntropyReading(reading)}\n`);
      }
    }

    // Generation cut off mid-thought with no tool call (backstop firing, or a spiral
    // hitting the cap): record the partial for the user, nudge the model to continue
    // concisely, and retry. Bounded by MAX_LENGTH_RETRIES so a genuinely-stuck model
    // doesn't loop — the second truncation falls through and commits as the final answer.
    if (
      shouldRetryTruncated({
        finishReason: response.finishReason,
        hasToolCalls: !isFinal,
        priorRetries: lengthRetries,
      })
    ) {
      lengthRetries++;
      if (response.content || response.reasoning) {
        const partial: Message = {
          role: 'assistant',
          content: response.content,
          reasoning: response.reasoning,
        };
        opts.history.push(partial);
        opts.onMessage(partial);
      }
      // The nudge must be role 'user' to reach the model (messagesToOpenAI drops system
      // messages). Push it to history but don't surface it as a user bubble — it isn't the
      // user's input. The UI sees a separate 'warn' system notice instead (same split
      // compaction uses: model-facing message in history, UI-only notice via onMessage).
      opts.history.push({
        role: 'user',
        harness: true,
        content:
          '(your previous response was cut off at the token limit — continue concisely: give the answer or call a tool directly, no long preamble)',
      });
      opts.onMessage({
        role: 'system',
        tone: 'warn',
        content: 'Response cut off at the token limit — retrying.',
      });
      continue;
    }
    lengthRetries = 0;

    // If the transform still came back empty (no tools were offered, so any "call" was inert),
    // salvage the gathered analysis directly — the turn must never commit an empty plan.
    let assistantContent = response.content;
    if (planForceWrite && !response.content?.trim()) {
      assistantContent = response.reasoning?.trim() || gatherPlanAnalysis(opts.history);
    }

    // Plan→agent grounding: when a plan is finalized, verify the symbols/paths it names exist in the
    // codebase and append an advisory for any that don't, so the executing agent (which inherits this
    // message) is warned up front rather than looping on phantom references. Runs once, at plan
    // commit. Strict no-op when the flag is off or the plan is clean. See agent/groundcheck.ts.
    if (PLAN_VERIFY && opts.promptMode === 'plan' && isFinal && assistantContent?.trim()) {
      const refs = extractPlanReferences(assistantContent);
      if (refs.symbols.length > 0 || refs.paths.length > 0) {
        const missing = await verifyPlanReferences(opts.bundle.cwd, opts.bundle.ignore, refs);
        // Suppress the note when nearly everything is missing — a greenfield/external-lib pattern
        // where the flags are noise, not signal. See agent/groundcheck.ts shouldSuppressGrounding.
        const suppressed = shouldSuppressGrounding(missing, refs);
        const note = suppressed ? '' : buildGroundingNote(missing);
        debugLog(
          `[reika:debug] round=${i} plan-verify refs=${refs.symbols.length + refs.paths.length} ` +
            `missing=${missing.missingSymbols.length + missing.missingPaths.length} suppressed=${suppressed}\n`,
        );
        if (note) assistantContent = (assistantContent ?? '') + note;
      }
    }

    // Plan→agent URL grounding (REIKA_URL_GROUNDING, the same flag as the write/edit path): a plan
    // can recommend a URL that never reaches a write — a plan-only workflow, or a docs link in prose
    // — which the edit/write grounder would never see. So at plan commit, fetch the URLs the plan
    // names and append a flag-only note for any that don't resolve, inherited verbatim by the agent
    // turn. Harness-driven (like the symbol walk above), so it needs none of plan mode's withheld web
    // tools. Strict no-op when the flag is off.
    // Hold the receipt until after the plan message is pushed below, so it lands as a standalone
    // end-of-turn line — not tucked under the unrelated prior tool (a read/list). The grounding is
    // about the plan, not that read.
    let planUrlNotice: ToolResult['notice'];
    if (opts.promptMode === 'plan' && isFinal && assistantContent?.trim()) {
      const url = await groundUrlsForPlan({ cwd: opts.bundle.cwd, groundedUrls }, assistantContent);
      if (url.note) assistantContent = assistantContent + url.note;
      if (url.notice)
        debugLog(`[reika:debug] round=${i} url-grounding mode=plan ${url.notice.content}\n`);
      planUrlNotice = url.notice;
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: assistantContent,
      // In force-write mode `toolCalls` was dropped to [] so isFinal is true; never surface the
      // recovered-but-withdrawn call as a chip the turn won't execute.
      toolCalls: isFinal ? undefined : response.toolCalls,
      reasoning: response.reasoning,
      ...(isFinal ? { durationMs: Date.now() - turnStart } : {}),
      ...(isFinal && fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
      // Mark the converged plan so a later agent turn can pin it and fold the exploration that
      // produced it (agent/compaction.ts distillPlanHandoff). Any final message in plan mode IS
      // the plan — whether the model self-terminated or was force-written — so mark on the mode,
      // not on planForceWrite (which would miss naturally-completed plans, the common case).
      ...(opts.promptMode === 'plan' && isFinal ? { planFinal: true } : {}),
    };
    opts.history.push(assistantMsg);
    opts.onMessage(assistantMsg);
    // The plan-grounding receipt goes out after the plan, as a standalone line (not nested).
    if (planUrlNotice) {
      opts.onMessage({ role: 'system', tone: planUrlNotice.tone, content: planUrlNotice.content });
    }

    if (isFinal) {
      // Post-edit typecheck gate. If this turn edited (baseline captured) and a final check shows
      // the edits introduced new type errors, send the model back to fix them instead of letting it
      // finish on broken code — the harness verifies so the weak model doesn't have to. The model's
      // premature answer stays in the scrollback (same as the length-retry path); a 'user' message
      // carries the errors to the model (system messages get dropped by messagesToOpenAI), and a
      // 'warn' notice tells the human. Bounded by MAX_TYPECHECK_GATE_ROUNDS: past the cap it commits
      // dirty with a notice rather than looping. Fail-open: no baseline or an unrunnable final check
      // just lets the turn end.
      if (typecheckBaseline !== null && !opts.signal?.aborted) {
        const final = await typecheck();
        const decision = decideTypecheckGate({
          baseline: typecheckBaseline,
          final,
          gateRounds: typecheckGateRounds,
          maxRounds: MAX_TYPECHECK_GATE_ROUNDS,
        });
        debugLog(
          `[reika:debug] round=${i} typecheck-gate action=${decision.action} ran=${final.ran} ` +
            `gateRounds=${typecheckGateRounds}\n`,
        );
        if (decision.action === 'retry') {
          typecheckGateRounds++;
          opts.history.push({ role: 'user', harness: true, content: decision.modelMessage });
          opts.onMessage({ role: 'system', tone: 'warn', content: decision.userNotice });
          continue;
        }
        if (decision.userNotice) {
          opts.onMessage({ role: 'system', tone: 'warn', content: decision.userNotice });
        } else if (final.ran) {
          // Clean pass: leave a subtle, persistent line so the verification is actually visible. The
          // ephemeral indicator is too fleeting to reliably catch (observed), whereas a scrollback
          // message — like the error notice — always lands. 'info' tone marks it as a routine
          // automatic event. Only on a real run, never on a fail-open skip.
          opts.onMessage({
            role: 'system',
            tone: 'info',
            content: 'Typecheck passed — no new type errors from your edits.',
          });
        }
      }
      // Plan done-gate (REIKA_PLAN_ALIGN): the plan analogue of the typecheck gate above. An
      // implementing turn (it edited) that stops with file-bearing steps unchecked gets sent back
      // once with the unfinished steps quoted; past the budget it finishes with an honest notice.
      // Gated on editingStarted so a read-only turn — a question about the plan, not an
      // implementation pass — is never bounced. Runs only after the typecheck gate has settled
      // (its `continue` above precedes this), so the two bounded gates can't interleave.
      if (
        PLAN_ALIGN &&
        planSteps &&
        editingStarted &&
        opts.promptMode === 'agent' &&
        !opts.signal?.aborted
      ) {
        const gate = decidePlanGate({
          steps: planSteps,
          gateRounds: planGateRounds,
          maxRounds: MAX_PLAN_GATE_ROUNDS,
        });
        debugLog(
          `[reika:debug] round=${i} plan-gate action=${gate.action} gateRounds=${planGateRounds}\n`,
        );
        if (gate.action === 'retry' && gate.modelMessage) {
          planGateRounds++;
          opts.history.push({ role: 'user', harness: true, content: gate.modelMessage });
          opts.onMessage({ role: 'system', tone: 'warn', content: gate.userNotice ?? '' });
          continue;
        }
        if (gate.action === 'waive') {
          // Budget spent: adjudicate the leftovers instead of leaving them pending, so later turns
          // don't re-bounce steps the model was already asked about. The waived numbers ride the
          // notice message (planWaived) — that's what lets the stateless per-turn recompute
          // (seedPlanProgress) restore the waiver.
          const waived = waiveUnchecked(planSteps);
          opts.onPlanProgress?.(planSteps);
          opts.onMessage({
            role: 'system',
            tone: 'warn',
            content: gate.userNotice ?? '',
            planWaived: waived,
          });
        }
      }
      if (readTrace.total() > 0) {
        debugLog(`[reika:debug] read-trace-summary ${readTrace.summary()}\n`);
      }
      const entropySummary = entropyTrace.summary();
      if (entropySummary) {
        debugLog(`[reika:debug] entropy-summary ${entropySummary}\n`);
      }
      return;
    }

    opts.onPhase?.('tool');
    // Novelty watermark for the adaptive cap: seenReadOnly only gains a key on a first-time
    // (path, offset) / search, so growth across this round means the model learned something new.
    const seenBeforeRound = seenReadOnly.size;
    for (const call of toolCalls) {
      if (opts.signal?.aborted) return;
      const tool = opts.tools.find(t => t.name === call.name);
      // Loop break: refuse a withdrawn inspection call at dispatch — covers the in-band caller that
      // routes around the omitted tool list. No execution, no content; just the directive. A read-only
      // `bash grep/cat/tail …` is refused too: it's the escape a withdrawn model routes to when
      // read/grep/glob/list are pulled (mutating/build bash still runs, so real work is unaffected).
      // See isReadOnlyShell.
      const refusedBashGrep =
        call.name === 'bash' && isReadOnlyShell(String(call.args.command ?? ''));
      const refused = withdrawInspection && (INSPECTION_TOOLS.has(call.name) || refusedBashGrep);
      // Read-first gate (#72): withhold a blind edit once, redirecting the model to read the file.
      // Never while inspection is withdrawn (the directed read would itself be refused), and only
      // when the edit could actually run (tool resolved). shouldBounce records the bounce, so a
      // re-issued edit to the same path — or one that ran and failed — always passes: fail-open by
      // construction, and edit-recovery is never re-bounced back to a read.
      //
      // No longer scoped to plan execution. That condition was a proxy for "the model probably lacks
      // the bytes", needed back when grounding was the far looser "has read this path at some point
      // this turn" — a test so weak that firing it everywhere would have bounced edits the model was
      // equipped to make. Now that shouldBounce asks the real question (are those bytes in the
      // request the model just answered — see readfirst.ts isLive), the proxy only loses coverage:
      // the long unplanned turn is exactly where reads age out beneath the model.
      const bouncedBlindEdit =
        READ_FIRST &&
        !withdrawInspection &&
        call.name === 'edit' &&
        tool !== undefined &&
        typeof call.args.path === 'string' &&
        readFirst.shouldBounce(call.args.path, opts.history, prefixStable);
      let summary: string;
      let payload: string | undefined;
      let diff: ToolResult['diff'];
      let command: ToolResult['command'];
      let contentHash: string | undefined;
      let toolNotice: ToolResult['notice'];
      let editFailure: EditFailure | undefined;
      // Read-first (#72): path this call put file bytes in front of the model for, and whether the
      // model authored them (`write`) rather than being handed them. Applied once the tool message
      // exists, since handed-back grounding keys on its history index. See readfirst.ts.
      let groundsPath: string | undefined;
      let groundsAuthored = false;
      // Check-off receipt for a plan step this call completed; emitted after the tool chip below.
      let planCheckoff: string | undefined;
      // Capture the pre-edit baseline once, immediately before the turn's first mutating tool
      // applies, so the done-gate diffs against the project's state before any of this turn's edits.
      // Runs in the post-generation dispatch gap (machine idle, not inferring — important when a
      // local model is saturating the box) and only on turns that actually edit. Fail-open: a
      // non-TS project or an unrunnable checker leaves the baseline null, disabling the gate.
      if (
        !typecheckBaselineAttempted &&
        tool &&
        !refused &&
        !bouncedBlindEdit &&
        MUTATING_TOOLS.has(call.name)
      ) {
        typecheckBaselineAttempted = true;
        // Resolve the governing tsconfig from the file being edited (walk-up, bounded at cwd) so a
        // monorepo subpackage edit is checked against that package's config, not just a root one —
        // and so the baseline and the final check pin the same config. null → undefined leaves the
        // closure on its detection fallback (which agrees: no config found = gate stays off).
        typecheckTsconfig =
          (await detectTsProject(
            opts.bundle.cwd,
            typeof call.args.path === 'string' ? call.args.path : undefined,
          )) ?? undefined;
        const base = await typecheck();
        typecheckBaseline = base.ran ? base.diagnostics : null;
        debugLog(
          `[reika:debug] round=${i} typecheck-baseline ${
            base.ran ? `${base.diagnostics.length} diags` : `skipped: ${base.reason}`
          }\n`,
        );
      }
      if (refused) {
        // Name the refusal honestly: a read-only bash call is "shell inspection", not "bash" (only
        // read-only bash is paused; a build/git bash would have run).
        const label = refusedBashGrep ? 'shell inspection' : call.name;
        summary = `${label} paused — make the edit or say what's blocking you`;
        payload = WITHDRAWAL_DIRECTIVE;
        debugLog(
          `[reika:debug] round=${i} refused ${call.name}${
            refusedBashGrep ? ' (bash-grep)' : ''
          } (inspection withdrawn)\n`,
        );
      } else if (bouncedBlindEdit) {
        const blindPath = String(call.args.path);
        summary = `edit paused — read ${blindPath} first, then re-issue the edit`;
        payload = buildReadFirstDirective(blindPath);
        debugLog(`[reika:debug] round=${i} read-first bounce ${blindPath}\n`);
      } else if (!tool) {
        summary = `Unknown tool: ${call.name}`;
      } else {
        // The payoff half of the spill ledger (`tools/_spillstats.ts`): a call that names an
        // artifact we handed out is the model taking the recovery path. Counted here rather than
        // in the tools because any of them can be the vehicle — `read` and `grep` are what the
        // footer suggests, but a shell `tail <path>` is following the locator just as much.
        if (
          spillStatsEnabled() &&
          Object.values(call.args).some(v => typeof v === 'string' && referencesSpill(v))
        ) {
          recordFollowed({ by: call.name });
        }
        try {
          const result = await tool.run(call.args, {
            cwd: opts.bundle.cwd,
            ignore: opts.bundle.ignore,
            webBudget,
            fetchedUrls,
            resolvedDeps,
            groundedUrls,
            requestApproval: opts.requestApproval,
            onProgress: opts.onToolProgress,
            spawnSubagent: makeSpawnSubagent(opts),
            bashTimeoutMs: opts.config.bashTimeoutMs,
          });
          summary = result.summary;
          payload = result.payload;
          diff = result.diff;
          command = result.command;
          contentHash = result.contentHash;
          toolNotice = result.notice;
          editFailure = result.editFailure;
        } catch (e) {
          summary = `Tool error: ${(e as Error).message}`;
        }
      }
      // Ground an `absent` edit failure (#72 follow-up). An old_string that matches nothing — not even
      // ignoring whitespace — while the file's bytes are NOT in context is confabulation: the model
      // wrote it from memory. Telling it to "re-read the file" is the one thing that cannot work,
      // since the read ages out before its next edit; so hand the bytes over in the failure itself,
      // the only slot in the request that is guaranteed live (it is always in the trailing block).
      // When the bytes ARE in context the failure means what it used to — the target genuinely is not
      // there — and the message is left alone.
      if (editFailure?.kind === 'absent') {
        // Ask about the REGION when one was located, and fall back to the whole file only when it
        // wasn't. A live read of App.tsx:560-594 does not mean the model can see line 607 — treating
        // it as if it did is what let a confabulated edit through ungrounded (observed, kimi-k3).
        const holds = editFailure.excerpt
          ? readFirst.holdsRegion(editFailure.path, editFailure.excerpt, opts.history, prefixStable)
          : readFirst.isGrounded(editFailure.path, opts.history, prefixStable);
        if (!holds) {
          const grounding = buildAbsentGrounding(editFailure);
          payload = payload ? `${payload}\n\n${grounding}` : grounding;
          debugLog(
            `[reika:debug] round=${i} absent-grounding file=${editFailure.path} ` +
              `at=${editFailure.at ?? 'none'}\n`,
          );
        }
      }
      // Instrument re-reads (debug only): is this a fresh read, a redundant loop, or a rational
      // refetch of content that aged out? Recorded for every read regardless of REIKA_DEBUG (cheap,
      // and the live/aged label depends on round order), but only emitted under the flag.
      if (!refused && call.name === 'read' && contentHash) {
        // Read-first (#72): the model now holds this file's bytes (or knows its true length, for an
        // offset-past-end read). Grounding is applied after the tool message is pushed, since it
        // keys on that message's index — the bytes ground edits only while they are still being sent.
        groundsPath = String(call.args.path ?? '');
        const { cls, repeats } = readTrace.record(
          String(call.args.path ?? ''),
          Number(call.args.offset ?? 1),
          contentHash,
          i,
        );
        debugLog(
          `[reika:debug] read-trace round=${i} class=${cls} repeats=${repeats} ${summary}\n`,
        );
      } else if (debugEnabled() && !refused && call.name !== 'read') {
        // Non-read tool calls have no read-trace line, so a reasoning loop circling on grep/glob/list
        // (the observed case, where read-trace was silent but payloads kept growing) is otherwise
        // invisible. Log name + summary so a looping transcript reveals exactly what it's stuck on.
        debugLog(`[reika:debug] tool-call round=${i} ${call.name} ${summary}\n`);
      }
      // Loop-breaker: weak models re-issue the same read/grep/bash and stall on the identical
      // output. flagRepeatedCall appends an escalating redirect on the 2nd+ repeat (read keyed
      // on path+offset so window-varying re-reads still count); mutating tools reset the memory
      // so a read-after-edit isn't flagged. Skipped for unknown tools (nothing produced).
      if (tool && !refused && !bouncedBlindEdit)
        payload = flagRepeatedCall(seenReadOnly, call.name, call.args, summary, payload);
      // Mark that the model has acted, so loop-break withdrawal stops scoping to this turn — a
      // failed edit counts, since it's the attempt (and the failure) that puts us in edit-recovery.
      // A BOUNCED edit doesn't: the harness withheld it, nothing ran, and the directed read that
      // follows must stay eligible for the normal read-loop ladder if the model spins instead.
      if (!bouncedBlindEdit && MUTATING_TOOLS.has(call.name)) {
        editingStarted = true;
        // Track edit-recovery state: a failed edit (old_string not in the file, etc.) keeps the model
        // needing a re-read; a successful one clears it. Drives the withdrawal exemption + dead-end
        // stop. `Edited …` is the success prefix from tools/edit.ts; anything else is a non-apply.
        if (summary.startsWith('Edited ') || summary.startsWith('Wrote ')) {
          lastEditFailed = false;
          lastEditFailure = undefined;
          // Read-first (#72): a successful edit/write grounds its path, but by different routes. An
          // edit grounds only through the post-edit echo it hands back (tools/edit.ts refreshedFile),
          // which is size-capped and absent on a large file — so it keys on the message index and
          // expires with it. A write's content the model composed itself and its own tool_call args
          // never age, so that grounding is unconditional. (The `diff` grounds nothing either way:
          // it is a UI field, never serialized into the request.)
          if (typeof call.args.path === 'string') {
            groundsPath = call.args.path;
            groundsAuthored = call.name === 'write';
          }
          // Plan progress (#71): a successful edit/write checks a pending step off — by path when
          // the plan named this file, else by content when a step-quoted snippet appears in the
          // diff (the plan named the wrong file; the model edited the right one). Harness-observed
          // facts, not the model's own claim of progress. The receipt is stashed and emitted AFTER
          // the tool chip below (same placement rule as toolNotice).
          if (planSteps) {
            const match = applyPlanEdit(planSteps, diff?.path ?? summary.split(' ')[1], diff?.text);
            if (match) {
              opts.onPlanProgress?.(planSteps);
              const done = planSteps.filter(s => s.done).length;
              const via =
                match.by === 'content'
                  ? ' — matched by edit content; the plan names another file'
                  : '';
              planCheckoff =
                done === planSteps.length
                  ? `Plan complete — all ${planSteps.length} steps checked off.`
                  : `Plan step ${planSteps[match.index].n} checked off (${done}/${planSteps.length})${via}.`;
            }
          }
        } else if (summary.startsWith('Edit failed')) {
          lastEditFailed = true;
          // editFailure is set only for the not-found case; other failures (multiple/mixed) leave it
          // undefined, which the dead-end treats as "not groundable" and stops as before.
          lastEditFailure = editFailure;
        }
      }
      // Command steps ("run typecheck/tests"): a successful bash run (exit 0, the `Ran:` prefix)
      // whose command contains the step's quoted command checks it off — previously these steps
      // could never complete and dragged the checklist down after a green run.
      if (planSteps && call.name === 'bash' && summary.startsWith('Ran: ') && command?.text) {
        const idx = applyPlanCommand(planSteps, command.text);
        if (idx >= 0) {
          opts.onPlanProgress?.(planSteps);
          const done = planSteps.filter(s => s.done).length;
          planCheckoff =
            done === planSteps.length
              ? `Plan complete — all ${planSteps.length} steps checked off.`
              : `Plan step ${planSteps[idx].n} checked off (${done}/${planSteps.length}) — command ran.`;
        }
      }
      const payloadId = payload ? opts.payloads.put(payload) : undefined;
      const toolMsg: Message = {
        role: 'tool',
        callId: call.id,
        summary,
        payload,
        payloadId,
        ...(diff ? { diff } : {}),
        ...(command ? { command } : {}),
      };
      opts.history.push(toolMsg);
      opts.onMessage(toolMsg);
      // Read-first (#72): ground the path against the message just pushed, so the gate can later ask
      // whether those exact bytes are still in the request rather than whether they ever were.
      if (groundsPath) {
        readFirst.ground(groundsPath, groundsAuthored ? undefined : opts.history.length - 1);
      }
      // A tool's harness-side-effect receipt (e.g. URL grounding) goes out as a standalone system
      // line AFTER its chip — a follow-on to the edit, not stuffed in front of it. Also logged so a
      // run is classifiable in REIKA_DEBUG (which URL grounding was otherwise invisible to).
      if (toolNotice) {
        opts.onMessage({ role: 'system', tone: toolNotice.tone, content: toolNotice.content });
        debugLog(
          `[reika:debug] round=${i} url-grounding mode=${call.name} ${toolNotice.content}\n`,
        );
      }
      // The plan check-off receipt follows the edit's result line for the same reason: it's a
      // persistent record of a harness side effect of that edit (signal-lifetime rule — the
      // checklist panel is ephemeral, this line is what reconstructs the run afterwards).
      if (planCheckoff) {
        opts.onMessage({ role: 'system', tone: 'info', content: planCheckoff });
      }
    }
    // A round that added no new keys (all re-reads of already-seen sections / repeat searches) is a
    // stall; enough consecutive stalls trip the adaptive force-write on the next iteration.
    planStaleRounds = seenReadOnly.size > seenBeforeRound ? 0 : planStaleRounds + 1;
  }

  const exhausted: Message = {
    role: 'assistant',
    content: `(reached max turns of ${opts.config.maxTurns}; ask me to continue or raise the turn limit)`,
    durationMs: Date.now() - turnStart,
    ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
  };
  opts.history.push(exhausted);
  opts.onMessage(exhausted);
}

// Chars of partial reasoning kept on a manual abort — enough that a follow-up nudge has the model's
// recent thinking to build on, capped so a long (possibly spiraling) block can't bloat history.
const ABORTED_REASONING_CAP = 4000;

function commitAborted(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  partial: string,
  partialReasoning: string | undefined,
  turnStart: number,
  fetchedUrls: Set<string>,
): void {
  const content = partial ? `${partial}\n\n(aborted)` : '(aborted)';
  // Keep the partial reasoning (capped, most-recent) on the aborted message. On a mid-reasoning
  // ctrl-c the content is empty, so without this the turn commits a bare "(aborted)" and the model's
  // thinking is lost — a follow-up nudge then starts from nothing, which is exactly when manual
  // recovery is weakest (early turns). Committing it gives the next turn something to build on. (The
  // verbatim auto-abort path deliberately does NOT keep it — that reasoning is spiral garbage and it
  // recovers from findings instead.)
  const trimmed = partialReasoning?.trim();
  const reasoning = trimmed
    ? trimmed.length > ABORTED_REASONING_CAP
      ? `…${trimmed.slice(-ABORTED_REASONING_CAP)}`
      : trimmed
    : undefined;
  const m: Message = {
    role: 'assistant',
    content,
    ...(reasoning ? { reasoning } : {}),
    durationMs: Date.now() - turnStart,
    ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
  };
  opts.history.push(m);
  opts.onMessage(m);
}

// Honest terminal stop when reasoning keeps spiraling even through recovery (the force-write looped,
// or the recovery budget is spent). Better than committing spiral garbage as a "plan" or running to
// the token wall. Names the files examined so the user has a handle on what was done. Deliberately
// not marked planFinal — it isn't a plan, so the plan→agent handoff won't treat it as one.
function commitSpiralStop(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  turnStart: number,
  fetchedUrls: Set<string>,
  restarts = 0,
): void {
  const files = new Set<string>();
  for (const m of opts.history) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if (typeof tc.args.path === 'string') files.add(tc.args.path);
    }
  }
  const examined =
    files.size > 0 ? ` Files I examined: ${[...files].slice(0, 12).join(', ')}.` : '';
  const m: Message = {
    role: 'assistant',
    content:
      `I couldn't converge — the reasoning kept looping and was stopped to avoid running ` +
      `indefinitely.${examined}${restartNote(restarts)} This looks like a request the model is ` +
      `getting stuck on; try rephrasing or narrowing it, or use a stronger model.`,
    durationMs: Date.now() - turnStart,
    ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
  };
  opts.history.push(m);
  opts.onMessage(m);
}

// Agent-mode terminal stop for a reasoning loop that survived the ledger + withdrawal (escaping via
// bash). Ends the turn honestly rather than running to maxTurns. If the turn made edits, the work is
// already on disk — frame it as "done but stopped re-checking" and name the edited files; otherwise
// it's a stuck-without-progress stop. Mirrors commitSpiralStop (plan mode).
// How the stop describes itself once restarts exist. Without this the terminal copy reads the same
// whether the harness gave up immediately or already spent two clean restarts — a difference the
// user needs, because it says whether the model is stuck on the request or on the approach.
function restartNote(restarts: number): string {
  if (restarts <= 0) return '';
  return restarts === 1
    ? ' I already restarted once with a clean summary and it looped again.'
    : ` I already restarted ${restarts} times with a clean summary and it looped again each time.`;
}

function commitAgentLoopStop(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  turnStart: number,
  fetchedUrls: Set<string>,
  edited: boolean,
  restarts = 0,
): void {
  const files = new Set<string>();
  for (const m of opts.history) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if ((tc.name === 'edit' || tc.name === 'write') && typeof tc.args.path === 'string') {
        files.add(tc.args.path);
      }
    }
  }
  const fileList = files.size > 0 ? ` to ${[...files].slice(0, 8).join(', ')}` : '';
  const note = restartNote(restarts);
  const content = edited
    ? `I made changes${fileList} but then kept repeating the same checks without making progress, so ` +
      `I've stopped to avoid looping.${note} The edits are saved — review them and ask me to continue ` +
      `if anything's off.`
    : `I kept repeating the same step without making progress, so I've stopped rather than loop.${note} ` +
      `Let me know how you'd like to proceed.`;
  const m: Message = {
    role: 'assistant',
    content,
    durationMs: Date.now() - turnStart,
    ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
  };
  opts.history.push(m);
  opts.onMessage(m);
}

type RunTurnOpts = Parameters<typeof runTurn>[0];

function makeSpawnSubagent(parent: RunTurnOpts) {
  return async (sub: { task: string }): Promise<ToolResult> => {
    const subConfig: Config = {
      ...parent.config,
      model: parent.config.subagentModel ?? parent.config.model,
      baseURL: parent.config.subagentBaseURL ?? parent.config.baseURL,
      apiKey: parent.config.subagentApiKey ?? parent.config.apiKey,
      maxTurns: parent.config.subagentMaxTurns,
    };
    const subTools = parent.tools.filter(t => t.name !== 'subagent');
    const subHistory: Message[] = [];

    await runTurn({
      userInput: sub.task,
      history: subHistory,
      bundle: parent.bundle,
      config: subConfig,
      tools: subTools,
      payloads: parent.payloads,
      signal: parent.signal,
      requestApproval: parent.requestApproval,
      onUsage: parent.onUsage,
      onMessage: msg => parent.onMessage({ ...msg, nested: true } as Message),
      // streaming + phase callbacks are intentionally not forwarded so the parent's
      // live region stays clean; subagent activity is visible via nested committed messages
    });

    const finalAssistant = [...subHistory].reverse().find(m => m.role === 'assistant') as
      | (Message & { role: 'assistant' })
      | undefined;
    const result = finalAssistant?.content ?? '';
    const usedDifferentModel = subConfig.model !== parent.config.model;
    return {
      summary: usedDifferentModel
        ? `Subagent (${subConfig.model}) completed (${result.length} chars)`
        : `Subagent completed (${result.length} chars)`,
      payload: result || '(no output)',
    };
  };
}
