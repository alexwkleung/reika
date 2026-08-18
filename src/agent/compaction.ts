import type { Message } from '../types.js';
import { DEFAULT_MIN_GEN_TOKENS } from '../provider/budget.js';
import { findFreshToolBlockStart } from '../provider/toolcall.js';
import { parsePlanSteps } from './plantrack.js';

// Keep in sync with CHARS_PER_TOKEN in ../provider/tokens.ts.
const CHARS_PER_TOKEN = 4;
// Post-compaction budgets as a fraction of the *available* window (total minus the
// generation reserve): recent turns kept verbatim, and the recap of everything older.
// Sized conservatively so kept + recap + system stays under the trigger even when a model
// tokenizes denser than the heuristic — and so the recap can't grow without bound.
const KEEP_FRACTION = 0.3;
const RECAP_FRACTION = 0.1;
// Fraction of the available window kept as verbatim findings when distilling a plan→agent handoff.
// Lightweight by default: the executing agent has read tools, so re-reading a file mid-execution is
// cheap and self-correcting, whereas carrying every explored file verbatim defeats the point —
// freeing the window so the plan stays salient and the agent's own edit/verify loop has room. Raise
// toward KEEP_FRACTION on larger (24k+) windows where re-reads cost more than the spare room saves.
const HANDOFF_FINDINGS_FRACTION = 0.15;
// Per-entry text budget inside the recap.
const MAX_TEXT = 240;
// Slack against estimate error: trigger compaction slightly before the prompt would
// actually leave less than the generation reserve, not exactly at the wall.
const COMPACT_SAFETY = 0.9;

// Tokens of room available for the prompt: the window minus the generation reserve.
// Compaction targets this so kept history + recap leave room for the model's reply.
// Guards a nonsensical reserve ≥ window by falling back to half the window.
function availTokens(window: number, minGen: number): number {
  const avail = window - minGen;
  return avail > 0 ? avail : Math.floor(window / 2);
}

// The calibrated prompt-token count at which compaction should fire: just under the room
// left once the generation reserve is set aside. Exported for tests and the loop's gauge.
export function compactThreshold(window: number, minGen = DEFAULT_MIN_GEN_TOKENS): number {
  return availTokens(window, minGen) * COMPACT_SAFETY;
}

export function shouldCompact(
  promptTokens: number,
  contextWindow?: number,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): boolean {
  return !!contextWindow && promptTokens > compactThreshold(contextWindow, minGen);
}

// Collapse older turns into a single `compaction` message, in place, so the request fits
// the window. Keeps as much recent history verbatim as fits the keep budget (snapped to a
// user-message boundary, so no tool result is ever split from its tool_call) and condenses
// the rest into a size-bounded recap. Returns the number of messages removed (0 = nothing
// safe to do). Lossless by reference: raw tool payloads stay in the PayloadStore.
export function compactHistory(
  history: Message[],
  contextWindow: number,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): number {
  if (!contextWindow) return 0;
  // Budgets are in chars but the window is in tokens; divide by the learned char→token
  // calibration so "30% of the available window" holds in *real* tokens, not the
  // heuristic's. Sized off the available room (window − reserve) so the result fits under
  // the trigger even when the reserve is a large fraction of a small window.
  const calib = calibration > 0 ? calibration : 1;
  const avail = availTokens(contextWindow, minGen);
  const keepBudget = (avail * CHARS_PER_TOKEN * KEEP_FRACTION) / calib;

  // Walk back from the end, keeping recent messages until the keep budget is spent.
  let chars = 0;
  let keepFrom = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    chars += msgChars(history[i]);
    if (chars > keepBudget) break;
    keepFrom = i;
  }
  // Snap keepFrom back to the start of its tool-call group so a kept tool result is never orphaned
  // from the assistant tool_call it answers (a bare leading tool message is an API error). Walking
  // *back* to a group boundary — rather than the old *forward* snap to a user message — is what lets
  // compaction engage *within* a single long turn. Plan-mode exploration is one user message
  // followed by dozens of tool rounds with no later user boundary; the old rule found none, clamped
  // to "keep everything", and the request grew unbounded until the server rejected it.
  while (keepFrom > 0 && history[keepFrom].role === 'tool') keepFrom--;
  // Preserve the original request verbatim: if the conversation opens with the user's task, keep it
  // at index 0 and recap only what follows — a long exploration must never compact away the very
  // thing it's planning for. A leading slash-command echo (meta) is not the task, so don't pin it.
  const first = history[0];
  const recapStart = first && first.role === 'user' && !first.meta ? 1 : 0;
  if (keepFrom <= recapStart) return 0;

  const recap = buildRecap(history.slice(recapStart, keepFrom), avail, calib);
  history.splice(recapStart, keepFrom - recapStart, { role: 'compaction', content: recap });
  return keepFrom - recapStart;
}

