import type {
  ApprovalRequest,
  Config,
  ContextBundle,
  EditFailure,
  Message,
  QuestionAnswer,
  QuestionRequest,
  Tool,
  ToolResult,
  Usage,
  WebHealth,
  WebBudget,
} from '../types.js';
import { buildSystemPrompt, type PromptMode } from './prompt.js';
import type { NativeImage } from './attachments.js';
import { callModel } from '../provider/client.js';
import { latchesFor } from '../provider/latches.js';
import { estimateRequestTokens, estimateTokens } from '../provider/tokens.js';
import {
  computeMaxTokens,
  NATIVE_IMAGE_TOKEN_ALLOWANCE,
  shouldRetryTruncated,
} from '../provider/budget.js';
import {
  compactHistory,
  shouldCompact,
  compactThreshold,
  gatherPlanFindings,
  distillPlanHandoff,
  batchAgePayloads,
  AGE_LOW_FRACTION,
} from './compaction.js';
import {
  droppedPayloadCount,
  findFreshToolBlockStart,
  hasDroppedPayloads,
  lastUserMessageIndex,
  taskSpecIndex,
  toolsToChatTools,
} from '../provider/toolcall.js';
import { ReadTrace, type LoopingRead } from './readtrace.js';
import { PrefixTrace } from './prefixtrace.js';
import { PrefillRate, formatPrefillCost, reprocessedTokens, sampleTokens } from './prefillcost.js';
import { DecodeRate, decodeSample, formatRate } from './decoderate.js';
import { GenReserve, resolveGenReserve, withGenReserve } from './genreserve.js';
import {
  selfRepeatRatio,
  repeatedSelfShingles,
  ReasoningTrace,
  liveSpinSignal,
  verbatimAbortThreshold,
} from './reasoningtrace.js';
import { ContinuationGate, continuationGate, continuationTail } from './continuation.js';
import { biasableShingles, buildRuminationLogitBias } from './logitrecovery.js';
import { EntropyTrace, formatEntropyReading } from './entropytrace.js';
import {
  extractPlanReferences,
  verifyPlanReferences,
  buildGroundingNote,
  shouldSuppressGrounding,
} from './groundcheck.js';
import { collectSourcedUrls } from '../tools/_exfil.js';
import { groundUrlsForPlan } from '../tools/_urls.js';
import { referencesSpill } from '../tools/_spill.js';
import { isInspectionEscape } from '../tools/_readonly.js';
import { sandboxExecAvailable } from '../tools/_sandbox.js';
import { writeTargets } from '../tools/_writetargets.js';
import { READ_DEFAULT_LIMIT } from '../tools/read.js';
import { recordFollowed, spillStatsEnabled } from '../tools/_spillstats.js';
import {
  seedPlanProgress,
  planChanged,
  refineTarget,
  applyEdit as applyPlanEdit,
  applyCommand as applyPlanCommand,
  buildPlanProgressLedger,
  decidePlanGate,
  waiveUnchecked,
  ranSuccessfully,
  MAX_PLAN_GATE_ROUNDS,
  type PlanStep,
  type PlanMarker,
  type StepMatch,
} from './plantrack.js';
import { ReadFirstGate, buildReadFirstDirective, probeWouldLand } from './readfirst.js';
import {
  SUBAGENT_REPORT_DIRECTIVE,
  SUBAGENT_REPORT_FRAME,
  SUBAGENT_HOLD_NOTE,
  MAX_SUBAGENTS_PER_TURN,
  MAX_SUBAGENTS_PER_ROUND,
  type SubagentBudget,
  buildCoverageNote,
} from './subagentreport.js';
import {
  COMPACTION_REPORT_RETRY,
  buildCompactionReportDirective,
  clampCompactionNote,
  compactionReportEnabled,
} from './compactionreport.js';
import {
  buildSubagentAffordance,
  filesInResult,
  subagentPressureEnabled,
  underPressure,
} from './subagentpressure.js';
import { foldAfterShed, wouldFold, type CompactionNote } from './compaction.js';
import {
  ceilingPressure,
  planFill,
  planPressureFor,
  planPressureLine,
  planRoundCeiling,
  type PlanPressure,
} from './planpressure.js';
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
const WEB_LOOKUP_ARG: Record<string, string> = { search: 'query', fetch_url: 'url' };
// Tools whose whole purpose is mutation. They reset the repeat memory, since repo state may
// have changed, so a legitimate read-after-edit is never mistaken for a loop. Deliberately
// NOT including `bash`: it's used for read-only greps far more than mutation here, and letting
// it clear would wipe read-tracking between every interspersed `bash grep`.
const MUTATING_TOOLS = new Set(['write', 'edit']);

// Whether a call is ABOUT to write to the working tree, asked before dispatch. `bash` counts when
// the command names files it will write — a model editing through `sed -i`, a heredoc, or `tee` is
// mutating the repo as surely as the edit tool is, and the two done-gates below exist to verify
// exactly that (#278). Best-effort for bash by construction: writeTargets sees the shapes a model
// reaches for and cannot see `npm run fix` or a script that writes wherever it likes. That is the
// right failure here — the only consumer is the typecheck baseline, which must be captured BEFORE
// the command runs and whose whole design is fail-open (no baseline = no gate). A miss costs one
// unverified turn; a false positive would cost a tsc run on a turn that never edited.
//
// Deliberately NOT folded into MUTATING_TOOLS itself: that set also resets the repeat memory in
// flagRepeatedCall, where bash is excluded on purpose (it runs read-only greps far more often than
// it mutates, and letting it clear would wipe read-tracking between interspersed `bash grep`s).
// Same question, different answers, so they stay separate predicates.
export function willMutate(name: string, args: Record<string, unknown>, cwd: string): boolean {
  if (MUTATING_TOOLS.has(name)) return true;
  if (name !== 'bash') return false;
  return writeTargets(String(args.command ?? ''), cwd).length > 0;
}

// The file a mutating call anchors its tsconfig walk-up on. For edit/write that is the path it was
// given; for bash, the first file the command names, which is as good an anchor as any when one
// command touches several (they are resolved against the same cwd, so a monorepo command editing
// two packages picks one — the alternative, a tsconfig per target, would mean a baseline per
// config, and the gate's whole budget is one). Re-parses the command that `willMutate` already
// parsed; it runs at most once per turn (typecheckBaselineAttempted), on a pure string.
export function typecheckAnchor(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (MUTATING_TOOLS.has(name)) return typeof args.path === 'string' ? args.path : undefined;
  if (name !== 'bash') return undefined;
  return writeTargets(String(args.command ?? ''), cwd)[0];
}

// Whether a call DID change the working tree, asked after dispatch. Inside a repo `changes` is
// git-backed (tools/_treediff.ts), so for bash this is the accurate half of the pair and catches
// what writeTargets cannot — the formatter, the codegen script, `npm run fix`. edit/write keep
// their existing semantics: the ATTEMPT counts, failed or not, because a failed edit is what puts
// the turn in edit-recovery. Only bash has to have actually landed something, since "the model ran
// a command" is not evidence it edited anything.
export function didMutate(name: string, changes: ToolResult['changes']): boolean {
  if (MUTATING_TOOLS.has(name)) return true;
  return name === 'bash' && !!changes && changes.files.length > 0;
}

// The repeat key for a call. `read` normalizes away `limit` and keys on (path, offset): a
// model that re-reads from the same position with a different window — read(path, limit=100)
// then limit=300 then limit=80, all starting at line 1 — is looping even though each summary
// differs. Other tracked tools key on their result summary, which encodes their semantic
// identity (grep pattern, list/glob dir+pattern, bash command + byte count).
function repeatKey(name: string, args: Record<string, unknown>, summary: string): string {
  if (name === 'read') return `read\0${String(args.path ?? '')}\0${Number(args.offset ?? 1)}`;
  return `${name}\0${summary}`;
}

// Per-key repeat memory. `window` and `narrowings` only matter for reads (see the carve-out in
// flagRepeatedCall); other tools carry Infinity/0 and behave as a bare counter.
export type RepeatEntry = { count: number; window: number; narrowings: number };

// How many times a shrinking window may restart the repeat run for one read region — the same
// bound readtrace.ts uses (MAX_NARROWINGS there), kept in step so the metric and the nudge agree
// about which read is the loop.
const MAX_NUDGE_NARROWINGS = 3;

