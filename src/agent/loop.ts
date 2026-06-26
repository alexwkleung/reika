import type {
  ApprovalRequest,
  Config,
  ContextBundle,
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
} from './compaction.js';
import { ReadTrace, type LoopingRead } from './readtrace.js';
import { debugEnabled, debugLog } from '../debug.js';
import type { PayloadStore } from '../store/payloads.js';
import { type Diagnostic, decideTypecheckGate, runTypecheck } from '../check/typecheck.js';

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
// EXPERIMENT (plan→agent handoff): fold the plan-mode exploration that precedes a written plan into
// a compact digest at the start of each agent turn, so the plan stays salient instead of being
// buried under the raw read transcript (agent/compaction.ts distillPlanHandoff). Off by default for
// a clean A/B; independent of REIKA_PLAN_EXPERIMENT (which only sets the *starting* mode, so reusing
// it would skip distillation whenever plan mode is reached via /plan). Strict no-op when off.
const PLAN_HANDOFF_DISTILL = process.env.REIKA_PLAN_HANDOFF === '1';

// EXPERIMENT (plan mode): the force-write turn is a *transformation*, not another exploration
// round. Asking the exploring model to "stop and write prose" fights its action prior and lets
// the plan it already has decay across turns; but the plan is reliably in its reasoning. So at
// the cap we discard the exploration history (and its read-momentum) and feed the model only the
// task + its own accumulated reasoning, with no tools, asking it to convert that into a plan.
// "Summarize your analysis into a plan" is a task weak models do far better than "decide to stop".
function buildPlanWritePrompt(): string {
  // Deliberately positive and permissive. Heavy negative constraints ("output ONLY … no preamble,
  // no code") make ruminating thinking models burn their whole generation budget litigating the
  // rules instead of writing — they cut off mid-plan and retry. A short snippet or preamble is fine;
  // the only thing that matters is a grounded, file-specific plan.
  return [
    'You are in PLAN MODE. Exploration is finished and you have no tools.',
    'The next message has the original request and your exploration notes (file contents + analysis).',
    'Write a numbered implementation plan from them. For each step, name the file and the change to',
    'make — a short code snippet is fine. Keep every step grounded in the notes: use their exact file',
    'paths and identifiers, and do not invent paths, filenames, or class names.',
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
function buildPlanTransformInput(history: Message[], budgetChars: number): string {
  const task = (
    history.find((m): m is Message & { role: 'user' } => m.role === 'user' && !m.meta)?.content ??
    ''
  ).slice(0, 2000);
  const analysisRaw = gatherPlanAnalysis(history);
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
// Post-edit typecheck gate: how many times a turn may be sent back to fix type errors its own
// edits introduced before it's allowed to finish anyway. The harness verifies so the weak model
// doesn't have to remember to — but a model that can't clear the errors must commit rather than
// loop, same bounded-recovery contract as MAX_LENGTH_RETRIES and the loop-withdrawal ladder. 2
// gives one fix attempt plus a re-check; beyond that, finishing dirty (with a user notice) beats
// spiralling. See check/typecheck.ts.
const MAX_TYPECHECK_GATE_ROUNDS = 2;
// Returned in place of a withdrawn inspection call. No content, so it can't re-fuel the loop or
// inflate context; it just states the rule and the way out.
const WITHDRAWAL_DIRECTIVE =
  '(reika: inspection tools (read/grep/glob/list) are paused because you have re-read the same ' +
  'content repeatedly without making a change. You already have what you need. Make the edit the ' +
  'task requires with the edit/write tools, or if something specific is blocking you, say what it ' +
  'is. Reading and searching are unavailable until you make progress.)';

// Agent-mode counterpart to the plan ledger: a persistent, non-aging stop signal for a confirmed
// read loop. The per-payload nudge (flagRepeatedCall) can't break a period >= 2 loop on a one-round
// liveness window — it ages out before the loop returns to that call — so the signal must live in
// the system suffix, which is regenerated each round and never ages. Emitted ONLY while a loop is
// active (ReadTrace.loopingReads), so a healthy turn never sees it. The "or state what is blocking
// you" escape is load-bearing: it gives a cornered model an out that isn't a premature wrong edit.
// `withdrawn` adds the harder line once we've escalated to pulling the inspection tools.
export function buildAgentLoopLedger(looping: LoopingRead[], withdrawn = false): string {
  const files = looping
    .slice(0, 8)
    .map(l => (l.offset > 1 ? `${l.path}:L${l.offset}` : l.path))
    .join(', ');
  const lines = [
    '',
    '--- reika status (auto-generated — not user input) ---',
    `You have re-read the same file(s) several times this turn and the content has not changed: ${files}.`,
  ];
  if (withdrawn) {
    lines.push(
      'Reading and searching are now PAUSED. Make the edit the task requires with the edit/write',
      'tools, or state specifically what is still blocking you.',
    );
  } else {
    lines.push(
      'Re-reading them returns identical bytes — it will not surface anything new. Stop gathering and',
      'either make the change the task needs, or state specifically what is still blocking you.',
    );
  }
  return lines.join('\n');
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
  // Whether the model has made any edit/write this turn. Tool withdrawal exists to force the
  // explore→act transition; once the model has acted, that job is done. After the first edit a
  // re-read is usually edit-recovery (re-fetching exact bytes to build old_string after the content
  // aged out), NOT gratuitous looping — withdrawing read there forces it onto bash-grep and makes
  // edits *harder* to land (observed). So withdrawal is scoped to the pre-edit explore loop; the
  // soft ledger still fires after, since it's harmless and the re-reads are genuinely redundant.
  let editingStarted = false;
  // Pre-edit baseline for the post-edit typecheck gate. Captured lazily, immediately before the
  // turn's FIRST mutating tool runs, so it reflects the project's type-error state *before* the
  // model's edits; the done-gate diffs the final state against it and surfaces only what the edits
  // introduced. null = not captured (a turn that never edits, a non-TS project, or a checker that
  // couldn't run) and disables the gate — fail-open. A non-null (possibly empty) array = captured.
  let typecheckBaseline: Diagnostic[] | null = null;
  // One-shot guard so the baseline is captured at most once per turn (and a fail-open capture
  // isn't re-probed on every subsequent edit).
  let typecheckBaselineAttempted = false;
  // Consecutive done-gate send-backs this turn. Bounds the fix loop at MAX_TYPECHECK_GATE_ROUNDS.
  let typecheckGateRounds = 0;
  // Per-turn memory of read-only calls already made, keyed by tool + result summary, so the
  // dispatch loop can flag a model that re-issues the same read/grep/list/glob and stalls.
  // Cleared by any mutating tool, since repo state may have changed. See READONLY_TOOLS.
  const seenReadOnly = new Map<string, number>();
  // REIKA_DEBUG-only instrumentation: classifies each read as unique / changed / dup-live /
  // dup-aged so a run reveals whether re-reads are redundant loops or rational refetches of
  // aged-out content. Model-invisible — only the debug log reads it. See agent/readtrace.ts.
  const readTrace = new ReadTrace();

  const window = opts.config.contextWindow;
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
    });

  // Run a typecheck while pulsing the UI indicator around it (and clearing on any exit). The
  // pulse is human-only; the CheckOutcome flows to the gate logic, never to the model.
  const typecheck = async () => {
    opts.onTypecheck?.(true);
    try {
      return await runTypecheck(opts.bundle.cwd, { signal: opts.signal });
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

  for (let i = 0; i < opts.config.maxTurns; i++) {
    if (opts.signal?.aborted) {
      commitAborted(opts, '', turnStart, fetchedUrls);
      return;
    }
    opts.onPhase?.('thinking');

    // Up to the cap: append the ledger + escalating nudge to the exploration prompt. At the cap:
    // switch to the transform — a tool-less call over a synthetic task+notes context, NOT the
    // exploration history. callHistory/callTools below are what actually get sent.
    const planForceWrite =
      opts.promptMode === 'plan' &&
      (planStaleRounds >= PLAN_STALL_ROUNDS || i >= PLAN_HARD_CEILING);
    // Loop-break escalation: when a confirmed agent-mode loop persists past the ledger, withdraw the
    // inspection tools this round to force the explore→act transition. Recomputed each round, so it
    // lifts as soon as the loop clears. Never set in plan mode (which has its own force-write).
    let withdrawInspection = false;
    if (opts.promptMode === 'plan') {
      system = planForceWrite
        ? buildPlanWritePrompt()
        : baseSystem + '\n\n' + buildPlanLedger(opts.history, i);
    } else {
      // Agent/chat: surface a persistent stop directive only while a read loop is active. ReadTrace
      // reflects rounds 0..i-1 here (it's updated during dispatch), so a loop confirmed at round
      // i-1 appears in round i's system. Reset to baseSystem otherwise, so a recovered model — or a
      // turn that never looped — isn't nagged. Chat mode has no reads, so this is always baseSystem.
      const looping = readTrace.loopingReads(
        i,
        LOOP_RECENT_ROUNDS,
        LOOP_AGED_REPEATS,
        LOOP_LIVE_REPEATS,
      );
      loopActiveRounds = looping.length > 0 ? loopActiveRounds + 1 : 0;
      // Scope to the explore→act transition: never withdraw once editing has begun (see editingStarted).
      withdrawInspection = !editingStarted && loopActiveRounds >= LOOP_WITHDRAW_AFTER;
      system =
        looping.length > 0
          ? baseSystem + '\n\n' + buildAgentLoopLedger(looping, withdrawInspection)
          : baseSystem;
      if (withdrawInspection) {
        debugLog(
          `[reika:debug] round=${i} inspection-withdrawn loopActiveRounds=${loopActiveRounds}\n`,
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
            content: buildPlanTransformInput(opts.history, planTransformBudget),
          } as Message,
        ]
      : opts.history;

    // Keep the request under the window: if the calibrated estimate crosses the threshold,
    // collapse the oldest turns into a recap before calling. Compaction mutates this turn's
    // history copy; the UI scrollback is untouched, so the user keeps the full log.
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
          `adjusted=${Math.round(e * calibration)} ` +
          `threshold=${window ? Math.round(compactThreshold(window, opts.config.minGenTokens)) : 'n/a'} ` +
          `willCompact=${window ? shouldCompact(e * calibration, window, opts.config.minGenTokens) : false} ` +
          `sys≈${Math.round(system.length / 4)}t reasoning≈${Math.round(rsnChars / 4)}t ` +
          `summaries≈${Math.round(sumChars / 4)}t payloads≈${Math.round(payChars / 4)}t ` +
          `reasoningRounds=${opts.config.reasoningRounds}\n`,
      );
    }
    // Force-write sends the tiny synthetic context, not opts.history, so there is nothing to
    // compact — skip it. Otherwise collapse the oldest turns if the estimate crosses the threshold.
    if (
      !planForceWrite &&
      window &&
      shouldCompact(rawEstimate() * calibration, window, opts.config.minGenTokens)
    ) {
      const removed = compactHistory(opts.history, window, calibration, opts.config.minGenTokens);
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
    const response = await callModel({
      system,
      history: callHistory,
      tools: callTools,
      config: opts.config,
      onContentDelta: opts.onContentDelta,
      onReasoningDelta: opts.onReasoningDelta,
      signal: opts.signal,
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
    });

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
      commitAborted(opts, response.content, turnStart, fetchedUrls);
      return;
    }

    // In plan force-write mode the request carried no tools, but some local models still emit
    // in-band `<tool_call>` text that the parser recovers (client.ts strips it from content first).
    // Drop those recovered calls so the turn commits the plan instead of looping on a tool we
    // already withdrew — withdrawing tools from the *request* alone doesn't stop an in-band caller.
    const toolCalls = planForceWrite ? [] : (response.toolCalls ?? []);
    const isFinal = toolCalls.length === 0;

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
          opts.history.push({ role: 'user', content: decision.modelMessage });
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
      if (readTrace.total() > 0) {
        debugLog(`[reika:debug] read-trace-summary ${readTrace.summary()}\n`);
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
      // routes around the omitted tool list. No execution, no content; just the directive.
      const refused = withdrawInspection && INSPECTION_TOOLS.has(call.name);
      let summary: string;
      let payload: string | undefined;
      let diff: ToolResult['diff'];
      let command: ToolResult['command'];
      let contentHash: string | undefined;
      // Capture the pre-edit baseline once, immediately before the turn's first mutating tool
      // applies, so the done-gate diffs against the project's state before any of this turn's edits.
      // Runs in the post-generation dispatch gap (machine idle, not inferring — important when a
      // local model is saturating the box) and only on turns that actually edit. Fail-open: a
      // non-TS project or an unrunnable checker leaves the baseline null, disabling the gate.
      if (!typecheckBaselineAttempted && tool && !refused && MUTATING_TOOLS.has(call.name)) {
        typecheckBaselineAttempted = true;
        const base = await typecheck();
        typecheckBaseline = base.ran ? base.diagnostics : null;
        debugLog(
          `[reika:debug] round=${i} typecheck-baseline ${
            base.ran ? `${base.diagnostics.length} diags` : `skipped: ${base.reason}`
          }\n`,
        );
      }
      if (refused) {
        summary = `${call.name} paused — make the edit or say what's blocking you`;
        payload = WITHDRAWAL_DIRECTIVE;
        debugLog(`[reika:debug] round=${i} refused ${call.name} (inspection withdrawn)\n`);
      } else if (!tool) {
        summary = `Unknown tool: ${call.name}`;
      } else {
        try {
          const result = await tool.run(call.args, {
            cwd: opts.bundle.cwd,
            ignore: opts.bundle.ignore,
            webBudget,
            fetchedUrls,
            resolvedDeps,
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
        } catch (e) {
          summary = `Tool error: ${(e as Error).message}`;
        }
      }
      // Instrument re-reads (debug only): is this a fresh read, a redundant loop, or a rational
      // refetch of content that aged out? Recorded for every read regardless of REIKA_DEBUG (cheap,
      // and the live/aged label depends on round order), but only emitted under the flag.
      if (!refused && call.name === 'read' && contentHash) {
        const { cls, repeats } = readTrace.record(
          String(call.args.path ?? ''),
          Number(call.args.offset ?? 1),
          contentHash,
          i,
        );
        debugLog(
          `[reika:debug] read-trace round=${i} class=${cls} repeats=${repeats} ${summary}\n`,
        );
      }
      // Loop-breaker: weak models re-issue the same read/grep/bash and stall on the identical
      // output. flagRepeatedCall appends an escalating redirect on the 2nd+ repeat (read keyed
      // on path+offset so window-varying re-reads still count); mutating tools reset the memory
      // so a read-after-edit isn't flagged. Skipped for unknown tools (nothing produced).
      if (tool && !refused)
        payload = flagRepeatedCall(seenReadOnly, call.name, call.args, summary, payload);
      // Mark that the model has acted, so loop-break withdrawal stops scoping to this turn — a
      // failed edit counts, since it's the attempt (and the failure) that puts us in edit-recovery.
      if (MUTATING_TOOLS.has(call.name)) editingStarted = true;
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

function commitAborted(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  partial: string,
  turnStart: number,
  fetchedUrls: Set<string>,
): void {
  const content = partial ? `${partial}\n\n(aborted)` : '(aborted)';
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