// EXPERIMENT (REIKA_PREFIX_STABLE, issue #69): batch payload aging. In prefix-stable mode payloads
// stay live (byte-frozen via `rendered`) instead of collapsing to summary the round after they
// arrive — so between shrink events consecutive requests are append-only and the inference engine's
// prompt-prefix cache holds, instead of re-processing from the aging boundary every round (or, on
// SWA/hybrid-memory models, re-processing the FULL prompt every round). The cost is paid here, in
// one batch: when the request estimate crosses the same threshold compaction uses, age oldest-first
// (payloads to summary, old reasoning dropped) down to a lower watermark — one amortized
// cache invalidation instead of a per-round one, with hysteresis so it doesn't re-fire immediately.
// Marks are set on the shared message objects ON PURPOSE (unlike compactHistory's per-turn splice):
// the next user turn re-seeds history from the same objects, so liveness and the frozen bytes carry
// across turns and the new turn's first request stays prefix-aligned with the previous one.
export const AGE_LOW_FRACTION = 0.7;

export function batchAgePayloads(
  history: Message[],
  estimate: () => number, // calibrated request-token estimate; re-read after each mark
  contextWindow: number,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): number {
  const threshold = compactThreshold(contextWindow, minGen);
  if (estimate() <= threshold) return 0;
  const target = threshold * AGE_LOW_FRACTION;
  // Never age the active round: the trailing tool block is what the model is about to act on, and
  // the assistant message that issued those calls keeps its reasoning (some providers require the
  // active roundtrip's reasoning_content — see toolcall.ts).
  const protect = protectedTailStart(history);
  let marked = 0;
  for (let i = 0; i < protect; i++) {
    if (estimate() <= target) break;
    const m = history[i];
    if (m.role === 'assistant' && m.reasoning && !m.reasoningAged) {
      m.reasoningAged = true;
      marked++;
    } else if (m.role === 'tool' && m.payload && !m.aged) {
      m.aged = true;
      delete m.rendered;
      marked++;
    }
  }
  return marked;
}

// Index of the assistant message that issued the trailing tool block's calls (or the final
// assistant message when the history ends without tool results) — everything from there on is the
// active roundtrip and must not be aged.
function protectedTailStart(history: Message[]): number {
  let i = findFreshToolBlockStart(history) - 1;
  while (i >= 0 && history[i].role !== 'assistant') i--;
  return i >= 0 ? i : 0;
}

// Approximate the characters a message contributes to a request (at rest: tool payloads
// are already summarized by aging, so only the summary counts).
function msgChars(m: Message): number {
  switch (m.role) {
    case 'user':
      return m.content.length;
    case 'assistant':
      return (
        (m.content?.length ?? 0) +
        (m.reasoning?.length ?? 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)
      );
    case 'tool':
      return m.summary.length;
    case 'compaction':
      return m.content.length;
    default:
      return 0;
  }
}