// On a repeat of the same tracked call within a turn, append an escalating redirect to the
// payload so a looping model gets a "this won't change" signal at the point of recency.
// Untracked tools (fetch/search/subagent/unknown) pass through; mutating tools reset memory.
export function flagRepeatedCall(
  seen: Map<string, RepeatEntry>,
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
  const prior = seen.get(key);
  // Resolved exactly as the read tool resolves it, so a default-window read followed by an explicit
  // narrower one compares as narrowing rather than as a repeat.
  const window = name === 'read' ? Math.max(1, Number(args.limit ?? READ_DEFAULT_LIMIT)) : Infinity;
  let entry: RepeatEntry;
  if (!prior) {
    entry = { count: 1, window, narrowings: 0 };
  } else if (window < prior.window && prior.narrowings < MAX_NUDGE_NARROWINGS) {
    // A strictly smaller window from the same start line is the move the fit-to-window omission
    // marker (provider/toolcall.ts capPayload) asks for: the earlier copy arrived with its middle
    // cut out, and a narrower read is how the model gets those bytes. Observed on a 24k window:
    // read(1-300) capped -> read(1-150) capped again AND told "re-reading won't make progress" —
    // the nudge contradicted the marker and the model spun on which one to believe. Restart the
    // run instead of counting it; repeating the same narrow window afterwards falls through to
    // the counter, so genuine spinning is still caught a round later. Mirrors readtrace.ts, which
    // already classes this read as `narrowed` — this is the path whose text the model sees.
    entry = { count: 1, window, narrowings: prior.narrowings + 1 };
  } else {
    entry = { count: prior.count + 1, window, narrowings: prior.narrowings };
  }
  seen.set(key, entry);
  const count = entry.count;
  if (count <= 1) return payload;
  // For reads, point at the exact range (the summary names path + lines) so a weak model gets a
  // concrete redirect, not a generic "do something different". The claim is anchored on the always-
  // true fact — re-reading the same start line with the same window returns the same bytes —
  // rather than on where any prior copy lives: this read's own payload is live in the next request
  // by construction, so the nudge needs no liveness check. "Live" is not "whole", though: the cap
  // can have cut this copy too, so the remedy named is the one that works in that case as well.
  if (name === 'read') {
    return (
      (payload ?? '') +
      `\n\n(reika: you have re-read this same range ${count} times this turn (${summary}) — ` +
      `re-reading the same start line with the same window returns the same bytes and won't make ` +
      `progress. If this copy arrived with its middle omitted, read a range small enough to arrive ` +
      `whole (the omission marker says how many lines fit). Otherwise act on what you already ` +
      `have, page to a different part of the file, or open another file.)`
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
// looping model is cut off PLAN_STALL_ROUNDS rounds after it stops making progress. The round
// ceiling (planRoundCeiling, agent/planpressure.ts) is a backstop against a model that keeps finding
// trivially-new things forever.
const PLAN_STALL_ROUNDS = 2;
// Generation room reserved for the plan at force-write — the rest of the window budgets the
// transform's reference material. These models emit a few thousand tokens of reasoning *before*
// the plan, so 2048 left them cut off mid-write (finishReason=length → a wasted retry); 4096 fits
// reasoning+plan in one shot while still leaving ample window for grounding. The truncation-retry
// remains the backstop for an unusually long generation.
const PLAN_WRITE_RESERVE_TOKENS = 4096;

// Char budget for the transform turn: the window minus the plan's generation reserve, in chars
// (calibration ≈1 here), with a safety margin. Without this, dumping every read into one turn
// overflows the window on a large task — the real cause of the large-repo 400s.
function planTransformBudgetChars(window: number): number {
  return Math.floor((window - PLAN_WRITE_RESERVE_TOKENS) * 4 * 0.85);
}

// What the write's findings would cost at full size, measured as gatherPlanFindings charges it.
function planGatheredChars(history: Message[]): number {
  let chars = 0;
  for (const m of history) {
    const body = m.role === 'tool' ? m.payload?.trim() : undefined;
    if (m.role === 'tool' && body) chars += m.summary.length + body.length + 8;
  }
  return chars;
}
// Reasoning-loop break (Layer 2, on by default since 2026-09-24; `=0` is the baseline arm): act when
// the model's reasoning goes cross-round circular — re-deriving the same analysis instead of
// converging. Plan mode force-writes; agent mode drives the ledger → withdrawal → terminal-stop
// ladder. Off, the ReasoningTrace still records for the debug diagnostic but its verdict is never
// acted on. Calibrated from real transcripts:
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
const REASONING_LOOP_BREAK = process.env.REIKA_REASONING_LOOP !== '0';
// EXPERIMENT (Tier 2 logit recovery): one biased round before the rumination terminal stop, gently
// down-weighting the loop's recurring tokens to nudge the model off the rut. On by default since
// 2026-09-26 (`REIKA_LOGIT_RECOVERY=0` is the baseline arm); strict no-op when off, and self-gating
// on /tokenize being reachable (so non-llama.cpp backends just stop honestly). Only ever fires at the rumination dead-end, which is structurally non-edit-recovery —
// the case where biased tokens are filler, not the work. See agent/logitrecovery.ts.
const LOGIT_RECOVERY = process.env.REIKA_LOGIT_RECOVERY !== '0';
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
// carried verbatim into the executing agent turn. On by default since 2026-09-26
// (`REIKA_PLAN_VERIFY=0` is the baseline arm); strict no-op when off. See
// agent/groundcheck.ts and [[reika-reasoning-loop-break]].
const PLAN_VERIFY = process.env.REIKA_PLAN_VERIFY !== '0';
// Recompute the live reasoning-spin hint at most every this many new reasoning chars — cheap, but no
// need to re-scan a trailing window on every token. Display-only; see reasoningtrace.ts liveSpinSignal.
const REASONING_SPIN_DEBOUNCE = 400;
// Auto-abort a reasoning stream that's stuck — either a near-verbatim decoder loop (provably stuck at
// any length) or a long block that's gone moderately repetitive (a semantic spiral, which we won't
// judge at normal length but which past a pathological length is clearly not deliberation). The bar
// is length-aware (verbatimAbortThreshold): no ratio abort under 2000 chars, 0.35 from there, easing
// to 0.25 as the block grows, so genuinely-long DISTINCT reasoning (low ratio) is left alone. The
// bars sit far above every healthy block measured and far below the observed loop — the sample and
// its margins are documented at the constants, and they are the argument for the numbers. The one place mid-stream abort is sound; without it the only backstop is the
// max_tokens wall, ~17k+ tokens away on a near-empty context. On by default since 2026-09-26
// (`REIKA_VERBATIM_ABORT=0` is the baseline arm), independent of the always-on soft hint. Bounded
// per turn so the abort→recover cycle can't loop.
// A positive integer from the environment, or the default. Rejects 0 and negatives: unlike the
// continuation knobs, a ceiling of 0 would cut every block at the first delta, which is not an arm
// anyone wants and would read as "the flag disabled it".
function ceilFromEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
// 2 (not 1) so the force-write *recovery round* is itself abort-protected — a deeply-stuck model
// spirals in the force-write too, and the first budget unit is spent cutting the original spiral.
const MAX_VERBATIM_RECOVERIES = 2;
// Absolute reasoning-length backstop (chars): cut a single uninterrupted reasoning block past this
// REGARDLESS of ratio. Catches a low-repetition *semantic* spiral (ratio ~0.3) that the ratio curve
// won't — which is exactly what a spiraling force-write looks like. 32000 ≈ 8000 tokens, ~2x the
// healthy single-block max, so genuine long deliberation is untouched. The force-write round uses a
// tighter ceil: a transform legitimately reasons only a few hundred tokens (observed ~300-400t), so
// anything near 3000t there is stuck and there's no reason to let it run to 8000.
// Overridable ONLY as a measurement affordance: the ceiling branch is otherwise unreachable in a
// bench (a model must produce 32000 chars twice in a row with no tool call in between), and the
// alternative — editing the constant locally for a run — is how an A/B ends up comparing two
// different builds. Default unchanged, so a run that does not set it behaves exactly as before.
const REASONING_HARD_CEIL = ceilFromEnv('REIKA_REASONING_CEIL', 32000);
const FORCE_WRITE_REASONING_CEIL = 12000;
const VERBATIM_ABORT = process.env.REIKA_VERBATIM_ABORT !== '0';
// EXPERIMENT (#284): generation cut off mid-thought carries the model's own work forward instead of
// discarding it and nudging a restart. The retry this replaces destroyed a measured 30,270-char
// block that was cut ONE CLAUSE after solving its problem (selfRepeatRatio 0.014 — below the p90 of
// healthy blocks), and the restart re-ran the same `gh issue view` plus two greps, putting identical
// payloads in context twice and feeding the #251/#252 re-fetch cascade. ON by default: a live run
// carried 3/3 truncations with the model resuming its own thread each time, and a refused carry is
// exactly the previous behavior. It does change what a request carries, so set `=0` for a run that
// is measuring context/eviction (#264). Strict no-op when off. See agent/continuation.ts.
const CONTINUE = process.env.REIKA_CONTINUE !== '0';
// The resume nudge. Four jobs, and the string it replaced ("continue concisely ... no long
// preamble") failed all four — it read as *start over, briefly*, and the model did exactly that.
// Attribute the text above as the model's own; anchor the resume point (the tail ends mid-sentence,
// so "that exact point" needs no interpretation); frame the trim as superseded working rather than a
// gap, since an over-thinker will audit a gap; and forbid the restart explicitly, because the
// observed failure re-ran `gh issue view` and two greps and put identical payloads in context twice.
const CONTINUE_NUDGE =
  '(your previous response was cut off at the token limit. the text above is your own work — it ' +
  'ends mid-thought. continue from that exact point. any earlier part was trimmed to fit; what ' +
  'remains is your most recent working. do not start over, and do not re-run tools you have ' +
  'already called — their results are above.)';
// The plan write's resume nudge: same four jobs, minus the tool clause (the write round has none)
// and plus the deliverable, since a draft carried forward is reasoning and the plan is still owed.
const PLAN_WRITE_CONTINUE_NUDGE =
  '(your plan write was cut off at the reasoning length limit. the text above is your own work — ' +
  'it ends mid-thought. continue from that exact point and then write the numbered plan. any ' +
  'earlier part was trimmed to fit; what remains is your most recent working. do not start over.)';
// The plan write's tighter ceiling exists to catch a transform spiraling at a LOW ratio (~0.3), so
// the exploration gate (continuable below verbatimAbortThreshold, 0.35) would admit exactly that
// case. Healthy blocks measured 0.000–0.063 (#285), and the cut that prompted this was 0.00, so the
// bar sits between the two populations rather than at the abort curve.
const PLAN_WRITE_CARRY_MAX_RATIO = 0.15;
// EXPERIMENT (converge retry): instead of giving up the moment the model can't converge — a plan-mode
// force-write that spiraled, or an agent reasoning loop that reached its terminal — spend ONE more
// *steered* attempt first: a strong, failure-naming directive ("you looped and kept re-questioning
// yourself; commit to one analysis/action and do it") rather than a cold stop. Capped at
// MAX_CONVERGE_RETRIES, and in plan mode the retry round gets a tighter reasoning ceil so a re-spiral
// is cut fast — cheap-to-fail. Worst case is unchanged (the same honest stop fires once the budget is
// spent); we just insert a best-effort push before it. Motivated by a manual finding: a third retry
// with exactly this steer converged where two unsteered attempts (one logit-biased) spiraled — the
// natural-language steer reaches the behavioral self-questioning spiral that token bias can't. On by
// default since 2026-09-26 (`REIKA_CONVERGE_RETRY=0` is the baseline arm); strict no-op when off. See
// AGENTS.md "Loop breaking".
const CONVERGE_RETRY = process.env.REIKA_CONVERGE_RETRY !== '0';
const MAX_CONVERGE_RETRIES = 1; // one strong push; the user can retry fully after. Bump later if worth it.
// Tighter reasoning ceil for a steered plan-mode retry than a normal force-write (12000): if the steer
// is ignored and it re-spirals, cut it fast (~2k tokens) rather than burning the full force-write ceil.
const STEER_RETRY_REASONING_CEIL = 8000;
// Plan→agent handoff: fold the plan-mode exploration that precedes a written plan into a compact
// digest at the start of each agent turn, so the plan stays salient instead of being buried under
// the raw read transcript (agent/compaction.ts distillPlanHandoff). On by default since 2026-09-19;
// `REIKA_PLAN_HANDOFF=0` is the baseline arm. Independent of REIKA_PLAN_EXPERIMENT (which only sets
// the *starting* mode, so reusing it would skip distillation whenever plan mode is reached via
// /plan). Strict no-op when off.
const PLAN_HANDOFF_DISTILL = process.env.REIKA_PLAN_HANDOFF !== '0';
// EXPERIMENT (plan alignment, #68): during agent turns that execute a written plan, keep the
// harness-tracked step checklist in the system suffix each round (buildPlanProgressLedger) and
// bounce a turn that tries to finish with file-bearing steps unchecked (decidePlanGate, the plan
// analogue of the typecheck gate). The *tracking* is always on and deterministic (it feeds the UI
// checklist); this flag gates only the model-facing pressure. On by default since 2026-09-26
// (`REIKA_PLAN_ALIGN=0` is the baseline arm).
const PLAN_ALIGN = process.env.REIKA_PLAN_ALIGN !== '0';
// EXPERIMENT (prefix-stable context, #69): keep consecutive requests append-only between shrink
// events so the inference engine's prompt-prefix cache stays valid. Three per-round prefix
// rewriters move to event-driven or tail-positioned equivalents: payload aging becomes sticky +
// batched (compaction.ts batchAgePayloads), reasoning pruning follows the same sticky boundary,
// and the regenerated ledgers/nudges ride a transient trailing user message instead of a system
// suffix (a system change invalidates the cache from token 0; the tail is rewritten every round
// anyway). Rationale: every mid-history byte change forces the engine to re-process from that
// point — and SWA/hybrid-memory models (no partial-prefix restore) re-process the WHOLE prompt on
// ANY divergence, observed at ~3 min/request on a 35B. Requires REIKA_CONTEXT_WINDOW (sticky
// liveness needs the batch-aging watermark to bound it); silently inactive without one. On by
// default since #181: measured on a 27B at 22.9 tok/s prefill, a mid-context edit re-processed
// 8453 tokens (7.9 min) where an append was 25 tokens (3.5 s), and flag-off the prefix diverges
// from round 2 of every tool-using turn — a cost the engine cannot absorb (`--cache-reuse` was
// byte-identical). `REIKA_PREFIX_STABLE=0` restores the per-round aging as the A/B baseline;
// strict no-op when off.
const PREFIX_STABLE = process.env.REIKA_PREFIX_STABLE !== '0';
// EXPERIMENT (dropped-payload notice, #227): tell the model, once per request, that some tool
// results above show only a summary because their output was dropped. Flagged rather than shipped
// on, because it is a *prompt-level* bet and this repo's history says those often bench null (the
// preventive-alignment layer; REIKA_DEDUP_PAYLOADS, since defaulted on as a riskless no-op). It also
// has a real downside to measure, not
// just an absent upside: "re-run that call" can induce re-fetching of aged results, which costs
// rounds and re-inflates the fresh block — the dup-aged read loop the ledger→withdrawal ladder
// exists for. ON by default since 2026-09-18: a single-variable A/B on `/review 225` (n=3 off, 2 on)
// split exactly as predicted — the baseline reconstructed a dropped diff from memory and only then
// doubted itself, the ledger arm said "the output got dropped, let me re-run it" and re-fetched —
// and the feared re-fetch loop never showed, with the withdrawal ladder bounding it if it does.
// `=0` is the baseline arm. `read-trace-summary` is blind to it on a bash-fetching task (it records
// `read` only); transcripts are the instrument. Strict no-op when off.
const DROPPED_LEDGER = process.env.REIKA_DROPPED_LEDGER !== '0';
// Read-first gate (#72, on by default since 2026-09-23; `=0` is the baseline arm): withhold a blind
// edit — one to a file whose bytes are not live in the request the model just answered — ONCE per
// file, with a directive to read it first. The prevention analogue of the edit-recovery ledger: a
// blind old_string is a guess, and when it misses the model burns the failure round and sometimes
// spirals; a withheld round costs one read it needed anyway. Default-on on the risk profile, not a
// measurement: worst case is one append-only round per file per turn, fail-open (a re-issued edit
// runs as-is), suspended while inspection tools are withdrawn (the directed read would be refused).
// The `would-land=` field on the bounce debug line is the measurement. See agent/readfirst.ts.
const READ_FIRST = process.env.REIKA_READ_FIRST !== '0';

// EXPERIMENT (plan mode): the force-write turn is a *transformation*, not another exploration
// round. Asking the exploring model to "stop and write prose" fights its action prior and lets
// the plan it already has decay across turns; but the plan is reliably in its reasoning. So at
// the cap we discard the exploration history (and its read-momentum) and feed the model only the
// task + its own accumulated reasoning, with no tools, asking it to convert that into a plan.
// "Summarize your analysis into a plan" is a task weak models do far better than "decide to stop".
export function buildPlanWritePrompt(steer = false, refine = false): string {
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
  // Refinement (#46): the plan already exists and rides the next message verbatim, so this round is
  // a revision, not a derivation. Without the line a weak model rewrites the plan from the request
  // and silently drops the earlier decisions — the failure the refinement turn exists to avoid.
  // Stated before the steer so the steer stays last, closest to generation.
  if (refine) {
    lines.push(
      '',
      'A plan for this work was already written, and the next message includes it in full. Revise',
      'THAT plan: keep the steps that still hold, change only what the latest request from the user',
      'asks for, and write the whole updated numbered plan. Do not start over from a blank slate.',
    );
  }
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
// The force-write replaces the whole history with one synthesized message, and serialization
// attaches native images only to a user message that names their marker — the rebuilt request quotes
// the task truncated, often without it. Naming the live markers keeps the screenshot in front of the
// round that writes the plan, which is the round vibe mode attached it for.
export function nativeImageReminder(images: NativeImage[] | undefined): string {
  if (!images?.length) return '';
  return `\n\nThe request came with ${images.map(im => im.marker).join(', ')}, shown again here.`;
}

export function buildPlanTransformInput(
  history: Message[],
  budgetChars: number,
  dropAnalysis = false,
  // The plan this round is revising (#46), resolved by the caller from the history the turn STARTED
  // with — recomputing it here would see this turn's own assistant messages and lose the plan the
  // refinement exists to carry. Defaulted for direct callers/tests (a pre-turn history derives the
  // same answer).
  refine: PlanMarker | null | undefined = refineTarget(history),
): string {
  const first = history.find((m): m is Message & { role: 'user' } => m.role === 'user' && !m.meta);
  const task = (first?.content ?? '').slice(0, 2000);
  // Refinement (#46): a plan-mode turn that follows a written plan revises it rather than deriving
  // a new one — and this transform REPLACES the history with the single message below, so anything
  // it does not name is gone for this call. Two things would otherwise go missing on exactly that
  // turn: the previous plan (its content reaches the caller only as part of `gatherPlanAnalysis`'s
  // last-4000-char tail, mixed in with everything else, and dropped outright when the force-write
  // was loop-triggered) and the user's latest message — the delta the refinement exists to apply,
  // which is not the original request the `task` line quotes.
  const latestIdx = lastUserMessageIndex(history);
  const latest = latestIdx >= 0 ? ((history[latestIdx] as { content?: string }).content ?? '') : '';
  const ask = refine && latest && latest !== (first?.content ?? '') ? latest.slice(0, 2000) : '';
  // Kept whole, not truncated: the plan is the artifact this round exists to update, and a cut
  // mid-step plan is worse than a thinner findings dump below (whose budget absorbs the cost, down
  // to its own floor).
  const plan = refine?.content ?? '';
  // When the force-write was loop-triggered, the accumulated reasoning IS the spiral — feeding it back
  // as "your analysis" can re-prime the loop at the transform level. Drop it and rebuild the plan from
  // the findings (clean grounding) instead. For a normal (converged) force-write the analysis carries
  // the conclusion (Fix-5: the model often reaches the answer, then ruminates), so keep it then.
  // The plan message is filtered out of it when refining: it is carried verbatim above, and counting
  // it as "your analysis" would both pay for it twice and let a 4000-char tail cut it in half.
  // By identity, not index: a fold mid-turn splices the history under the index resolved at turn start.
  const analysisSource = refine ? history.filter(m => m !== refine.message) : history;
  const analysisRaw = dropAnalysis ? '' : gatherPlanAnalysis(analysisSource);
  // Keep the most recent analysis (where the converged plan lives) within a fixed cap.
  const analysis = analysisRaw.length > 4000 ? `…${analysisRaw.slice(-4000)}` : analysisRaw;
  const findingsBudget = Math.max(
    2000,
    budgetChars - task.length - plan.length - ask.length - analysis.length - 600,
  );
  return (
    `Original request:\n${task}\n\n` +
    (plan ? `The plan you already wrote:\n${plan}\n\n` : '') +
    (ask ? `The user's latest message (what to change):\n${ask}\n\n` : '') +
    `Reference material you gathered (file contents and search results):\n${gatherPlanFindings(history, findingsBudget)}\n\n` +
    (analysis ? `Your analysis:\n${analysis}\n\n` : '') +
    (plan
      ? 'Exploration is over. Write the whole updated plan now — the plan above, revised for the ' +
        "user's latest message — grounded in the reference material: keep the steps that still hold, " +
        'change only what was asked for, and use the exact file paths and identifiers above. Do not ' +
        'start over, and do not invent paths, filenames, or class names.'
      : 'Exploration is over. Write the numbered, file-specific plan for the request now, grounded in ' +
        'the reference material above — use its exact file paths and identifiers, and do not invent ' +
        'paths, filenames, or class names.')
  );
}

// A follow-up that only asks about the plan ("why step 3?") is answered in prose: re-emitting an
// unchanged plan costs a full plan of decode and then reads as a refinement that absorbed nothing.
const REFINE_LEDGER_RULE = [
  'If the latest message asks for a change: keep the steps that still hold, change only what it',
  'asks for, and end by writing the whole revised plan (the newest plan replaces the older one).',
  'If it only asks about the plan: answer it, and do not re-emit the plan — it stays live as written.',
];

// EXPERIMENT (plan mode): a deterministic exploration ledger appended to the system prompt
// each round. It surfaces what the model has already examined (so it stops re-treading) and
// applies escalating pressure (agent/planpressure.ts — by window fill, or round count without a
// window) to stop exploring and write the plan — the closure signal a read-only mode otherwise lacks. The model maintains none of this; it is
// derived in code from this turn's tool calls, so it cannot drift or be hallucinated.
function buildPlanLedger(
  history: Message[],
  pressure: PlanPressure,
  basis: { fillPercent?: number; round: number },
  // The plan this turn is refining (#46), resolved once by the caller rather than recomputed here:
  // from round 1 on, this turn's OWN assistant messages sit after the plan, and a per-round
  // derivation would stop recognizing the refinement half-way through the turn. Defaulted for the
  // callers that build a round-0 system out of a pre-turn history (the warm prefix, tests), where
  // deriving it is correct — and where the no-user-message-yet history gives the same answer
  // runTurn's round 0 does.
  refine: PlanMarker | null | undefined = refineTarget(history),
): string {
  const files = new Set<string>();
  const searches = new Set<string>();
  // Plan mode's read-only `bash` (#109) explores through a call that carries `command` and neither
  // `path` nor `pattern`. Without this the ledger goes blind exactly when that tool is used: it would
  // report "Nothing examined yet" every round to a model that had just read half the repo, and the
  // round-1/2 "you can probably stop" nudge (which keys on having examined something) would never
  // fire. The convergence pressure is the whole point of the ledger, so it has to see them.
  const commands = new Set<string>();
  // Web lookups (#290) explore through `query` (search) and `url` (fetch_url), which are the same
  // blind spot as bash's `command`: without them the ledger tells a model that has just grounded a
  // claim in the docs that it has examined nothing, and the early stop-exploring nudge never fires.
  const lookups = new Set<string>();
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if (typeof tc.args.path === 'string') files.add(tc.args.path);
      if (typeof tc.args.pattern === 'string') searches.add(tc.args.pattern);
      if (typeof tc.args.command === 'string') commands.add(tc.args.command);
      if (typeof tc.args.query === 'string') lookups.add(tc.args.query);
      if (typeof tc.args.url === 'string') lookups.add(tc.args.url);
    }
  }
  const cap = (s: Set<string>): string => {
    const shown = [...s].slice(0, 8).join(', ');
    return s.size > 8 ? `${shown}, +${s.size - 8} more` : shown;
  };
  const lines = ['', '--- plan-mode status (reika, auto-generated — not user input) ---'];
  // Refinement (#46): this turn follows a plan the model already wrote, so the plan is the thing to
  // revise — not the request derived from scratch again. Stated in the regenerated ledger rather
  // than the static prompt for the usual reason (it must hold every round of the turn, and it is a
  // fact about THIS turn's history, which the prompt builder never sees), and because a small model
  // reading its own plan above with no instruction treats a follow-up as a new task: it re-derives,
  // silently dropping the decisions the earlier turns settled. The pressure lines below apply as
  // they always do — a refinement usually needs one or two checks against the delta, not an
  // exploration, and the same novelty/ceiling rule is what bounds it.
  // A fold mid-turn can take the plan message with it, leaving at most a clipped recap line — then
  // "above" is false and the plan the turn exists to revise is gone, so the ledger carries it.
  if (refine && history.includes(refine.message)) {
    lines.push(
      'A plan you wrote earlier is above — the LIVE plan. This turn follows up on it.',
      ...REFINE_LEDGER_RULE,
    );
  } else if (refine) {
    lines.push(
      'The plan you wrote earlier is the LIVE plan; it was folded out of the history, so here it is:',
      refine.content,
      'This turn follows up on it.',
      ...REFINE_LEDGER_RULE,
    );
  }
  if (files.size > 0) lines.push(`Files examined: ${cap(files)}`);
  if (searches.size > 0) lines.push(`Searches run: ${cap(searches)}`);
  if (commands.size > 0) lines.push(`Commands run: ${cap(commands)}`);
  if (lookups.size > 0) lines.push(`Web lookups: ${cap(lookups)}`);
  if (files.size === 0 && searches.size === 0 && commands.size === 0 && lookups.size === 0) {
    lines.push(
      'Nothing examined yet — start by grepping the relevant symbol or reading the entry file.',
    );
  }
  const pressureLine = planPressureLine(pressure, basis);
  if (pressureLine) lines.push(pressureLine);
  return lines.join('\n');
}

// Whether this turn's history holds any exploration call — the same fields the ledger lists.
function planExamined(history: Message[]): boolean {
  return history.some(
    m =>
      m.role === 'assistant' &&
      (m.toolCalls ?? []).some(
        tc =>
          typeof tc.args.path === 'string' ||
          typeof tc.args.pattern === 'string' ||
          typeof tc.args.command === 'string' ||
          typeof tc.args.query === 'string' ||
          typeof tc.args.url === 'string',
      ),
  );
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
  // Plan mode's convergence tier. Omitted means the windowless round-count schedule.
  planPressure?: PlanPressure;
  planFillPercent?: number;
  // The plan this plan-mode turn is refining (#46). Absent → buildPlanLedger derives it from
  // `history`, which is what the warm prefix wants; runTurn passes the value it resolved from the
  // pre-turn history, since deriving mid-turn would see the turn's own messages.
  refine?: PlanMarker | null;
}): string {
  // First, and in both modes: settled context about the request itself, not a directive. Aging hits
  // plan exploration exactly as it hits an agent turn.
  const droppedLedger = droppedPayloadLedgerFor(opts.history, false);
  const dropped = droppedLedger ? '\n\n' + droppedLedger : '';
  if (opts.promptMode === 'plan') {
    const pressure =
      opts.planPressure ??
      planPressureFor({ round: opts.round, examined: planExamined(opts.history) });
    const ledger = buildPlanLedger(
      opts.history,
      pressure,
      {
        round: opts.round,
        fillPercent: opts.planFillPercent,
      },
      opts.refine,
    );
    return opts.baseSystem + dropped + '\n\n' + ledger;
  }
  const planLedger =
    PLAN_ALIGN && opts.planSteps && opts.planSteps.some(s => !s.done)
      ? '\n\n' + buildPlanProgressLedger(opts.planSteps)
      : '';
  return opts.baseSystem + dropped + planLedger;
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
/**
 * The tool-list-derived gates the agent prompt is built with. One function for both call sites
 * (`buildRoundZeroPrefix` and `runTurn`), because the warm prefix is worthless if it diverges from
 * round 0 by a line — see the canAsk note on buildSystemPrompt.
 */
export function promptGates(
  tools: Tool[],
  sandbox: boolean,
  unattended?: boolean,
): Pick<
  Parameters<typeof buildSystemPrompt>[0],
  'canAsk' | 'decideAlone' | 'canSubagent' | 'sandbox' | 'canFetch' | 'canSearch'
> {
  const has = (name: string): boolean => tools.some(t => t.name === name);
  return {
    canAsk: has('ask_user'),
    decideAlone: unattended === true && !has('ask_user'),
    canSubagent: has('subagent'),
    sandbox: sandbox && has('bash') && sandboxExecAvailable(),
    canFetch: has('fetch_url'),
    canSearch: has('search'),
  };
}

export function buildRoundZeroPrefix(opts: {
  history: Message[];
  bundle: ContextBundle;
  promptMode: PromptMode;
  // `config.sandbox`, for the agent prompt's sandbox sentence — same gate as runTurn's.
  sandbox: boolean;
  // `config.unattended`, for the decide-alone line (#526) — same gate as runTurn's.
  unattended?: boolean;
  // Minimal mode (#391). Rides alongside promptMode rather than replacing it — a minimal turn IS
  // an agent turn everywhere below the prompt — so the warm has to carry it too or it warms the
  // full-context prefix for a turn that will send the bare one.
  minimalPrompt?: boolean;
  // Grind mode (#556): the same reason as minimal — a different prompt on an agent turn.
  grindPrompt?: boolean;
  // Same gate as runTurn's `allowRefine` (#46): false for vibe's plan phase. The warm prefix must
  // match round 0 to the line, and the refine line rides exactly this composition (flag-off regime)
  // — one side gating and the other deriving would be a guaranteed cache miss.
  allowRefine?: boolean;
  // Needed only for the ask_user/subagent gates in the agent prompt, but it has to be the SAME list runTurn
  // will send: the warm prefix is worthless if it diverges from round 0 by a line.
  tools: Tool[];
  contextWindow?: number;
  calibration: number;
  minGenTokens: number;
}): string {
  if (PLAN_HANDOFF_DISTILL && opts.promptMode === 'agent') {
    distillPlanHandoff(opts.history, opts.contextWindow, opts.calibration, opts.minGenTokens);
  }
  const baseSystem = buildSystemPrompt({
    bundle: opts.bundle,
    mode: opts.promptMode,
    minimal: opts.minimalPrompt,
    grind: opts.grindPrompt,
    ...promptGates(opts.tools, opts.sandbox, opts.unattended),
  });
  if (prefixStableActive(opts.contextWindow)) return baseSystem;
  const planSteps = opts.promptMode === 'agent' ? seedPlanProgress(opts.history) : null;
  return buildSteadySystem({
    baseSystem,
    promptMode: opts.promptMode,
    history: opts.history,
    round: 0,
    planSteps,
    // Must match runTurn's round 0, which has sent no request yet to measure fill from.
    planPressure: planPressureFor({
      round: 0,
      examined: planExamined(opts.history),
      contextWindow: opts.contextWindow,
    }),
    // null = explicitly no refinement (vibe's plan phase); undefined = derive, like runTurn does.
    refine: opts.allowRefine === false ? null : undefined,
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
// How to name what was just paused, from this turn's actual tool list. The withdrawal ladder pauses
// two things — the INSPECTION_TOOLS set, refused at dispatch, and the read-only shell commands
// `isInspectionEscape` catches — and a mode that has only one of the two must not be told about the
// other. Falls back to the bare noun rather than an empty string: withdrawal can only fire on a turn
// that looped, which needs some inspection surface, so the fallback is unreachable in practice and
// exists so the sentence is never malformed.
export function withdrawnToolsPhrase(toolNames: ReadonlySet<string>): string {
  const named = [...INSPECTION_TOOLS].filter(n => toolNames.has(n));
  const shell = toolNames.has('bash');
  // The full-list branch is spelled out rather than assembled so agent mode's text stays
  // byte-identical to what it was before this became list-aware.
  if (named.length > 0 && shell) {
    return `inspection tools (${named.join('/')}, and read-only shell commands like grep/cat/tail)`;
  }
  if (named.length > 0) return `inspection tools (${named.join('/')})`;
  if (shell) return 'read-only shell commands (grep/cat/tail and similar inspection)';
  return 'inspection tools';
}

// What a withdrawn model still has to ACT with, named from the same list (#377: a tool result must
// never point the model at a tool it does not have — and a model told to reach for a tool it cannot
// see does not reach for anything). Agent mode has edit/write. Minimal mode (#391) has only bash,
// where the remedy is a writing command and still available: withdrawal pauses the INSPECTION half
// of bash, never the mutating half, precisely so real work survives the pause. Chat mode has
// neither, so the only remedies left are the two that need no tool at all — which is why this is a
// remedy CLAUSE rather than a tool name spliced into a fixed sentence.
export function withdrawalRemedy(toolNames: ReadonlySet<string>): string {
  if (toolNames.has('edit') || toolNames.has('write')) {
    return 'Make the edit the task requires with the edit/write tools';
  }
  if (toolNames.has('bash')) {
    return 'Make the change the task requires by running the command that applies it';
  }
  return 'Answer from what you already have';
}

// The hard tier of the loop ledger, hand-wrapped per mode. The remedy differs (see
// withdrawalRemedy) but the two escapes that need no tool at all — name the blocker, or stop if the
// change is done — survive in every mode: they are what keeps a cornered model from being forced
// into a wrong change. The edit/write branch is spelled out with its original line breaks so agent
// mode's suffix stays byte-identical.
function withdrawnLedgerLines(toolNames: ReadonlySet<string>): string[] {
  if (toolNames.has('edit') || toolNames.has('write')) {
    return [
      'Reading and searching are now PAUSED. Make the edit the task requires with the edit/write',
      'tools, state specifically what is still blocking you, or — if the change is already complete —',
      'say so and stop.',
    ];
  }
  if (toolNames.has('bash')) {
    return [
      'Reading and searching are now PAUSED. Make the change the task requires by running the',
      'command that applies it, state specifically what is still blocking you, or — if the change',
      'is already complete — say so and stop.',
    ];
  }
  return [
    'Reading and searching are now PAUSED. Answer from what you already have, state specifically',
    'what is still blocking you, or — if the change is already complete — say so and stop.',
  ];
}

// Returned in place of a withdrawn inspection call. No content, so it can't re-fuel the loop or
// inflate context; it just states the rule and the way out. Built per turn rather than held as a
// const because both halves — what is paused, and what to do instead — depend on the tool list.
export function buildWithdrawalDirective(toolNames: ReadonlySet<string>): string {
  return (
    `(reika: ${withdrawnToolsPhrase(toolNames)} are paused because you have repeated the same ` +
    'reads or searches without making progress. You already have what you need. ' +
    `${withdrawalRemedy(toolNames)}, state what is specifically blocking you, or — if the change ` +
    'is already complete — say so and stop. Reading and searching are unavailable until you make ' +
    'progress.)'
  );
}

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
export function buildAgentLoopLedger(
  looping: LoopingRead[],
  withdrawn: boolean,
  toolNames: ReadonlySet<string>,
): string {
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
    lines.push(...withdrawnLedgerLines(toolNames));
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

// Persistent, non-aging record of what the user has already settled this turn (tools/ask.ts). Same
// mechanism as the loop ledgers, for the same reason: the answer arrives as a tool result, and tool
// results age out under compaction — on a 16-24k window, well inside the turn that asked. A model
// that loses the answer does not fall back to guessing, it falls back to re-deriving the question,
// which is precisely the state the question was asked from. Pinning it to the regenerated suffix
// costs a few dozen tokens a round and makes the answer the one thing in the turn that cannot be
// forgotten. Empty (and therefore inert, including at round 0) until a question is actually answered.
// The ledger builders all start with a blank line so they read as a separated block when appended;
// this keeps that spacing when one is concatenated directly rather than through suffixParts.
function prefixed(ledger: string): string {
  return ledger ? '\n' + ledger : '';
}

// An aged tool message serializes to its summary alone — `Ran: gh issue view 213 (505 bytes
// output)` — which reads to a model as a result it already saw and handled, not as content that is
// GONE (#227). Observed on a `/issue` turn: after both `gh` payloads aged, the model wrote "let me
// re-read the issue once more", made no tool call, and quoted issue text that does not exist. Same
// affordance rule as capPayload's truncation marker (#102): an unservable state must be loud rather
// than silently look like success.
//
// Stated ONCE per request rather than per message. The per-message form was measured at ~2,700
// chars on a 30-round turn (~19% of the serialized request) — the note runs ~2.7x the aged summary
// it annotates — and being mid-history it moves the compaction trigger, the keep boundary and the
// cap arithmetic at once. As a ledger it costs one line, rides the same transport as every other
// ledger (system suffix, or the trailing note under REIKA_PREFIX_STABLE where the tail is rewritten
// each round anyway), and touches no budget walk. Emitted only when something actually was dropped,
// so it can never make a false claim.
// Single gate for all four compositions (see buildDroppedPayloadLedger). Routing every call site
// through one predicate is deliberate: the first version of this change reached only two of the
// four, and a bare `FLAG && hasDroppedPayloads(...)` at each site is the same mistake waiting to
// happen. Returns '' when the flag is off or nothing was actually dropped.
function droppedPayloadLedgerFor(history: Message[], prefixStable: boolean): string {
  return DROPPED_LEDGER && hasDroppedPayloads(history, prefixStable)
    ? buildDroppedPayloadLedger()
    : '';
}

// The sentence that identifies this ledger in a composed request. Exported so the debug line can
// look for it in the ACTUAL system/tail bytes rather than re-running the gate — the composition has
// four sites and re-deriving "did it fire?" is how a check drifts from what shipped.
export const DROPPED_LEDGER_MARKER = 'Their output was dropped to make room';

export function buildDroppedPayloadLedger(): string {
  return [
    '--- reika status (auto-generated — not user input) ---',
    'Some tool results above now show only their summary line (e.g. `Ran: … (505 bytes output)`)',
    `or a short outline of the output. ${DROPPED_LEDGER_MARKER}; it is not in your context`,
    'any more. That is a context limit, not a failed command, and it does not mean you already',
    'handled the result. If you need what one of them returned, re-run that call — do not answer',
    'from memory of it.',
  ].join('\n');
}

// The answer settles the one point that was asked, not the turn: ask_user fires mid-discussion as
// readily as mid-edit (its trigger is "two readings would produce different code"), and the earlier
// "Build exactly what that answer says" read as a go-ahead to implement whatever was being discussed
// — observed on an API model that reasoned "the system says build it" into an unrequested refactor.
// The prohibition half is the anti-relitigation force weak models need and is unchanged.
export function buildQuestionLedger(answers: { question: string; answer: string }[]): string {
  if (answers.length === 0) return '';
  const lines = ['', '--- reika status (auto-generated — not user input) ---'];
  lines.push('The user has already answered this, and it is settled:');
  for (const a of answers) {
    lines.push(`  Q: ${a.question}`, `  A: ${a.answer}`);
  }
  lines.push(
    'That settles this one point — continue what you were doing on that basis. Do not re-open it,',
    'do not weigh the alternatives again, and do not ask about it a second time.',
  );
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

// One shrink event, as the loop performed it. `age` is a batch-age shed (compaction.ts
// batchAgePayloads — the fields are its AgeResult); `fold` is a compaction of older turns into a
// recap. `round` is the tool round within the turn; the UI stamps the turn.
export type ShrinkEvent =
  | {
      kind: 'age';
      round: number;
      marked: number;
      bulk: number;
      crumbs: number;
      kept: number;
      short: number;
    }
  | { kind: 'fold'; round: number; removed: number; recapChars: number };

// Session-cumulative shrink counts, threaded across turns via `priorShrink`.
export type ShrinkCounts = { sheds: number; folds: number };

export async function runTurn(opts: {
  userInput: string;
  userDisplay?: string;
  // Skill this turn was opened with, stamped onto the user message. See Message.skill (#275).
  userSkill?: string;
  history: Message[];
  bundle: ContextBundle;
  config: Config;
  tools: Tool[];
  payloads: PayloadStore;
  // Pasted images to hand to the model directly, for a profile whose model can already see
  // (VisionRoute 'native'). Constant for the whole turn: every request the turn makes carries
  // them, so the model keeps seeing the image it was shown across the round's tool calls — and
  // because they land at the same tail position with identical bytes, carrying them costs no
  // re-prefill. The caller owns the lifetime: it clears its attachment ref the moment the turn
  // sends, so the next turn passes nothing and the image is gone.
  nativeImages?: NativeImage[];
  onMessage: (msg: Message) => void;
  onContentDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onPhase?: (phase: 'thinking' | 'tool') => void;
  // A subagent is running under one of this turn's tool calls (#342): true when it starts, false
  // when it returns. The parent is blocked inside the call with its own assistant message already
  // committed, so its live region is empty for the duration — the subagent's streaming callbacks
  // are forwarded into it, and this tells the UI to draw them at the nested indent.
  onSubagent?: (active: boolean) => void;
  // A compaction report round (#280) is running: the model is writing its note into the live
  // region. Same shape as onSubagent — the UI nests the stream and relabels the spinner — because
  // the note is a side conversation the same way a subagent is: its reasoning never enters history.
  onCompactionNote?: (active: boolean) => void;
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
  // Also fired after a compaction report round (#280), whose note streamed as content and committed
  // as a notice: the UI drops both previews so the round's real reply starts clean.
  onReasoningReset?: () => void;
  onUsage?: (usage: Usage) => void;
  // Pre-send estimate of the next request's prompt tokens. Fires before each model
  // call so the UI can show context fill before the provider's real count arrives.
  onContextEstimate?: (tokens: number) => void;
  // Subagent bounded return (#340): on the LAST round of the budget, withdraw every tool and
  // demand the report (SUBAGENT_REPORT_DIRECTIVE), so the turn's final assistant message — which
  // is what the parent receives as the digest — is a report and never `(reached max turns…)`.
  // Set by makeSpawnSubagent; the parent turn's cap keeps its honest-exhaustion message.
  reportAtCap?: boolean;
  // Every shrink event the turn performs — a batch-age shed or a compaction fold — with the
  // session-cumulative counts after it. The UI shows the counts as ambient status chips (the
  // gauge sawtooth already shows the events; a counter says how many teeth) and the transcript
  // saves the events themselves, which is otherwise only in the debug log. `priorShrink` threads
  // the counts across turns like `priorCalibration`, so the fold notice can number folds
  // session-wide.
  onShrink?: (event: ShrinkEvent, counts: ShrinkCounts) => void;
  priorShrink?: ShrinkCounts;
  // Calibration of the char-based estimate against the provider's real token count,
  // threaded across turns (each turn re-seeds the full history, so the learned factor
  // must persist for the first call's compaction decision to be accurate).
  priorCalibration?: number;
  onCalibration?: (factor: number) => void;
  // Learned prefill throughput (tokens/second), threaded across turns for the same reason as
  // calibration: each turn re-seeds history, so without it every turn's opening rounds have no
  // rate to price themselves with — and those are the expensive ones.
  priorPrefillRate?: number;
  onPrefillRate?: (rate: number) => void;
  // Learned decode throughput (tokens/second) — the status bar's `21 tok/s` chip (#204). Threaded
  // across turns for the same reason as the prefill rate, and smoothed for the same reason; decode
  // only, since prefill's number is an estimate and stays in the debug log. See agent/decoderate.ts.
  priorDecodeRate?: number;
  // undefined blanks the chip: a subagent on another endpoint has no rate of its own yet.
  onDecodeRate?: (rate: number | undefined) => void;
  // Session-long prefix-divergence trace (#426). The engine's cache still holds the previous turn's
  // last request when a new turn starts, so the comparison is only meaningful across the boundary
  // if the trace survives it; without one supplied, round 0 reads as `first-request` and the
  // boundary goes unmeasured. Not for subagents — their turns interleave with the parent's.
  prefixTrace?: PrefixTrace;
  // Session-long learned generation reserve (#551), for the same reason as the rates above: a
  // turn's round 0 needs what earlier turns observed. A subagent on the same engine shares it.
  genReserve?: GenReserve;
  // `tool` names the call the chunk came from: the UI indents only a `bash` tail, since that is the
  // one that commits under a command chip (#461) — `search`'s bot-check line does not.
  onToolProgress?: (chunk: string, tool: string) => void;
  // Fired inside the dispatch loop the moment a call is about to run (#509), for the UI's live
  // "…ing" row. That is the one gap `onToolProgress` cannot cover: a tool that emits nothing
  // (`read`/`grep`/`edit`/`write` never call onProgress) or a `bash` that has not printed yet is
  // otherwise silent between its call row committing and its result row landing. Fired only for a
  // call that actually executes — a refused, held, bounced or unknown call runs nothing, so it gets
  // no row; approval still happens inside the tool, after this fires, which is why the UI hides the
  // row while its own dialog is up.
  onToolStart?: (tool: string) => void;
  // Deterministic plan-progress snapshots (#68/#71): fired at agent turn start when the history
  // holds a written plan, and again whenever a step checks off (a successful edit/write touched a
  // file the step names). Drives the UI checklist; never model-facing (the model-facing ledger and
  // done-gate are gated behind REIKA_PLAN_ALIGN). The array is the loop's live tracker — copy it.
  onPlanProgress?: (steps: PlanStep[]) => void;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  requestQuestion?: (req: QuestionRequest) => Promise<QuestionAnswer | null>;
  // Whether the session is unattended right now (#526): `/unattended` toggles it mid-turn, so tools
  // read it per call. Absent, `config.unattended` (launch state, and headless's constant) decides.
  isUnattended?: () => boolean;
  signal?: AbortSignal;
  promptMode?: PromptMode;
  // Minimal mode (#391): shell-only tools and a prompt with no project context. NOT a PromptMode —
  // a minimal turn runs as an agent turn everywhere else in this loop, which is the whole design.
  minimalPrompt?: boolean;
  // Grind mode (#556): an agent turn with the grind procedure prompt and grindTools(). Same shape
  // as minimalPrompt, for the same reason.
  grindPrompt?: boolean;
  // Plan refinement (#46) is for plan-mode FOLLOW-UPS: the turn revises the plan the previous turn
  // wrote. False for vibe's plan phase — vibe chains its own implementation turn off the same
  // prompt, so the next vibe prompt is a NEW task whose plan merely happens to sit right after the
  // last one, and a revision framing would carry the previous chain's steps into it. The front end
  // knows which kind of turn this is (ui/commands.ts turnRefines); the loop only sees
  // `promptMode: 'plan'` either way and cannot tell them apart itself.
  allowRefine?: boolean;
  // `/compact` (issue #481). One harness-driven compaction round — the same machinery as the
  // automatic shrink event: compaction-note request, fold, session-cumulative counters, notices —
  // fired WITHOUT a user turn behind it. The user typed a slash command, so no user message enters
  // the history (a synthetic one would distort the recap's election) and no reply round follows the
  // fold: the turn is the compaction. Exists because a large-window setup can sit far under the
  // trigger all session while still carrying a lot the user would rather have folded now. Sharing
  // the loop's own numbering (`shrink`) is the point of doing it here rather than beside the loop:
  // auto compaction and /compact stay in sync regardless of which fired last.
  manualCompact?: boolean;
}): Promise<void> {
  if (!opts.manualCompact) {
    const userMsg: Message = {
      role: 'user',
      content: opts.userInput,
      ...(opts.userDisplay ? { display: opts.userDisplay } : {}),
      ...(opts.userSkill ? { skill: opts.userSkill } : {}),
      // What lets a later turn tell a plan-mode follow-up from any other turn (plantrack.ts
      // refineTarget) on the live history — the session stamps the recorded mode only on the copy
      // it emits. Only a refinable plan turn: vibe's plan phase opens a new task.
      ...(opts.promptMode === 'plan' && opts.allowRefine !== false
        ? { mode: 'plan' as const }
        : {}),
    };
    opts.history.push(userMsg);
    opts.onMessage(userMsg);
  }

  // The gates and minimal must match what buildRoundZeroPrefix passes, or the warm prefix
  // diverges from round 0. A subagent is never warmed, so its report frame can't cause that drift.
  const promptForMode = buildSystemPrompt({
    bundle: opts.bundle,
    mode: opts.promptMode,
    minimal: opts.minimalPrompt,
    grind: opts.grindPrompt,
    ...promptGates(opts.tools, opts.config.sandbox, opts.config.unattended),
  });
  const baseSystem = opts.reportAtCap
    ? `${promptForMode}\n\n${SUBAGENT_REPORT_FRAME}`
    : promptForMode;
  // In plan mode the system is recomputed each round with a fresh, pinned exploration ledger
  // (never enters history, so compaction can't evict it). Other modes leave this untouched.
  let system = baseSystem;
  const turnStart = Date.now();
  // What the model can be pointed at this turn — see ToolContext.toolNames.
  const toolNames: ReadonlySet<string> = new Set(opts.tools.map(t => t.name));
  // One budget per user turn — caps total search + fetch calls across all
  // internal model→tool rounds. Subagent calls get their own budget.
  const webBudget: WebBudget = {
    searches: { used: 0, max: opts.config.maxSearchesPerTurn },
    fetches: { used: 0, max: opts.config.maxFetchesPerTurn },
  };
  // Subagent budget this turn — the ToolContext is rebuilt per call, so it lives here. `rounds` is
  // the decision count (rounds that dispatched a subagent), `inRound` the width of the current one.
  const subagentCalls: SubagentBudget = { rounds: 0, inRound: 0 };
  // Pressure affordance (#343) offered this turn — once is the signal; repeating it is noise.
  let subagentAffordanceOffered = false;
  // Latched when a search fails for a reason that is a property of the provider rather than the
  // query (no browser, bot check, every engine refused), or when a fetch finds the network down
  // (#392). Per-turn like webBudget: the next turn may well find the block cleared or the wifi
  // back, so it is never carried across one.
  const webHealth: WebHealth = {};
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
  // Questions put to the user this turn (tools/ask.ts). Per-turn like resolvedDeps, and the ask tool
  // reads it to enforce its one-per-turn cap.
  const askedQuestions: string[] = [];
  // Q&A pairs the user has settled this turn. Recorded HERE rather than inside the tool because the
  // answer has to outlive its own tool result: that result ages out under compaction, and a model
  // that loses the answer re-derives the question it was stuck on — which is the spiral the tool was
  // added to end (#198). The ledger below re-pins it into the regenerated suffix every round.
  const questionAnswers: { question: string; answer: string }[] = [];
  const requestQuestion = opts.requestQuestion
    ? async (req: QuestionRequest): Promise<QuestionAnswer | null> => {
        const answered = await opts.requestQuestion!(req);
        if (answered) {
          questionAnswers.push({
            question: req.question,
            answer: answered.notes ? `${answered.text} — ${answered.notes}` : answered.text,
          });
        }
        return answered;
      }
    : undefined;
  // Session-cumulative shrink counts, carried in from previous turns and advanced by every shed
  // and fold this turn performs. Every fold is announced (a fold is what the model can lose the
  // task to — #251/#252/#275 — so a second one in the same turn is not less worth seeing than the
  // first); the ordinal in the notice is session-wide so a transcript reads "fold 3" where a
  // per-turn count would have restarted.
  const shrink: ShrinkCounts = { ...(opts.priorShrink ?? { sheds: 0, folds: 0 }) };
  // Consecutive length-stops recovered from. Reset on any clean (non-truncated) round so
  // the budget is per-spiral, not per-turn.
  let lengthRetries = 0;
  // Truncation continuation (#284). `continuation` bounds *unproductive* continuing (a consecutive
  // count that resets on progress, plus a novelty check); the pending accumulators below hold a
  // truncated round's work so the split thought is recorded in the reasoning trace as ONE entry
  // when the continuation lands. Recording it as two would report the continuation as near-identical to the
  // round it resumes — high crossSim by construction — and trip the Layer-2 loop-breaker on the very
  // feature it is meant to protect. See agent/continuation.ts.
  const continuation = new ContinuationGate();
  // The block that comes BACK to the model, in the order it was generated (reasoning, then content
  // when the round produced any). `pendingReasoning` is the reasoning-only accumulation of the same
  // split thought, kept apart because the trace takes the two channels separately and picks one:
  // folding content into the string it judges would feed it the same text twice and shift which
  // channel Layer-2 measures.
  let pendingContinuation = '';
  let pendingReasoning = '';
  // A plan-write draft cut on length and carried forward. Kept out of opts.history on purpose: the
  // write round's request is one synthetic message rebuilt from history, so a tail pushed there would
  // land in "Your analysis" and change that message — a full re-prefill — where appending it after
  // the unchanged message keeps the next request append-only. Its own ladder: the write round never
  // makes progress until it lands, so it must not share a budget exploration can reset.
  let planWriteCarried = '';
  const planWriteContinuation = new ContinuationGate();
  // Carry a cut-off block forward: the trimmed tail rides in `content` (a Qwen-family template
  // renders prior-turn `reasoning_content` as nothing, which is why the old retry lost the work even
  // though the partial was in history), followed by the resume nudge as role 'user' — the only role
  // that reaches the model, since messagesToChatParams drops system messages. Reasoning is deliberately
  // NOT set alongside the tail: sending both channels would pay for the same text twice and make the
  // retention bound fiction. Shared by both cut paths so they cannot drift apart. Returns the chars
  // trimmed, for the user-facing notice.
  const carryContinuation = (block: {
    // The cut-off thought so far, chronological — what the tail is cut from.
    carried: string;
    // The same thought's reasoning channel only, for the trace when the continuation lands.
    reasoning: string;
    // THIS round's newly generated text, for the ladder's novelty check. Never the carried block:
    // a tail contains the round it resumes, so accumulated-vs-accumulated self-triggers.
    newText: string;
  }): number => {
    continuation.noteContinuation(block.newText);
    // Successive tails DO overlap — each cuts a fresh window over the same block, so a short
    // continuation round leaves two near-identical tails resident until a shrink event clears them.
    // Shedding the older one here was tried and reverted (measured 2026-09-10, REIKA_CONTINUE_MAX=3,
    // 3 consecutive carries): rewriting a mid-history assistant message turned an append-only round
    // into `cause=mid-history`, costing 1785 and 2358 tokens of reprocessing (83s and 106s at 21tok/s)
    // against a comparable append-only round's 67 — to reclaim ~1375 tokens of window that was not
    // under pressure. Compaction's pre-pass is the right home precisely because it only runs when a
    // shrink is already rewriting those bytes, so the divergence is free; and it is ordered ahead of
    // both size sweeps, so the tails go first exactly when window IS the binding constraint.
    pendingContinuation = block.carried;
    pendingReasoning = block.reasoning;
    const tail = continuationTail(block.carried);
    opts.history.push({ role: 'assistant', content: tail.text, continuationTail: true });
    // `harness`: the nudge must reach the model, so it cannot be `meta` — but it is not a turn
    // boundary, and the task-spec pin elects the first tool payload after the newest real user
    // message. Without this, every continuation re-elects the spec to whatever result lands next.
    opts.history.push({ role: 'user', content: CONTINUE_NUDGE, harness: true });
    return tail.omitted;
  };
  // Consecutive plan-mode rounds that surfaced no new information (seenReadOnly didn't grow). Drives
  // the adaptive force-write: a converged or looping model stalls here; a productive one resets it.
  let planStaleRounds = 0;
  // Plan-mode convergence pressure (agent/planpressure.ts): the turn's peak fill (see planFill).
  let planFillPeak: number | undefined;
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
  // The harness ending exploration is a decision the user must see: without a line saying why, the
  // first sign of it was a recovery notice on the write round, which read as the model spiraling.
  let planForceWriteAnnounced = false;
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
  const seenReadOnly = new Map<string, RepeatEntry>();
  // Web lookups (query / URL) that returned content this turn. Kept apart from seenReadOnly so the
  // repeat nudge stays off the web tools; only plan mode's novelty watermark reads it (#290), or a
  // docs-only exploration counts as a stall and force-writes before any code is read.
  const seenWebLookups = new Set<string>();
  // REIKA_DEBUG-only instrumentation: classifies each read as unique / changed / narrowed /
  // dup-live / dup-aged so a run reveals whether re-reads are redundant loops, rational refetches
  // of aged-out content, or a model shrinking its window to get around an omitted payload.
  // Model-invisible — only the debug log reads it. See agent/readtrace.ts.
  const readTrace = new ReadTrace();
  // Read-first gate state (#72): per-turn path grounding — reads and successful edits/writes ground
  // a path; the first blind edit to an ungrounded path is bounced once with a read directive.
  // Recorded unconditionally (cheap); only READ_FIRST (default on) lets it withhold anything.
  const readFirst = new ReadFirstGate(opts.bundle.cwd);
  // Cross-round reasoning-loop detector (Layer 2). Records each round's reasoning to spot the model
  // re-deriving the same analysis instead of converging. Always recorded (cheap, and the debug
  // diagnostic reads it); its verdict only drives a force-commit when REASONING_LOOP_BREAK is set.
  // See agent/reasoningtrace.ts.
  const reasoningTrace = new ReasoningTrace();
  // Whether the detector currently sees a sustained reasoning loop. Set after each round's model
  // call (from round i-1's reasoning); read at the top of round i to decide the force-commit.
  let reasoningLoopActive = false;
  // Which channel that verdict was drawn from (see ReasoningTrace's channel fallback). Hoisted for
  // the same reason as the flag above — the logit-recovery sites read round i-1's value — and read
  // ONLY to exempt the content channel from logit bias. See biasableShingles.
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
  // The caller's session-long trace when it has one (App/headless), so the turn boundary is
  // measured too; a subagent gets its own, so concurrent turns don't cross-contaminate.
  const prefixTrace = opts.prefixTrace ?? new PrefixTrace();
  // What that divergence costs (issue #195). Prefill is ~80% of wall clock on a slow local endpoint,
  // so the cache line is only actionable annotated with the tokens it reprocessed and the seconds
  // that buys. The rate is learned from observed TTFT the way `calibration` is learned from the
  // provider's reported prompt tokens. See agent/prefillcost.ts.
  const prefillRate = new PrefillRate(opts.priorPrefillRate);
  // How fast the model actually decodes, for the status bar (#204). Same learned-and-threaded shape
  // as prefillRate, but this one is displayed rather than logged, and decode-only for that reason.
  // See agent/decoderate.ts.
  const decodeThroughput = new DecodeRate(opts.priorDecodeRate);
  // The reserve every budget in this turn reads (#551): learned from finished rounds unless
  // REIKA_MIN_GEN_TOKENS pins it, and re-read at each use so a long turn adapts within itself —
  // a long single turn is exactly where folds happen. See agent/genreserve.ts.
  const genReserve = opts.genReserve ?? new GenReserve();
  const minGen = (): number => resolveGenReserve(opts.config, genReserve).tokens;
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
    // Native images carry no characters for estimateRequestTokens to count, so they are charged
    // here — the one point every estimate in the turn passes through, which is what gets them into
    // the max_tokens backstop and the fit-to-window cap. See NATIVE_IMAGE_TOKEN_ALLOWANCE.
    (opts.nativeImages?.length ?? 0) * NATIVE_IMAGE_TOKEN_ALLOWANCE +
    estimateRequestTokens(system, hist, tls, {
      contextWindow: window,
      calibration,
      reasoningRounds: opts.config.reasoningRounds,
      minGenTokens: minGen(),
      prefixStable,
      latches: latchesFor(opts.config),
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

  // REIKA_TYPECHECK=0 (Config.typecheck, default on) disables the whole post-edit gate: no
  // baseline at the first mutating call, no final re-check, no done-gate send-backs. One local
  // boolean because the gate runs at two sites (the baseline capture below in the dispatch loop,
  // the done-gate above in the isFinal branch), and `undefined` (a hand-built test Config
  // predating the knob) stays on — the same fail-default shape as Config.autosave. Everything
  // else about the gate is unchanged: non-TS projects still fail open, and tsc never runs for a
  // project without a tsconfig even when the flag is on.
  const typecheckEnabled = opts.config.typecheck !== false;

  // EXPERIMENT (plan→agent handoff): one-shot pre-pass before the round loop. Folds the plan-mode
  // exploration that produced the plan into a compact digest so the executing agent sees the plan
  // verbatim plus findings, not the full transcript. Operates on the per-turn opts.history copy
  // (UI scrollback untouched), recomputed deterministically each turn; a cheap no-op without a
  // plan-final marker (every ordinary agent turn) and idempotent on re-runs. Runs before the
  // in-loop shouldCompact so that compaction sees the already-shrunk history.
  if (PLAN_HANDOFF_DISTILL && opts.promptMode === 'agent') {
    const { folded, reason } = distillPlanHandoff(opts.history, window, calibration, minGen());
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

  // Plan refinement (#46): a plan-mode turn that follows a plan already written revises that plan
  // instead of deriving a new one from the request. Resolved ONCE, here, from the history the turn
  // STARTS with — a turn's own plan is only written at its end, and the messages this turn adds are
  // themselves enough to stop the derivation from recognizing the refinement later (refineTarget
  // asks that only plan-mode turns follow the plan). It feeds two places: the plan ledger
  // (every round, so the model is told to revise rather than re-derive) and the force-write
  // transform, which REPLACES the history and would otherwise rebuild the plan from the original
  // request alone. Gated on `allowRefine`: vibe's plan phase passes false (a new task even when a
  // plan sits right above — see the option), so it reads as a fresh planning pass. Everywhere else
  // it is undefined, i.e. "derive it" — which is what a caller building a round-0 prefix out of a
  // pre-turn history (the warm) should do.
  const refinePlan: PlanMarker | null =
    opts.promptMode === 'plan' && opts.allowRefine !== false ? refineTarget(opts.history) : null;

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
    const planCeiling =
      opts.promptMode === 'plan'
        ? planRoundCeiling({
            transformBudgetChars: window ? planTransformBudgetChars(window) : undefined,
            gatheredChars: planGatheredChars(opts.history),
          })
        : 0;
    const planForceWrite =
      opts.promptMode === 'plan' &&
      (planStaleRounds >= PLAN_STALL_ROUNDS ||
        i >= planCeiling ||
        (REASONING_LOOP_BREAK && reasoningLoopActive) ||
        forceVerbatimPlanWrite);
    let planPressure: PlanPressure = 'none';
    let planPressureBasis: { fillPercent?: number; round: number } = { round: i };
    if (opts.promptMode === 'plan') {
      // This round's request, measured the way the compaction decision measures it — `system` still
      // holds last round's ledger, a few dozen tokens off. The last request's usage lags a whole
      // round of reads, which on a 24k window is 25–30% of the room (it read 76% for a 97% request).
      // Round 0 stays unmeasured, as the warm prefix (buildRoundZeroPrefix) cannot measure it.
      if (window && i > 0) {
        const promptTokens = rawEstimate() * Math.max(calibration, COMPACTION_CALIBRATION_FLOOR);
        const fill = planFill(promptTokens, window, minGen());
        planFillPeak = Math.max(planFillPeak ?? 0, fill);
      }
      const ceiling = planCeiling;
      planPressure = planPressureFor({
        round: i,
        examined: planExamined(opts.history),
        contextWindow: window,
        fill: planFillPeak,
        ceiling,
      });
      const fill = planFillPeak;
      // Pressure raised by the approaching ceiling names rounds, not fill: "the context is 7% full
      // and you very likely have enough" states a fact that argues the other way.
      const byCeiling = planPressure !== 'none' && ceilingPressure(i, ceiling) === planPressure;
      planPressureBasis = {
        round: i,
        fillPercent: fill !== undefined && !byCeiling ? Math.round(fill * 100) : undefined,
      };
      debugLog(
        `[reika:debug] round=${i} plan-pressure=${planPressure} ` +
          `fill=${fill !== undefined ? fill.toFixed(2) : 'n/a'} ` +
          `basis=${window && !byCeiling ? 'fill' : 'rounds'} ceiling=${ceiling}\n`,
      );
    }
    // Subagent bounded return: the last budgeted round is the report round. Same mechanics as the
    // plan force-write (no tools offered, in-band calls dropped) without the transform — the model
    // reports from its own history, aged payloads and all, because partial and grounded is the
    // point. Never in the parent turn (reportAtCap is only set by makeSpawnSubagent).
    const subagentForceReport = !!opts.reportAtCap && i === opts.config.maxTurns - 1;
    if (subagentForceReport) {
      debugLog(`[reika:debug] round=${i} subagent-force-report cap=${opts.config.maxTurns}\n`);
    }
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
        // No dropped-payload notice here, deliberately: the force-write prompt's whole job is
        // "stop calling tools and write the plan from what you have", and the notice ends with
        // "re-run that call" — handing the model a contradiction on the one round it must not
        // explore. Dropped output is a reason the plan may be thin, not a reason to reopen the
        // exploration the force-write exists to end.
        system = buildPlanWritePrompt(steerRetryActive, refinePlan !== null);
        // A verbatim abort already announced itself; every other trigger is silent otherwise.
        if (!planForceWriteAnnounced && !forceVerbatimPlanWrite) {
          planForceWriteAnnounced = true;
          const looping = REASONING_LOOP_BREAK && reasoningLoopActive;
          opts.onMessage({
            role: 'system',
            tone: looping ? 'warn' : 'info',
            content: looping
              ? 'Reasoning was going in circles — writing the plan from what was gathered.'
              : planStaleRounds >= PLAN_STALL_ROUNDS
                ? 'Exploration stopped turning up anything new — writing the plan from what was gathered.'
                : `Explored for ${i} rounds — writing the plan from what was gathered.`,
          });
        }
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
              emphasis: 'lead',
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
        // The dropped-payload notice leads, same as buildSteadySystem's plan branch: aging hits
        // exploration exactly as it hits an agent turn, and this path is the only one a
        // prefix-stable plan run takes.
        system = baseSystem;
        roundSuffix = [
          droppedPayloadLedgerFor(opts.history, prefixStable),
          buildQuestionLedger(questionAnswers),
          buildPlanLedger(opts.history, planPressure, planPressureBasis, refinePlan),
        ]
          .filter(Boolean)
          .join('\n\n')
          .trimStart();
      } else {
        system =
          buildSteadySystem({
            baseSystem,
            promptMode: 'plan',
            history: opts.history,
            round: i,
            planSteps: null,
            planPressure,
            planFillPercent: planPressureBasis.fillPercent,
            refine: refinePlan,
          }) + prefixed(buildQuestionLedger(questionAnswers));
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
            emphasis: 'lead',
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
              emphasis: 'lead',
              content: `Recovering: nudging the model off a reasoning loop (one biased round before stopping).`,
            });
            opts.onRecovering?.(true); // live pulse for this one round; cleared after the call returns
            // fall through: don't stop — the biased round runs below with the loop ledger still set.
          } else {
            debugLog(`[reika:debug] round=${i} logit-recovery unavailable — stopping\n`);
            commitAgentLoopStop(opts, turnStart, fetchedUrls, editingStarted);
            return;
          }
        } else {
          debugLog(
            `[reika:debug] round=${i} agent-loop-stop loopActiveRounds=${loopActiveRounds} ` +
              `edited=${editingStarted}\n`,
          );
          commitAgentLoopStop(opts, turnStart, fetchedUrls, editingStarted);
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
      // First: this is settled context, not a directive, and the directives below are ordered by how
      // close to generation they need to sit. Order must match buildSteadySystem's composition or
      // the warm prefix diverges from round 0 (warm.test.ts locks the two).
      const droppedLedger = droppedPayloadLedgerFor(opts.history, prefixStable);
      if (droppedLedger) suffixParts.push(droppedLedger);
      const answered = buildQuestionLedger(questionAnswers);
      if (answered) suffixParts.push(answered);
      if (PLAN_ALIGN && planSteps && planSteps.some(s => !s.done)) {
        suffixParts.push(buildPlanProgressLedger(planSteps));
      }
      // The grounded edit-recovery directive is more specific and actionable than the generic loop
      // ledger, so it replaces it for the one round it fires.
      if (editRecoveryGrounding) {
        suffixParts.push(buildEditRecoveryLedger(editRecoveryGrounding));
      } else if (loopDetected) {
        suffixParts.push(buildAgentLoopLedger(looping, withdrawInspection, toolNames));
      }
      // Last, so the strongest directive sits closest to generation. (Composed here rather than
      // `system +=` in the terminal branch above, which this composition used to overwrite — the
      // steer previously never reached a request; #83.)
      if (convergeSteerNow) suffixParts.push(buildConvergeSteer());
      // Last of all on a subagent's report round: it must win over every ledger above it, all of
      // which say some form of "keep working" — the one round the model must not.
      if (subagentForceReport) suffixParts.push(SUBAGENT_REPORT_DIRECTIVE);
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
    // The subagent's report round keeps the list and forbids calls with `tool_choice` instead
    // (#426): the template renders the tool list into the system turn, so withholding it would
    // re-prefill the subagent's whole context on its last round.
    const callTools = planForceWrite
      ? []
      : withdrawInspection
        ? opts.tools.filter(t => !INSPECTION_TOOLS.has(t.name))
        : opts.tools;
    const planTransformBudget = window ? planTransformBudgetChars(window) : Number.MAX_SAFE_INTEGER;
    const callHistory = planForceWrite
      ? [
          {
            role: 'user',
            content:
              buildPlanTransformInput(
                opts.history,
                planTransformBudget,
                planForceWriteLoopTriggered,
                refinePlan,
              ) + nativeImageReminder(opts.nativeImages),
          } as Message,
          ...(planWriteCarried
            ? ([
                { role: 'assistant', content: continuationTail(planWriteCarried).text },
                { role: 'user', content: PLAN_WRITE_CONTINUE_NUDGE, harness: true },
              ] as Message[])
            : []),
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
          `threshold=${window ? Math.round(compactThreshold(window, minGen())) : 'n/a'} ` +
          `willCompact=${window ? shouldCompact(e * compactCalibration, window, minGen()) : false} ` +
          `sys≈${Math.round(system.length / 4)}t reasoning≈${Math.round(rsnChars / 4)}t ` +
          `summaries≈${Math.round(sumChars / 4)}t payloads≈${Math.round(payChars / 4)}t ` +
          `reasoningRounds=${opts.config.reasoningRounds}\n`,
      );
      // Task-spec pin (#227), on its own line so a suspicion about a confabulated task can be
      // checked by grep instead of re-derived. `holding`: the pin only does work once the spec
      // falls outside the trailing tool block, which is where aging would otherwise have taken it.
      // `stale`: the pin predates the current user message — the deliberate carry-over that keeps
      // round 0 append-only for the warm prefix (see taskSpecIndex), which costs up to
      // TASK_SPEC_PIN_CHARS of the PREVIOUS task's detail until this turn lands its own first tool
      // result. Bounded and self-correcting, but it is the one behaviour here that could read as
      // task conflation, so it is greppable rather than something to re-derive from the history.
      const specIdx = taskSpecIndex(opts.history);
      const spec = specIdx >= 0 ? opts.history[specIdx] : undefined;
      debugLog(
        specIdx >= 0 && spec?.role === 'tool'
          ? `[reika:debug] round=${i} spec-pin idx=${specIdx} chars=${spec.payload?.length ?? 0} ` +
              `holding=${specIdx < findFreshToolBlockStart(opts.history)} ` +
              `stale=${specIdx < lastUserMessageIndex(opts.history)} ` +
              `summary=${JSON.stringify(spec.summary.slice(0, 60))}\n`
          : `[reika:debug] round=${i} spec-pin none\n`,
      );
      // Dropped-payload ledger (#227). Read off the COMPOSED request — the notice reaches the model
      // through the system block or the trailing note depending on mode and REIKA_PREFIX_STABLE,
      // and this block runs after both are final — so `active` is what actually shipped, not a
      // re-run of the gate. Without it an unmoved dup-aged number is ambiguous: "the notice didn't
      // help" and "the notice never fired" look identical in the log.
      const ledgerActive =
        system.includes(DROPPED_LEDGER_MARKER) || !!roundSuffix?.includes(DROPPED_LEDGER_MARKER);
      debugLog(
        `[reika:debug] round=${i} dropped-ledger active=${ledgerActive} ` +
          `payloads=${droppedPayloadCount(opts.history, prefixStable)} ` +
          `via=${system.includes(DROPPED_LEDGER_MARKER) ? 'system' : ledgerActive ? 'tail' : 'none'}\n`,
      );
    }
    // EXPERIMENT (#280): the report round. One extra model call, calls forbidden, asking for a
    // compaction note; the fold below then carries the note as the recap's body instead of the
    // read ledger (see compactionreport.ts for the measurement behind it). Its own request, not
    // this round's — the note is captured and the round's real call proceeds after the fold, so
    // the note-writing reasoning never enters history. Agent mode only for now (plan mode has its
    // own force-write and transform; keep the blast radius to one path). Streams into the live
    // region like any reply so the user sees the note being written; committed as an info notice
    // so it reads as a harness event, not an answer. Fail-open: an empty or aborted reply folds
    // exactly as before.
    //
    // Written BEFORE the batch-age shed below (#426): the shed rewrites mid-history, and when the
    // note request came after it, that request paid the shed's invalidation and the real request
    // paid the fold's — two full re-prefills in one event (measured: 9k + 9.3k tokens, 416s + 431s
    // on a 24k window). Here the note request is a pure append on the previous round, and the
    // shed and fold land together on the real request. It is also written from the live bytes the
    // shed is about to collapse, which is what a findings note is for.
    //
    // Gated on the fold actually removing something: under PREFIX_STABLE the shed often gets the
    // request under the threshold on its own and the fold then keeps everything — a note written
    // there has no recap to live in and is thrown away (observed twice in one run). Pre-shed that
    // is `foldAfterShed`, the same decision replayed on a copy; off prefix-stable there is no shed
    // and `wouldFold` on the history is the decision itself.
    let note: CompactionNote | undefined;
    // /compact (issue #481) reuses this exact gate on a manual trigger: the note round runs whenever
    // a fold would, regardless of where the estimate sits — `shouldCompact` and foldAfterShed's
    // watermark half are both pressure checks, exactly what a manual trigger bypasses. Plan mode
    // stays excluded either way: its force-write/transform owns the compaction interaction there,
    // and a manual note round would interleave with it; in plan mode /compact folds without a note
    // (fold gate below), which keeps the fold still useful and the blast radius on that path zero.
    const manualRound = !!opts.manualCompact;
    // REIKA_COMPACTION_REPORT=0 is the ledger-only baseline arm; /compact honors it too, and then
    // folds without a note exactly as an automatic fold would.
    const reportEnabled = compactionReportEnabled();
    const autoReport =
      !manualRound &&
      reportEnabled &&
      !!window &&
      !planForceWrite &&
      opts.promptMode !== 'plan' &&
      !opts.signal?.aborted &&
      shouldCompact(rawEstimate() * compactCalibration, window, minGen());
    if (
      ((manualRound && reportEnabled) || autoReport) &&
      !!window &&
      !planForceWrite &&
      opts.promptMode !== 'plan' &&
      !opts.signal?.aborted &&
      (prefixStable
        ? foldAfterShed(
            opts.history,
            h => rawEstimate(h) * compactCalibration,
            window,
            compactCalibration,
            minGen(),
            !latchesFor(opts.config).reasoningRoundtrip,
            // The manual trigger's only question is "would the fold remove anything" (#481).
            !manualRound,
          )
        : wouldFold(opts.history, window, compactCalibration, minGen()))
    ) {
      const n = shrink.folds + 1;
      const directive = buildCompactionReportDirective(n);
      // Notice first, so the barred note block that follows reads as a deliberate side
      // conversation; the fold notice below closes it.
      opts.onMessage({
        role: 'system',
        tone: 'info',
        emphasis: 'line',
        content: manualRound
          ? `/compact — asking the model for a compaction note before fold ${n}.`
          : `Context is near the window — asking the model for a compaction note before fold ${n}.`,
      });
      opts.onPhase?.('thinking');
      opts.onCompactionNote?.(true);
      // A manual round runs at a turn boundary, where the history ends on the previous turn's final
      // assistant reply. With the directive only in the system prompt, that request would end on an
      // assistant turn — a prefill llama.cpp continues, and one strict upstreams reject — so off
      // prefix-stable the manual directive rides the trailing user note too.
      const directiveAsTail = prefixStable || manualRound;
      // /compact has no user turn behind it, so an "(aborted)" assistant reply would be an answer to
      // nothing in the history; the user gets a receipt that the fold did not happen instead.
      const commitNoteRoundAbort = () => {
        if (!manualRound) {
          commitAborted(opts, '', undefined, turnStart, fetchedUrls);
          return;
        }
        opts.onMessage({
          role: 'system',
          tone: 'info',
          content: '/compact cancelled — nothing was folded.',
        });
      };
      try {
        const report = (suffix: string) =>
          callModel({
            system: prefixStable ? baseSystem : directiveAsTail ? system : system + '\n\n' + suffix,
            history: opts.history,
            // The same tools the round would send, with calls forbidden by `tool_choice` (#426).
            // Sending none rendered a different system turn: on the measured 24k runs the note
            // round re-prefilled the entire request (~7–11k tokens) immediately before the fold
            // re-prefilled it again — two full prefills per fold, one of them for nothing.
            tools: callTools,
            toolChoice: 'none',
            config: withGenReserve(opts.config, genReserve),
            onContentDelta: opts.onContentDelta,
            onReasoningDelta: opts.onReasoningDelta,
            signal: opts.signal,
            calibration,
            maxTokens: computeMaxTokens({
              contextWindow: window,
              promptTokens: Math.round(rawEstimate() * calibration),
              userMaxTokens: opts.config.maxTokens,
              modelMaxOutput: opts.config.maxOutputTokens,
            }),
            prefixStable,
            // Do not freeze this round's fresh payloads at the note request's render. Pre-shed the
            // fit-to-window cap has the least room it will have all event, so the bytes stamped
            // here would be the most truncated ones — and the real request after the fold would
            // reuse them. Left unstamped, the real request renders them with the post-fold room
            // and stamps those. Free for the cache: the fold (or the shed, if no fold) already
            // diverges the real request before the fresh block, so the differing bytes cost nothing
            // they were not paying.
            stampRenders: false,
            // The note round reads the same history as any other round, so it sees the same image:
            // withholding it would have the model write a handoff about a screenshot it can't see.
            nativeImages: opts.nativeImages,
            trailingNote: prefixStable
              ? roundSuffix
                ? `${roundSuffix}\n\n${suffix}`
                : suffix
              : directiveAsTail
                ? suffix
                : undefined,
            // The note round is a request like any other, so it gets its own prefix-cache line:
            // before #426 it was the one request the trace never saw, and the fold's line that
            // followed compared against the round before it.
            onRequest: debugEnabled()
              ? msgs => {
                  const d = prefixTrace.record(msgs, {
                    trailingNote: directiveAsTail,
                    tools: toolsToChatTools(callTools),
                  });
                  const pct =
                    d.totalChars > 0 ? Math.round((d.stableChars / d.totalChars) * 100) : 100;
                  const tok = reprocessedTokens(
                    d,
                    Math.round(rawEstimate(opts.history, callTools) * calibration),
                  );
                  debugLog(
                    `[reika:debug] prefix-cache round=${i} phase=report cause=${d.cause} ` +
                      `stable=${d.stableChars}/${d.totalChars}c (${pct}%) ` +
                      `msgs=${d.stableMessages}/${d.totalMessages}` +
                      (d.changedRole ? ` firstChanged=${d.changedRole}` : '') +
                      ` ${formatPrefillCost(tok, prefillRate.get(), false)}\n`,
                  );
                }
              : undefined,
          });
        let rep = await report(directive);
        if (rep.usage) opts.onUsage?.(rep.usage);
        // callModel returns what streamed before a ctrl-c rather than throwing, so an aborted note
        // is a cut-off fragment — never a note, and not a reason to fold.
        if (opts.signal?.aborted) {
          commitNoteRoundAbort();
          return;
        }
        // Diagnosable from the log: an empty content channel with a recovered in-band call is the
        // model trying to read instead of writing; a `length` stop is the budget.
        const describe = (r: typeof rep): string =>
          `finish=${r.finishReason ?? '?'} content=${r.content?.trim().length ?? 0}c ` +
          `reasoning=${r.reasoning?.trim().length ?? 0}c inband=${r.toolCalls?.length ?? 0}`;
        let retried = false;
        if (!rep.content?.trim() && !opts.signal?.aborted) {
          debugLog(
            `[reika:debug] round=${i} compaction-report n=${n} empty ${describe(rep)}; retrying\n`,
          );
          opts.onReasoningReset?.();
          retried = true;
          const again = await report(`${directive}\n\n${COMPACTION_REPORT_RETRY}`);
          if (again.usage) opts.onUsage?.(again.usage);
          if (opts.signal?.aborted) {
            commitNoteRoundAbort();
            return;
          }
          // Keep whichever reply has a note in the content channel; failing both, the first
          // reasoning is the better fallback (it is the longer, less nagged thinking).
          if (again.content?.trim()) rep = again;
        }
        const text = clampCompactionNote(rep.content?.trim() || rep.reasoning?.trim() || '');
        if (text) {
          note = { n, text };
          // UI only, never history: the note renders as markdown WITH its reasoning — the trace of
          // how the note was derived stays in the scrollback for the user, while the model's
          // history gets only the note (via the recap). compactionNote draws it as one barred block.
          opts.onMessage({
            role: 'assistant',
            content: text,
            reasoning: rep.reasoning?.trim() || undefined,
            compactionNote: true,
          } as Message);
        }
        debugLog(
          `[reika:debug] round=${i} compaction-report n=${n} chars=${text.length}` +
            `${rep.content?.trim() ? '' : rep.reasoning?.trim() ? ' src=reasoning' : ' src=empty'}` +
            `${retried ? ' retried=1' : ''} ${describe(rep)}\n`,
        );
      } catch (err) {
        if (opts.signal?.aborted) {
          commitNoteRoundAbort();
          return;
        }
        debugLog(`[reika:debug] round=${i} compaction-report failed err=${String(err)}\n`);
      } finally {
        opts.onCompactionNote?.(false);
        // The live region held the note; if the reply was empty no assistant commit cleared it,
        // so the UI is told explicitly before the round's real reply streams.
        opts.onReasoningReset?.();
      }
    }
    // Prefix-stable shrink event: payloads stay live (byte-frozen) across rounds, so shed them in
    // one oldest-first batch when the estimate crosses the same threshold compaction uses — and do
    // it immediately before the compaction check so the two rewrites land in the SAME request (one
    // amortized prefix-cache invalidation, not two on consecutive rounds).
    let agedThisRound = false;
    if (prefixStable && window && !planForceWrite) {
      const aged = batchAgePayloads(
        opts.history,
        // compactCalibration, not the raw learned factor: batch aging replaces the per-round
        // collapse as the shrink mechanism, so it must fire under the same floored trigger as
        // compaction — a low learned calibration deferring the shrink until overflow is exactly
        // what the floor exists to prevent.
        () => rawEstimate() * compactCalibration,
        window,
        minGen(),
        !latchesFor(opts.config).reasoningRoundtrip,
      );
      agedThisRound = aged.marked > 0;
      if (aged.marked > 0) {
        // bulk/crumbs/kept is the #257 sweep split: `kept` counts small payloads the size floor
        // spared, so a run can say whether the floor engaged at all rather than leaving "never
        // fired" and "fired and didn't help" looking identical. `short` is the tokens still over
        // the watermark when the sweeps ran dry — the number that says whether the fold this event
        // is about to trigger was avoidable.
        debugLog(
          `[reika:debug] round=${i} prefix-stable batch-age marked=${aged.marked} ` +
            `bulk=${aged.bulk} crumbs=${aged.crumbs} kept=${aged.kept} short=${aged.short}\n`,
        );
        shrink.sheds++;
        opts.onShrink?.({ kind: 'age', round: i, ...aged }, { ...shrink });
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
      rawEstimate() * compactCalibration > compactThreshold(window, minGen()) * AGE_LOW_FRACTION;
    // Force-write sends the tiny synthetic context, not opts.history, so there is nothing to
    // compact — skip it. Otherwise collapse the oldest turns if the estimate crosses the threshold.
    // /compact folds even under the threshold: it is a user request, and `compactHistory` degrades
    // safely to `removed = 0` when the keep budget still holds everything.
    let lastFoldRemoved = 0;
    if (
      !planForceWrite &&
      window &&
      (manualRound ||
        shouldCompact(rawEstimate() * compactCalibration, window, minGen()) ||
        agedButAboveWatermark)
    ) {
      const removed = compactHistory(opts.history, window, compactCalibration, minGen(), note);
      lastFoldRemoved = removed;
      // #247: log the recap TEXT, not just the count. A fold's recap is never persisted anywhere —
      // it is spliced into the model history per turn, while the saved transcript is written from
      // the UI scrollback, so no recap that reached a model has ever been readable afterwards. That
      // makes "the model got confused after a fold" impossible to check against the recap that
      // caused it, and would make any improvement to buildRecap unmeasurable. Line-prefixed rather
      // than a raw block so it stays greppable and can't be mistaken for other debug lines:
      //   grep 'compaction-recap' log | sed 's/.*| //'
      const recap = removed > 0 ? opts.history.find(m => m.role === 'compaction') : undefined;
      debugLog(
        `[reika:debug] round=${i} compaction removed=${removed}` +
          (recap ? ` recap=${recap.content.length}c` : '') +
          `\n`,
      );
      if (recap) {
        for (const line of recap.content.split('\n')) {
          debugLog(`[reika:debug] compaction-recap round=${i} | ${line}\n`);
        }
      }
      if (removed > 0) {
        shrink.folds++;
        const recapChars = recap?.content.length ?? 0;
        opts.onShrink?.({ kind: 'fold', round: i, removed, recapChars }, { ...shrink });
        // The recap size is in the notice because stacked recaps are a known failure (#275: 4.1k
        // → 10.1k across folds) and this line is the only place outside the debug log it shows.
        opts.onMessage({
          role: 'system',
          tone: 'info',
          emphasis: 'line',
          content: `Context compacted (fold ${shrink.folds}) — folded ${removed} earlier message${
            removed === 1 ? '' : 's'
          } into a ${(recapChars / 1000).toFixed(1)}k-char recap (older tool output still re-readable).`,
        });
      }
    }
    // /compact ends the turn here (issue #481): no reply round follows the fold, so the note request
    // is the only model call and the fold's rewrite is what the next turn appends onto. A no-fold
    // outcome says so honestly rather than silently doing nothing — that line is how the user tells
    // "nothing fell outside the keep budget" apart from "the command didn't reach the loop".
    if (opts.manualCompact) {
      if (lastFoldRemoved === 0) {
        opts.onMessage({
          role: 'system',
          tone: 'info',
          content: !window
            ? 'Nothing to compact — no context window is known for this model, so there is no keep budget to fold against.'
            : agedThisRound
              ? // "Nothing changed" would be a lie here: the age event above just summarized older
                // tool output in this same pass.
                'Nothing to compact — the batch-age shed just summarized the older tool output, and everything left fits the keep budget, so a recap would fold nothing.'
              : 'Nothing to compact — the keep budget still holds the recent turns verbatim, so a recap would summarize nothing not already present.',
        });
      }
      // The gauge would otherwise keep the pre-fold fill until the next real turn (#481).
      opts.onContextEstimate?.(Math.round(rawEstimate() * calibration));
      return;
    }
    const sentEstimate = rawEstimate(callHistory, callTools);
    opts.onContextEstimate?.(Math.round(sentEstimate * calibration));
    // Live reasoning-spin hint (human-only): accumulate THIS round's reasoning and, debounced every
    // SPIN_DEBOUNCE chars, flag when it looks like it's spinning so the UI can prompt abort-or-wait.
    // Per-round state, reset here. Active when a UI listener is attached OR REIKA_DEBUG is on (so a
    // headless debug run still logs the signal + ratio for threshold tuning); otherwise it falls
    // through to the plain delta callback, zero-cost. Cleared after the call (block done).
    let roundReasoning = '';
    // Tokens this round's request could not reuse from the prompt cache, filled by the prefix-cache
    // hook below (REIKA_DEBUG-only, so 0 means "not measured" on a normal run). A turn's first
    // request has no baseline to diverge from — the count is a ceiling there, not a measurement, so
    // it may be reported but must not teach the rate.
    let roundReprocessTokens = 0;
    let roundReprocessBounded = false;
    let spinCheckedAt = 0;
    let spinning = false;
    let verbatimAborted = false;
    // Whether the cut was the pure length ceiling rather than the repetition ratio. The two are very
    // different events — see the continuation branch in the recovery below (#284).
    let verbatimAbortByLength = false;
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
            verbatimAbortByLength = tooLong && ratio < abortAt;
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
      config: withGenReserve(opts.config, genReserve),
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
        modelMaxOutput: opts.config.maxOutputTokens,
      }),
      // Set only on the one-shot Tier 2 logit-recovery round (see the rumination dead-end above);
      // undefined otherwise, so a normal turn's request is byte-identical to before.
      logitBias,
      prefixStable,
      trailingNote: roundSuffix,
      // Constant across the turn (see runTurn): every round re-carries the same bytes at the same
      // tail position, so the model keeps seeing the image it was shown without re-prefilling.
      nativeImages: opts.nativeImages,
      toolChoice: subagentForceReport ? 'none' : undefined,
      // Measurement only (issue #134), and only when something will read it: the debug log is the
      // sole consumer, so an un-logged run never pays the larger streaming payload.
      logprobs: ENTROPY_LOGPROBS && debugEnabled() ? ENTROPY_TOP_K : undefined,
      // Fit-to-window cap line (#253): what the cap did to the fresh tool payloads in THIS request.
      // The cap is sized from the room left after everything else, so aging-watermark changes show
      // up here as truncation of NEW output — the half of the retention trade that is otherwise
      // invisible. Silent when nothing fresh arrived, so quiet rounds add no noise.
      onCapStats: debugEnabled()
        ? c => {
            if (c.fresh === 0) return;
            debugLog(
              `[reika:debug] payload-cap round=${i} cap=${c.cap ?? 'none'} ` +
                `fresh=${c.fresh} truncated=${c.truncated} omitted=${c.omitted}c ` +
                `uncapped=${c.uncapped} starved=${c.starved}\n`,
            );
          }
        : undefined,
      // Eviction line (#260): what the aged half of the request actually serialized as — how many
      // payloads collapsed to a bare summary, how many kept a diff skeleton or a declaration
      // outline, and how many were small enough that keeping them whole cost less than the marker.
      // Silent when nothing is aged yet, so early rounds add no noise.
      onAgedStats: debugEnabled()
        ? a => {
            const total = a.summary + a.diff + a.outline + a.whole + a.report;
            if (total === 0) return;
            debugLog(
              `[reika:debug] aged-payload round=${i} aged=${total} summary=${a.summary} ` +
                `diff=${a.diff} outline=${a.outline} whole=${a.whole} report=${a.report}\n`,
            );
          }
        : undefined,
      // Prefix-divergence line (issue #69): where this request stopped matching the previous one,
      // and which mechanism class broke it. Measured on the exact serialized request.
      onRequest: debugEnabled()
        ? msgs => {
            // `trailingNote` lets the trace tell the note's own slot apart from real history
            // churn — without it every append reads as `mid-history firstChanged=assistant` (#253).
            const d = prefixTrace.record(msgs, {
              trailingNote: !!roundSuffix,
              tools: toolsToChatTools(callTools),
            });
            const pct = d.totalChars > 0 ? Math.round((d.stableChars / d.totalChars) * 100) : 100;
            roundReprocessTokens = reprocessedTokens(d, Math.round(sentEstimate * calibration));
            roundReprocessBounded = d.cause === 'first-request';
            debugLog(
              `[reika:debug] prefix-cache round=${i} cause=${d.cause} ` +
                `stable=${d.stableChars}/${d.totalChars}c (${pct}%) ` +
                `msgs=${d.stableMessages}/${d.totalMessages}` +
                (d.changedRole ? ` firstChanged=${d.changedRole}` : '') +
                ` ${formatPrefillCost(roundReprocessTokens, prefillRate.get(), roundReprocessBounded)}` +
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
    // Same idea one layer down: time-to-first-token is what those reprocessed tokens cost, so the
    // round that just paid teaches the rate the next round's line quotes. Only fires under
    // REIKA_DEBUG (roundReprocessTokens stays 0 otherwise), and rejects samples too small to
    // separate prefill from per-request overhead — see agent/prefillcost.ts.
    if (response.timing && roundReprocessTokens > 0 && !roundReprocessBounded) {
      const learned = prefillRate.observe(
        sampleTokens(response.usage, roundReprocessTokens),
        response.timing.ttftMs,
      );
      if (learned != null) opts.onPrefillRate?.(learned);
    }
    // What that round decoded at (#204, #536) — the status bar's tok/s chip. The facts come off the
    // response the engine just sent: an engine that reports its own decode stats (llama.cpp) has
    // them measured, everything else falls back to our `timing` split and the provider's `usage`
    // count. The debug line quotes the round's own sample, the value the chip actually shows, and
    // which of the two sources the sample came from — without that last field a reader cannot tell
    // a rate the engine measured from one we estimated, which is the whole question #536 raised.
    // `?` there pairs with `decode=?`: no sample carried this round. The smoothed value is a fold
    // over the session's accepted samples, which nothing else records. `get()` rather than the
    // observe result on purpose: a round too small to measure leaves the chip showing the last
    // rate, and the log has to say the same thing the chip does.
    const sample = decodeSample(response.usage, response.timing, response.engineTimings);
    const learned = decodeThroughput.observe(sample);
    if (learned != null) opts.onDecodeRate?.(learned);
    // A cut stream (verbatim abort, ctrl-c) is not a finished round, whatever it reports — except a
    // ceiling cut the ratio gate passed, which is demand the reserve should cover. No usage arrives
    // on a cut, so it is sized from the reasoning it produced, at the compaction floor's density.
    let completion =
      response.usage?.completionTokens != null ? `${response.usage.completionTokens}` : '?';
    if (!callAbort.signal.aborted) {
      genReserve.observe(response.usage?.completionTokens, response.finishReason);
    } else if (verbatimAbortByLength && !planForceWrite && !opts.signal?.aborted) {
      const cut = Math.round(
        estimateTokens(roundReasoning) * Math.max(calibration, COMPACTION_CALIBRATION_FLOOR),
      );
      genReserve.observeCeilingCut(cut);
      completion = `~${cut}`;
    }
    const reserve = resolveGenReserve(opts.config, genReserve);
    debugLog(
      `[reika:debug] round=${i} sentEstimate=${sentEstimate} ` +
        `usage.promptTokens=${response.usage?.promptTokens ?? 'MISSING'} ` +
        `completion=${completion} finishReason=${response.finishReason ?? '?'} ` +
        `decode=${formatRate(sample?.rate)} smoothed=${formatRate(decodeThroughput.get())} ` +
        `src=${sample?.source ?? '?'} reserve=${reserve.tokens} reserveSrc=${reserve.source}\n`,
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
      // Which stop ended a LENGTH cut's carry, when the block itself passed the ratio gate. The
      // recovery below is shared with the genuinely-degenerate path, and its wording asserts
      // repetition — true for a ratio abort, true for a novelty refusal (that IS a restatement),
      // and FALSE for a count refusal, where the model simply spent its continuations on a coherent
      // thought. Measured 0.063/0.036/0.025/0.000 against a 0.350 threshold across three baseline
      // runs (#285), while the message told the model, and the user, that it was repeating itself.
      let ladderStop: 'count' | 'novelty' | undefined;
      // A LENGTH-ceiling cut is not evidence of degeneration (#284). REASONING_HARD_CEIL fires on
      // length alone (`ratio >= abortAt || tooLong`), so a long but coherent thought crossing 32000
      // chars is discarded exactly like a spiral — and told "your reasoning was repeating the same
      // text", which at a ratio of 0.014 is simply false. The measured block stopped 1,730 chars
      // (5.4%) short of this ceiling, so which cut landed first was near-arbitrary; two cuts that
      // close cannot carry opposite semantics. Both therefore route through the same ratio gate. A
      // RATIO-triggered abort is untouched below — that one is the genuine degenerate case, and
      // re-feeding a spiral its own text is what makes it worse. Plan exploration rounds take the
      // same gate: they already carry a cut at the token wall, and discarding the ceiling cut forced
      // the plan write on a thought that was still working. The force-write round does not: its
      // tighter ceilings exist to catch a transform spiraling at a low ratio.
      // Only a CONVERGENCE write (ceiling, stall) carries: after a loop-triggered one the model just
      // spiraled, and a long transform from it is suspect at any ratio. Never the steered retry:
      // that is the last attempt, cheap-to-fail by design, and its ceiling cut is the stop.
      if (
        CONTINUE &&
        verbatimAbortByLength &&
        planForceWrite &&
        !planForceWriteLoopTriggered &&
        !steerRetryActive
      ) {
        const carried = planWriteCarried
          ? `${planWriteCarried}\n${roundReasoning}`
          : roundReasoning;
        const ratio = selfRepeatRatio(carried);
        const allow = planWriteContinuation.allow(roundReasoning);
        const carry = ratio < PLAN_WRITE_CARRY_MAX_RATIO && allow.ok;
        debugLog(
          `[reika:debug] continuation round=${i} cut=plan-write continue=${carry} ` +
            `ratio=${ratio.toFixed(3)} max=${PLAN_WRITE_CARRY_MAX_RATIO} allow=${allow.ok}` +
            `${allow.reason ? ` stop=${allow.reason}` : ''} spent=${planWriteContinuation.spent} ` +
            `chars=${carried.length}\n`,
        );
        if (ratio < PLAN_WRITE_CARRY_MAX_RATIO && !allow.ok) ladderStop = allow.reason;
        if (carry) {
          planWriteContinuation.noteContinuation(roundReasoning);
          planWriteCarried = carried;
          opts.onReasoningStatus?.(false);
          // Committed for the transcript, as on the exploration path: the live preview is hidden
          // above, and a carried draft that vanished from scrollback would read as discarded.
          opts.onMessage({ role: 'assistant', content: '', reasoning: roundReasoning });
          const { omitted } = continuationTail(carried);
          opts.onMessage({
            role: 'system',
            tone: 'warn',
            content: `Plan write hit the length ceiling — continuing from where it stopped${
              omitted > 0 ? ` (${omitted} chars of earlier reasoning trimmed)` : ''
            }.`,
          });
          continue;
        }
        // Not carried: whatever recovery follows starts the write over, so the draft goes with it.
        planWriteCarried = '';
      }
      if (CONTINUE && verbatimAbortByLength && !planForceWrite) {
        // Joined with anything already held: a ceiling cut can land on a round that is ITSELF a
        // continuation, and judging/carrying only the new half would drop the first one from both
        // the tail and the trace while leaving its message outside `protect` to be shed.
        const ceilCarried = pendingContinuation
          ? `${pendingContinuation}\n${roundReasoning}`
          : roundReasoning;
        const ceilReasoning = pendingReasoning
          ? `${pendingReasoning}\n${roundReasoning}`
          : roundReasoning;
        const gate = continuationGate(ceilCarried);
        const allow = continuation.allow(roundReasoning);
        debugLog(
          `[reika:debug] continuation round=${i} cut=ceil continue=${gate.continuable && allow.ok} ` +
            `ratio=${gate.ratio.toFixed(3)} threshold=${gate.threshold.toFixed(3)} ` +
            `allow=${allow.ok}${allow.reason ? ` stop=${allow.reason}` : ''} ` +
            `sim=${allow.sim.toFixed(2)} spent=${continuation.spent} ` +
            `chars=${ceilCarried.length}\n`,
        );
        // The ratio gate passed but the ladder refused: remember which, so the recovery below does
        // not diagnose repetition the ratio just said is not there.
        if (gate.continuable && !allow.ok) ladderStop = allow.reason;
        if (gate.continuable && allow.ok) {
          opts.onReasoningStatus?.(false);
          // Commit the block to scrollback before the notice, the same history/onMessage split the
          // token-wall path uses: the live preview is hidden by the line above, so without this the
          // reasoning the user watched stream — up to REASONING_HARD_CEIL of it, and CARRIED, not
          // discarded — would vanish from the transcript with only the notice left behind. Note
          // `onReasoningReset` is deliberately NOT called here; that belongs to the discard path
          // below, where the block is degenerate and must not be committed.
          if (roundReasoning) {
            opts.onMessage({ role: 'assistant', content: '', reasoning: roundReasoning });
          }
          const omitted = carryContinuation({
            carried: ceilCarried,
            reasoning: ceilReasoning,
            newText: roundReasoning,
          });
          opts.onMessage({
            role: 'system',
            tone: 'warn',
            content: `Reasoning hit the length ceiling — continuing from where it stopped${
              omitted > 0 ? ` (${omitted} chars of earlier reasoning trimmed)` : ''
            }.`,
          });
          continue;
        }
      }
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
        const spentOnLength = ladderStop === 'count';
        opts.onMessage({
          role: 'system',
          tone: 'warn',
          content: spentOnLength
            ? 'Reasoning kept hitting the length limit — writing the plan from what was gathered.'
            : 'Reasoning was repeating itself — writing the plan from what was gathered.',
        });
        // Capture the repeated span now — the degenerate block is discarded after this, but the plan
        // force-write next round can bias off it (logit recovery). A block the ratio gate passed has
        // no rut, and its recurring words are the work, so there is nothing to bias off.
        verbatimRepeatedSpan = spentOnLength ? [] : repeatedSelfShingles(roundReasoning);
        forceVerbatimPlanWrite = true;
        continue;
      }
      // Agent/chat, first cut within budget → nudge to act on what it has. The DIRECTIVE is the same
      // either way — stop reasoning, act on what you have; only the diagnosis differs, and only the
      // count case gets the truthful one. A model told it was repeating has reason to spend its next
      // round auditing its own output for repetition, which is more reasoning, which is what got it
      // cut. See #285.
      if (opts.promptMode !== 'plan' && verbatimRecoveries < MAX_VERBATIM_RECOVERIES) {
        const spentOnLength = ladderStop === 'count';
        opts.onMessage({
          role: 'system',
          tone: 'warn',
          content: spentOnLength
            ? 'Reasoning kept hitting the length limit — stopped it.'
            : 'Reasoning was repeating itself — stopped it.',
        });
        opts.history.push({
          role: 'user',
          content: spentOnLength
            ? '(your reasoning kept hitting the length limit without producing an answer or a ' +
              'tool call, so it was stopped — it was not repeating itself. decide from what you ' +
              'already have and call a tool or give the answer concisely, without long reasoning)'
            : '(your reasoning was repeating the same text and was stopped — decide from what you ' +
              'already have and call a tool or give the answer concisely, without long reasoning)',
          // Not a turn boundary (#287). This fires on exactly the rounds where the task spec matters
          // most — a cut reasoning stream — so leaving it unflagged re-elects the pin to whatever
          // tool result lands next, and the model then re-fetches the spec it was already given.
          harness: true,
        });
        continue;
      }
      // The force-write itself spiraled. Before the honest stop, spend ONE steered retry: re-run the
      // force-write with a strong "commit, stop re-questioning" directive (buildPlanWritePrompt(steer))
      // and a tighter reasoning ceil (cheap-to-fail). Capped at MAX_CONVERGE_RETRIES; falls through to
      // the stop once spent. forceVerbatimPlanWrite is already true, so the next round re-force-writes.
      // The force-write round never carries a cut forward, so a length-only cut there reaches this
      // point with no ladderStop — and would otherwise be reported as a loop the ratio says it isn't.
      const forceWriteCutOnLength = planForceWrite && verbatimAbortByLength;
      if (CONVERGE_RETRY && opts.promptMode === 'plan' && convergeRetries < MAX_CONVERGE_RETRIES) {
        convergeRetries++;
        steerRetryActive = true;
        opts.onMessage({
          role: 'system',
          tone: 'warn',
          content: forceWriteCutOnLength
            ? 'The plan write hit the reasoning length limit — one more focused attempt with a tighter steer before stopping.'
            : 'Still looping — one more focused attempt with a tighter steer before stopping.',
        });
        opts.onRecovering?.(true);
        debugLog(`[reika:debug] round=${i} converge-retry (plan) attempt=${convergeRetries}\n`);
        continue;
      }
      // The force-write spiraled (and any steered retry is spent), or the recovery budget is gone: stop
      // honestly rather than loop or commit spiral garbage as a "plan". This model is stuck; say so.
      commitSpiralStop(
        opts,
        turnStart,
        fetchedUrls,
        ladderStop === 'count' || forceWriteCutOnLength ? 'length' : 'loop',
      );
      return;
    }

    // In plan force-write mode the request carried no tools, but some local models still emit
    // in-band `<tool_call>` text that the parser recovers (client.ts strips it from content first).
    // Drop those recovered calls so the turn commits the plan instead of looping on a tool we
    // already withdrew — withdrawing tools from the *request* alone doesn't stop an in-band caller.
    const toolCalls = planForceWrite || subagentForceReport ? [] : (response.toolCalls ?? []);
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
    // A truncated round and the continuation that resumes it are ONE thought. Join them so the
    // trace, the ratio gate and the carried tail all see the whole block; empty unless the previous
    // round was continued.
    const joinedReasoning = pendingReasoning ? `${pendingReasoning}\n${rsn}` : rsn;
    // What comes back to the model, in generation order. `content` is part of the cut-off thought —
    // it came LAST, so it is the resume anchor the nudge points at — and a model with no reasoning
    // channel puts the entire thought there. Carrying only `reasoning` left that model an empty
    // assistant message under a nudge that claimed "the text above is your own work".
    const roundText = [rsn, response.content ?? ''].filter(t => t.trim()).join('\n');
    const carriedBlock = pendingContinuation ? `${pendingContinuation}\n${roundText}` : roundText;

    // Continuation decision (#284), taken BEFORE the trace records because a round about to be
    // continued must not be recorded as its own entry. The gate is the repetition RATIO, not which
    // cut fired: the max_tokens wall and REASONING_HARD_CEIL landed 5.4% apart on the measured run
    // (30,270 chars against a 32,000 ceiling), so they cannot carry opposite semantics. Both the
    // ratio and the verdict are logged on every event so a continuation-specific bar can later be
    // derived from real data rather than guessed. See agent/continuation.ts.
    const cutOffMidThought = response.finishReason === 'length' && isFinal;
    let continueRound = false;
    if (CONTINUE && cutOffMidThought && carriedBlock.trim()) {
      // Judged on the block that is actually carried, not on reasoning alone: gating one string and
      // sending back a different one is a mismatch nobody can reconstruct later.
      const gate = continuationGate(carriedBlock);
      const allow = continuation.allow(roundText);
      continueRound = gate.continuable && allow.ok;
      debugLog(
        `[reika:debug] continuation round=${i} continue=${continueRound} ` +
          `ratio=${gate.ratio.toFixed(3)} threshold=${gate.threshold.toFixed(3)} ` +
          `allow=${allow.ok}${allow.reason ? ` stop=${allow.reason}` : ''} ` +
          `sim=${allow.sim.toFixed(2)} spent=${continuation.spent} ` +
          `chars=${carriedBlock.length}\n`,
      );
    }

    // A round about to be continued is HELD, not recorded: truncation split one thought across two
    // rounds, and recording each half separately reports the second as near-identical to the first
    // (high crossSim BY CONSTRUCTION), which would fire the Layer-2 loop-breaker on a model that is
    // simply finishing its sentence. The joined thought is recorded once, when the continuation
    // lands. Holding also leaves reasoningLoopActive untouched — the previous verdict stands until
    // there is a complete round to judge.
    const rec = continueRound
      ? undefined
      : reasoningTrace.record(
          { reasoning: joinedReasoning, content: response.content },
          REASONING_LOOP_THRESHOLD,
        );
    const sim = rec?.sim ?? 0;
    const streak = rec?.streak ?? 0;
    const channel: 'reasoning' | 'content' = rec?.channel ?? reasoningChannel;
    if (rec) {
      // Fire on a sustained streak, OR immediately on a near-identical round (no point waiting out the
      // streak when the reasoning is provably stuck). See REASONING_LOOP_IMMEDIATE.
      reasoningLoopActive =
        streak >= REASONING_LOOP_STREAK || (streak >= 1 && sim >= REASONING_LOOP_IMMEDIATE);
      reasoningChannel = channel;
    }
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

    // Cut off mid-thought and worth resuming (#284): carry the model's own work forward rather
    // than discarding it and asking for a restart. The old retry left the partial in history but
    // the model never saw it — the cut lands mid-think so the text is all `reasoning`, and a
    // Qwen-family template renders prior-turn `reasoning_content` as nothing. Promoting the tail
    // into `content` is what makes it visible.
    if (continueRound) {
      const omitted = carryContinuation({
        carried: carriedBlock,
        reasoning: joinedReasoning,
        newText: roundText,
      });
      // UI-only, so the scrollback keeps the thinking the user watched stream rather than the
      // trimmed tail — the same history/onMessage split the truncation notice below uses.
      if (rsn || response.content) {
        opts.onMessage({ role: 'assistant', content: response.content ?? '', reasoning: rsn });
      }
      opts.onMessage({
        role: 'system',
        tone: 'warn',
        content: `Response cut off at the token limit — continuing from where it stopped${
          omitted > 0 ? ` (${omitted} chars of earlier reasoning trimmed)` : ''
        }.`,
      });
      continue;
    }
    // Not continuing: the held thought (if any) was recorded above, so release it.
    pendingContinuation = '';
    pendingReasoning = '';

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
      // The nudge must be role 'user' to reach the model (messagesToChatParams drops system
      // messages). Push it to history but don't surface it as a user bubble — it isn't the
      // user's input. The UI sees a separate 'warn' system notice instead (same split
      // compaction uses: model-facing message in history, UI-only notice via onMessage).
      opts.history.push({
        role: 'user',
        content:
          '(your previous response was cut off at the token limit — continue concisely: give the answer or call a tool directly, no long preamble)',
        // Not a turn boundary (#287). This is the fallback for the continuation path — it runs when a
        // carry is refused, and whenever REIKA_CONTINUE is off — so without the flag the defect the
        // continuation nudge was fixed for simply reappears one branch over.
        harness: true,
      });
      opts.onMessage({
        role: 'system',
        tone: 'warn',
        content: 'Response cut off at the token limit — retrying.',
      });
      continue;
    }
    lengthRetries = 0;
    // This round either called a tool or is committing an answer, so the run of unproductive
    // continuations is over and the next truncation starts from a clean budget. The bound is on
    // continuing WITHOUT progress, never on continuing itself.
    continuation.noteProgress();

    // If the transform still came back empty (no tools were offered, so any "call" was inert),
    // salvage the gathered analysis directly — the turn must never commit an empty plan.
    let assistantContent = response.content;
    if (planForceWrite && !response.content?.trim()) {
      assistantContent = response.reasoning?.trim() || gatherPlanAnalysis(opts.history);
    }
    // A report round that put everything in the reasoning channel still has a report: the
    // reasoning IS the model's reading of what it found, and it beats `(no output)` to the parent.
    if (subagentForceReport && !response.content?.trim() && response.reasoning?.trim()) {
      assistantContent = response.reasoning.trim();
    }

    // Plan→agent grounding: when a plan is finalized, verify the symbols/paths it names exist in the
    // codebase and append an advisory for any that don't, so the executing agent (which inherits this
    // message) is warned up front rather than looping on phantom references. Runs once, at plan
    // commit. Strict no-op when the flag is off or the plan is clean. See agent/groundcheck.ts.
    const planBodyEnd = assistantContent?.length ?? 0;
    const planMissing: string[] = [];
    let planDeadUrls: { url: string; error: string }[] = [];
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
        if (note) {
          assistantContent = (assistantContent ?? '') + note;
          planMissing.push(...missing.missingPaths, ...missing.missingSymbols);
        }
      }
    }

    // Plan→agent URL grounding (REIKA_URL_GROUNDING, the same flag as the write/edit path): a plan
    // can recommend a URL that never reaches a write — a plan-only workflow, or a docs link in prose
    // — which the edit/write grounder would never see. So at plan commit, fetch the URLs the plan
    // names and append a flag-only note for any that don't resolve, inherited verbatim by the agent
    // turn. Harness-driven (like the symbol walk above), so it still runs on a turn that never made
    // the call itself — and plan mode HAS the web tools since #290, so this is now the backstop for
    // a URL the plan wrote without fetching, not the only way one gets checked. Strict no-op when
    // the flag is off.
    // Hold the receipt until after the plan message is pushed below, so it lands as a standalone
    // end-of-turn line — not tucked under the unrelated prior tool (a read/list). The grounding is
    // about the plan, not that read.
    let planUrlNotice: ToolResult['notice'];
    if (opts.promptMode === 'plan' && isFinal && assistantContent?.trim()) {
      const url = await groundUrlsForPlan(
        { cwd: opts.bundle.cwd, groundedUrls, sourcedUrls: () => collectSourcedUrls(opts.history) },
        assistantContent,
      );
      if (url.note) {
        assistantContent = assistantContent + url.note;
        planDeadUrls = url.dead ?? [];
      }
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
      ...(planMissing.length > 0 || planDeadUrls.length > 0
        ? { planChecks: { at: planBodyEnd, missing: planMissing, deadUrls: planDeadUrls } }
        : {}),
    };
    opts.history.push(assistantMsg);
    opts.onMessage(assistantMsg);
    // The plan-grounding receipt goes out after the plan, as a standalone line (not nested).
    if (planUrlNotice) {
      opts.onMessage({ role: 'system', tone: planUrlNotice.tone, content: planUrlNotice.content });
    }
    // Refinement that changed nothing (#46): a weak model handed "also cover X" can re-emit the
    // plan it already had, and the user would otherwise see a fresh plan turn with no way to tell
    // it apart from one that absorbed the request. Compared on the PARSED steps, so renumbering or
    // reformatting the same plan still reads as unchanged, and the grounding notes appended above
    // can't mask it. User-facing only — the model is told to revise in the ledger, and repeating
    // that here would just add a line to a prompt that already carries it.
    if (
      refinePlan &&
      isFinal &&
      // A question re-answered alongside the same plan did what it was asked; the warning's
      // "rephrase it" is advice for a change request that got lost.
      !opts.userInput.trim().endsWith('?') &&
      assistantContent?.trim() &&
      !planChanged(refinePlan.content, assistantContent)
    ) {
      opts.onMessage({
        role: 'system',
        tone: 'warn',
        content:
          'Plan unchanged — every step matches the plan from before this request. Rephrase it if ' +
          "that wasn't what you wanted, or /implement to execute the plan as it stands.",
      });
    }

    if (isFinal) {
      // Post-edit typecheck gate. If this turn edited (baseline captured) and a final check shows
      // the edits introduced new type errors, send the model back to fix them instead of letting it
      // finish on broken code — the harness verifies so the weak model doesn't have to. The model's
      // premature answer stays in the scrollback (same as the length-retry path); a 'user' message
      // carries the errors to the model (system messages get dropped by messagesToChatParams), and a
      // 'warn' notice tells the human. Bounded by MAX_TYPECHECK_GATE_ROUNDS: past the cap it commits
      // dirty with a notice rather than looping. Fail-open: no baseline or an unrunnable final check
      // just lets the turn end. REIKA_TYPECHECK=0 leaves `typecheckBaseline` null (the capture
      // above never runs), so this whole branch collapses for free.
      if (typecheckEnabled && typecheckBaseline !== null && !opts.signal?.aborted) {
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
          // `harness`: the send-back must reach the model but is not a turn boundary — without the
          // flag the task-spec pin re-elects to whatever tool result lands next (#287).
          opts.history.push({ role: 'user', content: decision.modelMessage, harness: true });
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
          // Same `harness` reasoning as the typecheck send-back above (#287).
          opts.history.push({ role: 'user', content: gate.modelMessage, harness: true });
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
    const seenWebBeforeRound = seenWebLookups.size;
    // A subagent call is exclusive in its round (#346): sibling inspection calls are held, so the
    // report is the only fresh payload the next round has to fit. Decided over the whole round up
    // front — the siblings are held whichever side of the subagent call they were listed on. Not
    // when the spawn itself would be refused (per-turn cap), which would leave the model with
    // nothing this round.
    const roundHasSubagent = toolCalls.some(c => c.name === 'subagent');
    if (roundHasSubagent) {
      subagentCalls.rounds += 1;
      subagentCalls.inRound = 0;
    }
    const subagentInRound = roundHasSubagent && subagentCalls.rounds <= MAX_SUBAGENTS_PER_TURN;
    for (const call of toolCalls) {
      if (opts.signal?.aborted) return;
      const tool = opts.tools.find(t => t.name === call.name);
      // Loop break: refuse a withdrawn inspection call at dispatch — covers the in-band caller that
      // routes around the omitted tool list. No execution, no content; just the directive. An
      // inspection `bash grep/cat/tail/sed -n …` is refused too: it's the escape a withdrawn model
      // routes to when read/grep/glob/list are pulled (mutating/build bash still runs, so real work
      // is unaffected). isInspectionEscape, NOT plan mode's isProvablyReadOnly — the ladder needs the
      // wider question ("is this the model reading instead of working"), which includes the sed/awk
      // line-range reads plan mode refuses to admit. See tools/_readonly.ts.
      const refusedBashGrep =
        call.name === 'bash' && isInspectionEscape(String(call.args.command ?? ''));
      const refused = withdrawInspection && (INSPECTION_TOOLS.has(call.name) || refusedBashGrep);
      // Held for the subagent (#346): the same inspection set the withdrawal ladder pauses, for the
      // one round a subagent is dispatched in. Mutating siblings are out of scope — a subagent round
      // is an exploration round by construction, and an edit alongside one is a different problem.
      const heldForSubagent =
        subagentInRound &&
        !refused &&
        call.name !== 'subagent' &&
        (INSPECTION_TOOLS.has(call.name) || refusedBashGrep);
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
      let changes: ToolResult['changes'];
      let exitCode: ToolResult['exitCode'];
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
      // `willMutate`, not MUTATING_TOOLS: a shell edit is an edit, and a turn that does its writing
      // through bash used to finish unverified. The baseline capture is the first thing
      // REIKA_TYPECHECK=0 (typecheckEnabled) switches off — with it off nothing downstream can
      // fire either, since the gate is null-baseline fail-open.
      if (
        typecheckEnabled &&
        !typecheckBaselineAttempted &&
        tool &&
        !refused &&
        !bouncedBlindEdit &&
        willMutate(call.name, call.args, opts.bundle.cwd)
      ) {
        typecheckBaselineAttempted = true;
        // Resolve the governing tsconfig from the file being edited (walk-up, bounded at cwd) so a
        // monorepo subpackage edit is checked against that package's config, not just a root one —
        // and so the baseline and the final check pin the same config. null → undefined leaves the
        // closure on its detection fallback (which agrees: no config found = gate stays off).
        // For bash the anchor is the first file the command names — writeTargets returns them
        // resolved against cwd, which detectTsProject's own resolve() accepts unchanged.
        typecheckTsconfig =
          (await detectTsProject(
            opts.bundle.cwd,
            typecheckAnchor(call.name, call.args, opts.bundle.cwd),
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
        payload = buildWithdrawalDirective(toolNames);
        debugLog(
          `[reika:debug] round=${i} refused ${call.name}${
            refusedBashGrep ? ' (bash-grep)' : ''
          } (inspection withdrawn)\n`,
        );
      } else if (bouncedBlindEdit) {
        const blindPath = String(call.args.path);
        summary = `edit paused — read ${blindPath} first, then re-issue the edit`;
        payload = buildReadFirstDirective(blindPath);
        if (debugEnabled()) {
          const probe = await probeWouldLand(
            opts.bundle.cwd,
            blindPath,
            String(call.args.old_string ?? ''),
            String(call.args.new_string ?? ''),
          );
          debugLog(`[reika:debug] round=${i} read-first bounce ${blindPath} ${probe}\n`);
        }
      } else if (heldForSubagent) {
        const label = refusedBashGrep ? 'shell inspection' : call.name;
        summary = `${label} held — the subagent dispatched this round covers it`;
        payload = SUBAGENT_HOLD_NOTE;
        debugLog(`[reika:debug] round=${i} held ${call.name} (subagent in round)\n`);
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
        // Live in-flight row (#509). After the spill-stats bookkeeping and the typecheck baseline
        // above — both harness work that happens before the command runs — so the row's lifetime is
        // exactly the call's.
        opts.onToolStart?.(call.name);
        try {
          const result = await tool.run(call.args, {
            cwd: opts.bundle.cwd,
            ignore: opts.bundle.ignore,
            webBudget,
            webHealth,
            fetchedUrls,
            toolNames,
            resolvedDeps,
            groundedUrls,
            sourcedUrls: () => collectSourcedUrls(opts.history),
            askedQuestions,
            requestApproval: opts.requestApproval,
            requestQuestion,
            onProgress: opts.onToolProgress && (chunk => opts.onToolProgress!(chunk, tool.name)),
            spawnSubagent: makeSpawnSubagent(opts, subagentCalls, decodeThroughput, genReserve),
            bashTimeoutMs: opts.config.bashTimeoutMs,
            bashIdleMs: opts.config.bashIdleMs,
            sandbox: opts.config.sandbox,
            unattended: opts.isUnattended?.() ?? opts.config.unattended,
            signal: opts.signal,
          });
          summary = result.summary;
          payload = result.payload;
          diff = result.diff;
          command = result.command;
          changes = result.changes;
          exitCode = result.exitCode;
          contentHash = result.contentHash;
          toolNotice = result.notice;
          editFailure = result.editFailure;
          // The mid-session subagent trigger (#343). A grep/glob that spans enough
          // files that reading them would cross the compaction threshold gets a footer pointing at
          // subagent. Observation-keyed (the files are in the result) and pressure-gated (the
          // estimate is this round's, the threshold the window's) — see subagentpressure.ts. The
          // subagent tool being in the list is what keeps this out of subagents and plan mode.
          if (
            subagentPressureEnabled() &&
            !subagentAffordanceOffered &&
            window &&
            payload &&
            (call.name === 'grep' || call.name === 'glob') &&
            opts.tools.some(t => t.name === 'subagent')
          ) {
            const files = filesInResult(call.name, payload);
            const estimateTokens = Math.round(rawEstimate() * compactCalibration);
            const thresholdTokens = compactThreshold(window, minGen());
            if (underPressure({ files, estimateTokens, thresholdTokens })) {
              payload = `${payload}\n\n${buildSubagentAffordance(files)}`;
              subagentAffordanceOffered = true;
              debugLog(
                `[reika:debug] round=${i} subagent-affordance files=${files} ` +
                  `estimate=${estimateTokens} threshold=${Math.round(thresholdTokens)}\n`,
              );
            }
          }
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
          // Resolved exactly as the tool resolves it, so a default-window read followed by an
          // explicit narrower one is seen as narrowing rather than as a repeat (#184).
          Math.max(1, Number(call.args.limit ?? READ_DEFAULT_LIMIT)),
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
      // on path+offset so a same-or-wider re-read still counts; a narrowing one is exempt, being
      // the omission marker's own remedy); mutating tools reset the memory so a read-after-edit
      // isn't flagged. Skipped for unknown tools (nothing produced).
      if (tool && !refused && !bouncedBlindEdit && !heldForSubagent)
        payload = flagRepeatedCall(seenReadOnly, call.name, call.args, summary, payload);
      // A refusal (budget, offline, latch) carries no payload, so it is never novelty.
      if (tool && !refused && payload && WEB_LOOKUP_ARG[call.name]) {
        seenWebLookups.add(`${call.name}\0${String(call.args[WEB_LOOKUP_ARG[call.name]] ?? '')}`);
      }
      // Mark that the model has acted, so loop-break withdrawal stops scoping to this turn — a
      // failed edit counts, since it's the attempt (and the failure) that puts us in edit-recovery.
      // A BOUNCED edit doesn't: the harness withheld it, nothing ran, and the directed read that
      // follows must stay eligible for the normal read-loop ladder if the model spins instead.
      // `didMutate`, not MUTATING_TOOLS: a bash command that actually changed the tree has edited,
      // and the plan done-gate keys off this. Split from the edit-recovery block below, which stays
      // edit/write-only — `lastEditFailed`, the read-first grounding, and applyPlanEdit all read
      // fields (old_string failures, args.path, a rendered diff) that a shell command has no
      // analogue for.
      if (!bouncedBlindEdit && didMutate(call.name, changes)) editingStarted = true;
      if (!bouncedBlindEdit && MUTATING_TOOLS.has(call.name)) {
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
      // File steps implemented through the shell: the same path/content check-off an edit gets,
      // keyed on the files the tree diff says the command actually changed (#278) rather than on
      // the command text. Load-bearing now that a shell edit counts as editing (`didMutate`) — the
      // done-gate below bounces an implementing turn that leaves file-bearing steps unchecked, so
      // without this a bash-only turn would bounce every round until its budget ran out, with no
      // way to ever check a step off. Deliberately not gated on the exit status, unlike the command
      // check-off: a command that wrote the file and then exited non-zero still wrote it, and the
      // diff is the observation. One command can land several files, so each is applied. Keyed on
      // `bash` rather than on `changes` alone, though only bash sets it today: a tool that both
      // reported changes AND ran the edit block above would check two steps off for one edit.
      if (planSteps && call.name === 'bash' && changes) {
        let match: StepMatch | null = null;
        for (const f of changes.files) {
          const hit = applyPlanEdit(planSteps, f.path, f.hunks.map(hk => hk.text).join('\n'));
          if (hit) match = hit;
        }
        if (match) {
          opts.onPlanProgress?.(planSteps);
          const done = planSteps.filter(s => s.done).length;
          const via =
            match.by === 'content' ? ' — matched by edit content; the plan names another file' : '';
          planCheckoff =
            done === planSteps.length
              ? `Plan complete — all ${planSteps.length} steps checked off.`
              : `Plan step ${planSteps[match.index].n} checked off (${done}/${planSteps.length})${via}.`;
        }
      }
      // Command steps ("run typecheck/tests"): a successful bash run whose command contains the
      // step's quoted command checks it off — previously these steps could never complete and
      // dragged the checklist down after a green run. Success is the exit status, not the summary
      // prefix: since #200 a failing run also reports as `Ran:` (with the code in it), so keying on
      // the prefix would check a step off for a red test run.
      if (
        planSteps &&
        call.name === 'bash' &&
        command?.text &&
        ranSuccessfully({ summary, exitCode })
      ) {
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
        ...(changes ? { changes } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      opts.history.push(toolMsg);
      opts.onMessage(toolMsg);
      // Read-first (#72): ground the path against the message just pushed, so the gate can later ask
      // whether those exact bytes are still in the request rather than whether they ever were.
      if (groundsPath) {
        readFirst.ground(groundsPath, groundsAuthored ? undefined : opts.history.length - 1);
      }
      // A tool's harness-side-effect receipt (URL grounding, a search provider going down, bash's
      // no-repo diff coverage) goes out as a standalone system line AFTER its chip — a follow-on to
      // the action, not stuffed in front of it. Also logged so a run is classifiable in REIKA_DEBUG.
      if (toolNotice) {
        opts.onMessage({ role: 'system', tone: toolNotice.tone, content: toolNotice.content });
        debugLog(`[reika:debug] round=${i} tool-notice tool=${call.name} ${toolNotice.content}\n`);
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
    const roundLearned =
      seenReadOnly.size > seenBeforeRound || seenWebLookups.size > seenWebBeforeRound;
    planStaleRounds = roundLearned ? 0 : planStaleRounds + 1;
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
  // Why the turn ran out of recoveries. 'loop' is the genuine spiral; 'length' is a coherent thought
  // that kept crossing the reasoning ceiling and spent its continuations. Telling a user the model
  // "kept looping" for the second case sends them after their prompt and their model choice when the
  // cause was a length limit — the diagnosis they need is the opposite one (#285).
  reason: 'loop' | 'length' = 'loop',
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
      reason === 'length'
        ? `I couldn't converge — the reasoning kept hitting the length limit without reaching an ` +
          `answer, and was stopped to avoid running indefinitely.${examined} This request needed ` +
          `more uninterrupted reasoning than the limit allows; try narrowing it into smaller steps.`
        : `I couldn't converge — the reasoning kept looping and was stopped to avoid running ` +
          `indefinitely.${examined} This looks like a request the model is getting stuck on; try ` +
          `rephrasing or narrowing it, or use a stronger model.`,
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
function commitAgentLoopStop(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  turnStart: number,
  fetchedUrls: Set<string>,
  edited: boolean,
): void {
  const files = new Set<string>();
  for (const m of opts.history) {
    // A shell edit names its files in the tool message's git-backed `changes`, not in the call's
    // args — the command text is `sed -i …`, and parsing it here would be a worse answer than the
    // one the detector already computed (#278). Since bash now counts as editing (`didMutate`),
    // without this a bash-only turn stopped on "I made changes" with nothing after it.
    if (m.role === 'tool') {
      for (const f of m.changes?.files ?? []) files.add(f.path);
      continue;
    }
    if (m.role !== 'assistant') continue;
    for (const tc of m.toolCalls ?? []) {
      if ((tc.name === 'edit' || tc.name === 'write') && typeof tc.args.path === 'string') {
        files.add(tc.args.path);
      }
    }
  }
  const fileList = files.size > 0 ? ` to ${[...files].slice(0, 8).join(', ')}` : '';
  const content = edited
    ? `I made changes${fileList} but then kept repeating the same checks without making progress, so ` +
      `I've stopped to avoid looping. The edits are saved — review them and ask me to continue if ` +
      `anything's off.`
    : `I kept repeating the same step without making progress, so I've stopped rather than loop. Let ` +
      `me know how you'd like to proceed.`;
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

function makeSpawnSubagent(
  parent: RunTurnOpts,
  budget: SubagentBudget,
  parentDecodeRate: DecodeRate,
  parentGenReserve: GenReserve,
) {
  return async (sub: { task: string }): Promise<ToolResult> => {
    // `rounds` was advanced at dispatch for this round, so the cap reads as "more rounds than
    // allowed", and the width check is against the calls already honoured in this round.
    if (budget.rounds > MAX_SUBAGENTS_PER_TURN) {
      return {
        summary: `Subagent budget for this turn exhausted (${MAX_SUBAGENTS_PER_TURN} rounds)`,
        payload:
          `(reika: subagents have been dispatched in ${MAX_SUBAGENTS_PER_TURN} rounds this turn ` +
          'already. Answer from their reports and your own reads; if something is still missing, ' +
          'say what.)',
      };
    }
    if (budget.inRound >= MAX_SUBAGENTS_PER_ROUND) {
      return {
        summary: `Subagent width for this round exhausted (${MAX_SUBAGENTS_PER_ROUND})`,
        payload:
          `(reika: ${MAX_SUBAGENTS_PER_ROUND} subagents already run in this round, one after ` +
          'another. Fold this task into a later round once their reports are in.)',
      };
    }
    budget.inRound += 1;
    const subConfig: Config = {
      ...parent.config,
      model: parent.config.subagentModel ?? parent.config.model,
      baseURL: parent.config.subagentBaseURL ?? parent.config.baseURL,
      apiKey: parent.config.subagentApiKey ?? parent.config.apiKey,
      maxTurns: parent.config.subagentMaxTurns,
      // The catalog's output cap is the parent model's; a different subagent model has its own.
      maxOutputTokens:
        parent.config.subagentModel && parent.config.subagentModel !== parent.config.model
          ? undefined
          : parent.config.maxOutputTokens,
    };
    // No `subagent` (no recursion) and no `ask_user`: a subagent runs underneath a tool call the
    // parent is already blocked on, so a question from down here would stack a second prompt on the
    // user with no context for where it came from. It degrades to "decide it yourself" instead.
    const subTools = parent.tools.filter(t => t.name !== 'subagent' && t.name !== 'ask_user');
    const subHistory: Message[] = [];
    // The tok/s chip sits beside the token counts, and onUsage already reports the subagent's, so
    // the rate has to follow it. On the same engine the two learners are one measurement, so the
    // subagent continues the parent's rate and hands its own back; on another endpoint the chip
    // blanks until the subagent has a sample, and the parent's rate comes back with the parent.
    const sameEngine =
      subConfig.model === parent.config.model && subConfig.baseURL === parent.config.baseURL;
    if (!sameEngine) parent.onDecodeRate?.(undefined);

    parent.onSubagent?.(true);
    try {
      await runTurn({
        userInput: sub.task,
        history: subHistory,
        bundle: parent.bundle,
        config: subConfig,
        tools: subTools,
        payloads: parent.payloads,
        signal: parent.signal,
        requestApproval: parent.requestApproval,
        isUnattended: parent.isUnattended,
        onUsage: parent.onUsage,
        priorDecodeRate: sameEngine ? parentDecodeRate.get() : undefined,
        genReserve: sameEngine ? parentGenReserve : undefined,
        onDecodeRate: rate => {
          if (sameEngine && rate != null) parentDecodeRate.adopt(rate);
          parent.onDecodeRate?.(rate);
        },
        onMessage: msg => parent.onMessage({ ...msg, nested: true } as Message),
        // Streaming + phase callbacks forward into the parent's live region (#342). They used to be
        // withheld "so the parent's live region stays clean", but the parent is blocked inside this
        // tool call with its assistant message already committed — the region is empty for the whole
        // run, and withholding them made a subagent a silent block that rendered each round as a
        // batch on commit (a 90-minute spiral was invisible until the log was read). The UI draws
        // them nested via onSubagent.
        onContentDelta: parent.onContentDelta,
        onReasoningDelta: parent.onReasoningDelta,
        onToolProgress: parent.onToolProgress,
        // `onToolStart` is the one callback deliberately NOT forwarded (#509). The parent's live row
        // is a single slot keyed to its own round: forwarding a nested start would overwrite the
        // parent's "Delegating…" with one of the subagent's verbs, and the nested tool message that
        // follows would clear the slot outright — leaving the subagent's own call row unmarked for
        // the rest of the run. The parent's row covers the whole subagent; the nested stream below it
        // already shows what the subagent is doing.
        onPhase: parent.onPhase,
        onReasoningStatus: parent.onReasoningStatus,
        onReasoningReset: parent.onReasoningReset,
        reportAtCap: true,
      });
    } finally {
      parent.onSubagent?.(false);
      if (!sameEngine) parent.onDecodeRate?.(parentDecodeRate.get());
      // The subagent's last phase was its report round ('thinking'); the parent is still
      // dispatching this round's tools.
      parent.onPhase?.('tool');
    }

    const finalAssistant = [...subHistory].reverse().find(m => m.role === 'assistant') as
      | (Message & { role: 'assistant' })
      | undefined;
    const result = finalAssistant?.content ?? '';
    const usedDifferentModel = subConfig.model !== parent.config.model;
    // What the task named that the subagent never opened — the parent's cue to re-spawn for the
    // remainder instead of reading it into its own context. See subagentreport.ts.
    const coverage = buildCoverageNote(sub.task, subHistory);
    return {
      summary: usedDifferentModel
        ? `Subagent (${subConfig.model}) completed (${result.length} chars)`
        : `Subagent completed (${result.length} chars)`,
      payload: (result || '(no output)') + (coverage ? `\n\n${coverage}` : ''),
    };
  };
}