// Deterministic recap of an older span — selection, not generation. Each turn's intent and
// conclusion, aggregate tool usage, and files touched, bounded to RECAP_FRACTION of the
// window: when there's more than fits, the most recent turns are kept and the rest are
// noted as a count. Any prior recap in the span is carried forward.
function buildRecap(span: Message[], avail: number, calib: number): string {
  const recapBudget = (avail * CHARS_PER_TOKEN * RECAP_FRACTION) / calib;
  const priorRecaps: string[] = [];
  const entries: string[] = [];
  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();
  let pending: string | null = null;

  const flush = (): void => {
    if (pending !== null) {
      entries.push(pending);
      pending = null;
    }
  };

  for (const m of span) {
    if (m.role === 'compaction') {
      priorRecaps.push(m.content);
    } else if (m.role === 'user' && !m.meta) {
      // Skip slash-command echoes — they're UI-only and must not re-enter context via the recap.
      flush();
      pending = `- User: ${trunc(m.display ?? m.content)}`;
    } else if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
        const p = tc.args.path;
        if (typeof p === 'string') files.add(p);
      }
      if (m.content?.trim()) {
        const line = `  → ${trunc(m.content)}`;
        pending = pending ? `${pending}\n${line}` : line;
      }
    }
  }
  flush();

  // Keep the most recent entries that fit the recap budget; count the rest as omitted. The newest
  // entry is TRIMMED to fit rather than exempted from the budget. Exempting it (the old
  // `&& kept.length > 0` guard) assumed entries are turn-sized, but an entry breaks only on a user
  // message — so one long agent turn is a SINGLE entry, and a recap that was supposed to free the
  // window came back many times its own budget (measured: 52k chars against a 6.3k budget on an
  // 800-round turn, i.e. most of a 16k window still spent right after the pass meant to reclaim it).
  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const len = entries[i].length + 1;
    if (used + len > recapBudget) {
      if (kept.length === 0) {
        const fitted = fitEntry(entries[i], Math.max(0, recapBudget - 1));
        if (fitted) {
          kept.unshift(fitted);
          used += fitted.length + 1;
        }
        omitted = i;
      } else {
        omitted = i + 1;
      }
      break;
    }
    kept.unshift(entries[i]);
    used += len;
  }

  const out: string[] = [];
  if (priorRecaps.length > 0) out.push(priorRecaps.join('\n\n'));
  if (omitted > 0) out.push(`(+${omitted} earlier turn${omitted === 1 ? '' : 's'} condensed)`);
  if (kept.length > 0) out.push(kept.join('\n'));

  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
  if (toolSummary) out.push(`Tools used: ${toolSummary}`);
  if (files.size > 0) {
    // Cap the file list so the recap can't grow unbounded with a long session.
    const sorted = [...files].sort();
    const shown = sorted.slice(0, 25).join(', ');
    const extra = sorted.length > 25 ? `, +${sorted.length - 25} more` : '';
    out.push(`Files touched: ${shown}${extra}`);
  }
  out.push('(Older tool outputs were omitted here but can be re-read on demand.)');

  return out.join('\n\n');
}

// Trim one recap entry to `budget` chars. The header (the `- User:` intent line) is what makes an
// entry legible at all, so it is kept and the entry's own `→` rounds are dropped oldest-first —
// the most recent rounds are the ones that describe where the turn actually got to. Returns null
// when not even the header fits, in which case the caller keeps nothing rather than a fragment.
function fitEntry(entry: string, budget: number): string | null {
  if (entry.length <= budget) return entry;
  const all = entry.split('\n');
  // An entry only has a header when its turn's user message was inside the recapped span. It often
  // isn't — compactHistory pins the task verbatim at the front of the history instead — and then
  // line 0 is just the OLDEST round. Treating that as a header would keep precisely the round least
  // worth keeping, so the header is recognised by its marker rather than by position.
  const hasHeader = all[0]?.startsWith('- ');
  const header = hasHeader ? all[0] : null;
  const rounds = hasHeader ? all.slice(1) : all;
  if (header !== null && header.length > budget) return null;
  const keptRounds: string[] = [];
  let used = header !== null ? header.length : 0;
  let dropped = rounds.length;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const len = rounds[i].length + 1;
    // Reserve room for the condensed-count line this will need.
    if (used + len > budget - 32) break;
    keptRounds.unshift(rounds[i]);
    used += len;
    dropped = i;
  }
  const note = dropped > 0 ? [`  (+${dropped} round${dropped === 1 ? '' : 's'} condensed)`] : [];
  const out = [...(header !== null ? [header] : []), ...note, ...keptRounds];
  return out.length > 0 ? out.join('\n') : null;
}

function trunc(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? flat.slice(0, MAX_TEXT - 1) + '…' : flat;
}

// The actual findings — tool results (file contents, search matches) carry the concrete facts a
// grounded plan needs (real paths, the exact line to change). The model's per-turn reasoning is
// mostly narration ("let me look at X"); without the findings the transform hallucinates paths and
// reverts to generic boilerplate. We reframe the results as static *reference material* rather than
// a conversation, so they ground the plan without re-creating "let me read one more file" momentum.
// Findings within a char budget so the transform request fits the window. On a large task the
// model may read far more than the window holds; grant full payloads newest-first (the most recent
// reads are usually the ones the converged plan rests on) until the budget is spent, and degrade
// older reads to summary-only. The model keeps a navigable map of everything plus full grounding
// for the recent files — graceful degradation instead of a 400. Lives here (not loop.ts) so the
// handoff distillation below can reuse it without an import cycle (loop → compaction).
export function gatherPlanFindings(history: Message[], charBudget: number): string {
  const tools = history.filter((m): m is Message & { role: 'tool' } => m.role === 'tool');
  const full = new Set<Message>();
  let used = 0;
  for (let i = tools.length - 1; i >= 0; i--) {
    const body = tools[i].payload?.trim();
    if (!body) continue;
    const cost = tools[i].summary.length + body.length + 8;
    if (used + cost > charBudget) break;
    full.add(tools[i]);
    used += cost;
  }
  let summarized = 0;
  const parts = tools.map(m => {
    const body = m.payload?.trim();
    if (body && full.has(m)) return `── ${m.summary}\n${body}`;
    if (body) summarized++;
    return `── ${m.summary}`;
  });
  if (summarized > 0) {
    parts.unshift(
      `(reika: ${summarized} earlier file read(s) shown as summary only to fit the context window)`,
    );
  }
  return parts.join('\n\n');
}

// Fold the plan-mode exploration that precedes a written plan into a single compaction message, in
// place, so the agent turn that executes the plan sees the plan verbatim (the anchor) plus a compact
// findings digest instead of the full raw read/grep transcript. On the small windows reika targets
// that transcript otherwise competes with the agent's own edit/verify loop and pushes the plan back
// until it's compacted away or attended to weakly. Keeps (a) the original request verbatim at index 0
// and (b) the plan-final assistant message verbatim — everything between is distilled. Mirrors
// compactHistory: mutates the per-turn model copy of history, leaving UI scrollback untouched, so it
// re-runs deterministically each turn. A no-op (folded=0) when there's no plan-final marker (every
// normal agent turn), an empty span, or an already-distilled span (idempotent on re-runs); `reason`
// names which so a silent zero is classifiable during the experiment's A/B, not guessed at.
export type HandoffOutcome = {
  folded: number;
  reason: 'folded' | 'no-marker' | 'empty-span' | 'already-distilled' | 'no-steps';
};

export function distillPlanHandoff(
  history: Message[],
  contextWindow: number | undefined,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
  findingsBudgetFraction = HANDOFF_FINDINGS_FRACTION,
): HandoffOutcome {
  // The converged plan we anchor on: the most recent plan-final message. Its absence is what makes
  // this a no-op on ordinary agent turns (the marker is set only at plan-mode force-write).
  let planIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.planFinal) {
      planIdx = i;
      break;
    }
  }
  if (planIdx < 0) return { folded: 0, reason: 'no-marker' };

  // The marker says the plan turn ENDED, not that it produced a plan: loop.ts stamps it on any
  // final plan-mode message, force-written spirals included (#126). Anchoring on a message with no
  // parsed steps is the worst of both worlds — the exploration that might have grounded the next
  // turn gets folded into a digest, and what survives verbatim is "I couldn't determine…". Leave
  // history alone instead; an un-distilled turn is merely bigger, not misleading. Same 0-step
  // definition `seedPlanProgress` has always used, so the two agree about what a plan is.
  const planMsg = history[planIdx];
  if (planMsg.role === 'assistant' && parsePlanSteps(planMsg.content ?? '').length === 0) {
    return { folded: 0, reason: 'no-steps' };
  }

  // Pin the original request at index 0 exactly as compactHistory does; fold only what follows it,
  // up to (but excluding) the plan message. A leading slash-command echo (meta) is not the task.
  const first = history[0];
  const spanStart = first && first.role === 'user' && !first.meta ? 1 : 0;
  // Plan written with no exploration in front of it — nothing to fold.
  if (planIdx <= spanStart) return { folded: 0, reason: 'empty-span' };
  const span = history.slice(spanStart, planIdx);
  // Already distilled (the span is just a prior compaction message): nothing to fold. This is the
  // idempotency guard for the re-run each agent turn does on a freshly re-seeded history.
  if (span.every(m => m.role === 'compaction')) return { folded: 0, reason: 'already-distilled' };

  // Budget mirrors loop.ts's transform budget: a fraction of the available window, in chars,
  // divided by the learned char→token calibration so the fraction holds in real tokens. No window
  // known → keep everything verbatim (the positional-salience benefit still applies).
  const calib = calibration > 0 ? calibration : 1;
  const findingsBudget = contextWindow
    ? Math.floor(
        (availTokens(contextWindow, minGen) * CHARS_PER_TOKEN * findingsBudgetFraction) / calib,
      )
    : Number.MAX_SAFE_INTEGER;

  const digest = buildHandoffDigest(span, findingsBudget);
  history.splice(spanStart, span.length, { role: 'compaction', content: digest });
  return { folded: span.length, reason: 'folded' };
}

// Deterministic plan-handoff digest: a one-line index of files examined during planning (so the
// agent knows what's already been seen without the raw payloads), any prior compaction recap in the
// span carried forward (so a compaction that fired *during* plan mode isn't dropped), then the
// findings themselves — newest reads verbatim within budget, older ones summary-only — via
// gatherPlanFindings.
function buildHandoffDigest(span: Message[], findingsBudget: number): string {
  const files = new Set<string>();
  const priorRecaps: string[] = [];
  for (const m of span) {
    if (m.role === 'compaction') {
      priorRecaps.push(m.content);
    } else if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        const p = tc.args.path;
        if (typeof p === 'string') files.add(p);
      }
    }
  }
  const out: string[] = ['Plan-mode exploration (distilled at handoff).'];
  if (files.size > 0) {
    // Cap the file list the same way buildRecap does, so the index can't grow unbounded.
    const sorted = [...files].sort();
    const shown = sorted.slice(0, 25).join(', ');
    const extra = sorted.length > 25 ? `, +${sorted.length - 25} more` : '';
    out.push(`Files examined: ${shown}${extra}`);
  }
  if (priorRecaps.length > 0) out.push(priorRecaps.join('\n\n'));
  const findings = gatherPlanFindings(span, findingsBudget);
  if (findings.trim()) out.push(`Findings:\n${findings}`);
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------
// Self-healing restart (issue #137)
// ---------------------------------------------------------------------------

// The prompt the user actually typed for the turn in progress — the last `user` message that is
// neither a slash-command echo (`meta`) nor harness scaffolding (`harness`). Both exclusions matter
// here: a restart that rebuilds the conversation around "(your reasoning was repeating…)" would
// hand the model a nudge as its goal.
export function lastUserRequest(history: Message[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && !m.meta && !m.harness) return m.content;
  }
  return null;
}

export type RestartHistory = {
  // The replacement history — short, ordered, and structurally a fresh conversation.
  history: Message[];
  // The digest text, for the debug line.
  digest: string;
  // Whether a converged plan was carried through untouched.
  carriedPlan: boolean;
};

// Rebuild the turn as a clean conversation: a bounded digest of what happened, the user's request
// verbatim, and any converged plan verbatim after it.
//
// Verbatim is doing real work in both cases. The digest summarizes the *work*; the request is
// copied through untouched because on a small window a paraphrased goal drifts, and a restart that
// loses the goal is worse than the honest stop it replaced. A converged plan is carried the same
// way for a different reason: the plan already DID the exploring for this problem, so it is the
// surviving deliverable rather than exploration to be folded — digesting it would discard the one
// artifact the spiral didn't destroy. Same principle as distillPlanHandoff above, at a later
// boundary.
//
// The result is deliberately small, which is also why this and ordinary compaction are ONE pass
// rather than two: a restart under context pressure already ends below any threshold compaction was
// about to fire on, so the caller skips the compaction it would otherwise have run (loop.ts).
//
// `applied` is the formatted applied-changes ledger from selfheal.ts — built from tool results, and
// passed in rather than derived here so this module stays free of edit-tool knowledge.
//
// Returns null when there is no user request to rebuild around: with nothing to restate, a restart
// would produce a conversation with no goal, and the caller should fall through to the honest stop.
export function buildRestartHistory(
  history: Message[],
  opts: {
    attempt: number;
    maxAttempts: number;
    contextWindow?: number;
    calibration?: number;
    minGen?: number;
    applied?: string;
  },
): RestartHistory | null {
  const request = lastUserRequest(history);
  if (request === null) return null;

  // Locate the two messages carried verbatim so the recap doesn't restate them in truncated form.
  let requestIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && !m.meta && !m.harness) {
      requestIdx = i;
      break;
    }
  }
  let planIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.planFinal) {
      planIdx = i;
      break;
    }
  }

  const span = history.filter((_, i) => i !== requestIdx && i !== planIdx);
  const calib = opts.calibration && opts.calibration > 0 ? opts.calibration : 1;
  const window = opts.contextWindow ?? 0;
  const avail = window
    ? availTokens(window, opts.minGen ?? DEFAULT_MIN_GEN_TOKENS)
    : // No declared window: fall back to the recap's own budget at a conservative default rather
      // than an unbounded digest, which is the one outcome a restart cannot afford.
      DEFAULT_MIN_GEN_TOKENS * 4;
  // buildRecap enforces its own budget, including on the newest entry — which matters here more
  // than anywhere, since a spiral is one long turn and the restart is the pass that has to end
  // BELOW the compaction threshold. `restart.test.ts` pins that bound from this side regardless of
  // which layer provides it.
  const recap = buildRecap(span, avail, calib);

  const parts = [
    `[Restarted — attempt ${opts.attempt} of ${opts.maxAttempts}. The previous attempt stopped ` +
      `making progress and its conversation was reset. This is a clean start with the same goal.]`,
    `What happened before the reset:\n${recap}`,
  ];
  if (opts.applied) parts.push(opts.applied);
  parts.push(
    'How to proceed:\n' +
      '- The request below is the goal. Work from it, not from what was tried before.\n' +
      '- Check the current state of any file listed above before editing it again.\n' +
      '- Take a different approach than the summary describes — the earlier one did not converge.',
  );
  const digest = parts.join('\n\n');

  const rebuilt: Message[] = [
    { role: 'compaction', content: digest },
    { role: 'user', content: request },
  ];
  if (planIdx >= 0) {
    const plan = history[planIdx];
    if (plan.role === 'assistant') rebuilt.push({ ...plan });
  }

  return { history: rebuilt, digest, carriedPlan: planIdx >= 0 };
}
