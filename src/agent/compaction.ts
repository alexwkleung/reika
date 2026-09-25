import type { Message, ToolCall } from '../types.js';
import { compactionNoteHeader } from './compactionreport.js';
import { DEFAULT_MIN_GEN_TOKENS } from '../provider/budget.js';
import {
  TASK_SPEC_PIN_CHARS,
  agedContentChars,
  findFreshToolBlockStart,
  lastUserMessageIndex,
  taskSpecIndex,
} from '../provider/toolcall.js';
import { latestPlanMarker } from './plantrack.js';
import { parseSavedPage } from '../tools/fetch.js';
import { parseSearchQuery } from '../tools/search.js';

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
// `note` (#280): the model's own compaction note, written on the report round just before this
// fold. When present it leads the recap and supersedes any prior fold's narrative — the model saw
// that narrative when it wrote the note, and was told to carry forward what still matters — so the
// recap never stacks (#275). The read ledger still follows it, under what budget is left: the note
// says what was found, the ledger says what was opened.
export type CompactionNote = { n: number; text: string };

// Where a fold would cut, or null when there is nothing to fold. Split out of compactHistory so
// the compaction report round (#280) can ask "will this fold actually remove anything?" before
// spending a model call on a note: under PREFIX_STABLE the batch-age shed often gets the request
// under the threshold on its own and the keep-budget walk then keeps everything (observed:
// `compaction-report n=1 chars=1909` followed by `compaction removed=0`, twice — two notes written
// into nothing, and the fold counter never moved).
export function foldPoint(
  history: Message[],
  contextWindow: number,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): { recapStart: number; keepFrom: number; avail: number; calib: number } | null {
  if (!contextWindow) return null;
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
  if (keepFrom <= recapStart) return null;
  return { recapStart, keepFrom, avail, calib };
}

export function wouldFold(
  history: Message[],
  contextWindow: number,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
): boolean {
  return foldPoint(history, contextWindow, calibration, minGen) !== null;
}

// Will this shrink event end in a fold? Answered BEFORE the batch-age shed runs, on a throwaway
// copy of the history, so the compaction note (#280) can be written from the live bytes it is
// about to lose and as a pure append on the previous request — measured at the first live fold
// after #428, the note written post-shed paid the shed's mid-history rewrite (9k tokens, 416s)
// and the fold then paid its own (9.3k, 431s): two full invalidations in one event, where the
// note request could have been the ~1.5k-token append it is when the shed lands on the real
// request instead. The decision is the loop's own, replayed: once the event fires, the shed stops
// at the low watermark or runs out of candidates, and the fold follows exactly when the estimate
// is still above that watermark — `shouldCompact || agedButAboveWatermark` reduces to that — and
// the fold-point walk keeps something to fold. Shallow copies are enough: the shed only sets
// per-message marks (`aged`, `reasoningAged`, `rendered`, a spent continuation's content), and the
// walks read fields, never identity. Callers pass the calibrated estimate they would shed under.
export function foldAfterShed(
  history: Message[],
  estimate: (h: Message[]) => number,
  contextWindow: number,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
  shedReasoning = true,
  // `/compact` (#481) folds on request, not on pressure: its gate is only "will the fold remove
  // anything", so it drops the watermark half of the event decision.
  requirePressure = true,
): boolean {
  const copy = history.map(m => ({ ...m }));
  batchAgePayloads(copy, () => estimate(copy), contextWindow, minGen, shedReasoning);
  const target = compactThreshold(contextWindow, minGen) * AGE_LOW_FRACTION;
  if (requirePressure && estimate(copy) <= target) return false;
  return wouldFold(copy, contextWindow, calibration, minGen);
}

export function compactHistory(
  history: Message[],
  contextWindow: number,
  calibration = 1,
  minGen = DEFAULT_MIN_GEN_TOKENS,
  note?: CompactionNote,
): number {
  const point = foldPoint(history, contextWindow, calibration, minGen);
  if (!point) return 0;
  const { recapStart, keepFrom, avail, calib } = point;

  // #251: carry the turn's task-defining payload THROUGH the fold, verbatim. batchAgePayloads
  // already exempts it from aging (#227), but compaction removed it outright, and the recap records
  // that a tool ran — not what it returned. The model then reasons correctly from what it was left
  // ("the summary says 'Tools used: 5 bash, 4 read' ... I need to re-run the bash calls") and
  // re-fetches; the re-fetch re-inflates the estimate and triggers the NEXT compaction. Measured on
  // a 3h29m `/review` that compacted at rounds 9 and 12 and never produced a review.
  //
  // Carried as text inside the recap rather than by keeping the tool message: a tool result may not
  // lead a request, its assistant parent may have issued sibling calls whose responses are being
  // folded, and an unmatched tool_call is an API error. Text has none of those failure modes.
  //
  // No extra bound needed — every candidate is capped at TASK_SPEC_PIN_CHARS, so this is a few KB at
  // most. Note the elected spec stops being findable by taskSpecIndex afterwards (that looks for a
  // `tool` message), so `spec-pin none` after a compaction is expected, not a regression: the
  // content is in the recap, and the next turn's opening call becomes the new pin.
  //
  // #275: elect ONCE per turn, at the first fold. Every later fold re-runs the election with the
  // winner already folded into a `compaction` message — invisible to taskSpecIndex — so it pinned
  // whatever small tool result had arrived since (a 13-line file read, then a grep of AGENTS.md)
  // under a header asserting it is the task. The first fold is also the only one whose ballot still
  // held the real spec, so its answer is the one to keep.
  const span = history.slice(recapStart, keepFrom);
  const preserved = carriedSpecBlock(span) ?? electSpecBlock(history, recapStart, keepFrom);

  const recap = buildRecap(span, avail, calib, note);
  history.splice(recapStart, keepFrom - recapStart, {
    role: 'compaction',
    content: preserved ? `${preserved}\n\n${recap}` : recap,
  });
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
// How far below the threshold each shrink event sheds. This is the lever issue #253 identified and
// deliberately did NOT pick a value for: shedding further means fewer events across a run (each one
// re-processes most of the prompt — three of them were ~24 min of a 2h15m run), at the cost of a
// smaller live working set between events, which #251 showed is exactly what keeps the model on
// task. Both sides are real, so it is env-tunable to be MEASURED (evals/prefixcost-report.ts is the
// instrument) rather than argued about; the default is unchanged.
export const AGE_LOW_FRACTION = ageLowFraction();

// Clamped, not trusted: above ~0.95 an event sheds nothing and re-fires the next round (consecutive
// full re-processes, the pattern batching exists to prevent), and below ~0.3 the event throws away
// most of the live context in one step. A malformed value falls back to the default rather than
// silently disabling aging.
function ageLowFraction(): number {
  const raw = Number(process.env.REIKA_AGE_LOW_FRACTION);
  if (!Number.isFinite(raw) || raw < 0.3 || raw > 0.95) return 0.7;
  return raw;
}

// A payload below this contributes too little relief to be worth risking a re-read on. An event
// sheds tens of thousands of chars; 2000 (~500 tokens, ~2% of a 24k window) cannot plausibly be the
// mark that tips the estimate under the watermark, while losing it can cost a whole round. Chars,
// not tokens, deliberately — it is compared against `payload.length`, and the threshold's token
// units are a different scale.
const SMALL_PAYLOAD_CHARS = 2000;

// What one shrink event did. `kept` is the number that says whether the size floor actually changed
// anything this event: small payloads the first sweep skipped and the second never had to take. A
// run where every event reports kept=0 exercised none of #257 — which is otherwise indistinguishable
// in a log from "it engaged and didn't help", the ambiguity that makes an A/B unreadable.
export type AgeResult = {
  // Total marks, reasoning included — what the estimate actually shed.
  marked: number;
  // Payloads aged at or above the floor (first sweep) vs below it (second sweep, needed anyway).
  bulk: number;
  crumbs: number;
  kept: number;
  // Tokens still over the low watermark when the sweeps ran out of candidates; 0 when the event
  // reached it. Non-zero is what escalates to a fold in the same round (loop.ts,
  // `agedButAboveWatermark`), and without it a log cannot say whether aging fell an inch short or a
  // mile — the difference between "the crumb exemption cost us this fold" and "there was nothing
  // sheddable left". Reconstructing it by hand from payload sizes is what it replaces.
  short: number;
};

export function batchAgePayloads(
  history: Message[],
  estimate: () => number, // calibrated request-token estimate; re-read after each mark
  contextWindow: number,
  minGen = DEFAULT_MIN_GEN_TOKENS,
  // Whether marking reasoning can still move the estimate this sweep is chasing. False once the
  // endpoint has demanded every reasoning byte back (latches.ts): serialization then keeps
  // reasoning whatever `reasoningAged` says, so a mark would shed nothing while still costing the
  // sweep a pass — and `marked` would report a shed that never happened.
  shedReasoning = true,
): AgeResult {
  const threshold = compactThreshold(contextWindow, minGen);
  const none: AgeResult = { marked: 0, bulk: 0, crumbs: 0, kept: 0, short: 0 };
  if (estimate() <= threshold) return none;
  const target = threshold * AGE_LOW_FRACTION;
  // Never age the active round: the trailing tool block is what the model is about to act on, and
  // the assistant message that issued those calls keeps its reasoning (some providers require the
  // active roundtrip's reasoning_content — see toolcall.ts).
  const protect = protectedTailStart(history);
  // #227: the turn's task-defining payload is exempt. Aging is oldest-first and a skill that
  // mandates a spec fetch as its opening call puts that payload at the front of the queue, so
  // without this the definition of the task is always the first thing dropped — and an aged
  // summary reads as "already handled", not as content that is gone.
  const specIdx = taskSpecIndex(history);
  // Two sweeps, oldest-first within each: shed bulk before crumbs. Aging is otherwise strictly
  // oldest-first regardless of size, which on a measured 2h run aged `src/cli.tsx` — 673 bytes, 0.7%
  // of a 24k window — in an event that shed 18,935 chars. The model re-read it, twice, and each
  // re-read costs a full round-trip AND puts the payload straight back in the window, pulling the
  // next shrink event forward. That is a feedback loop paid for in whole rounds to reclaim
  // rounding error.
  //
  // The floor only reorders: the second sweep ages the small payloads too, so it can never keep the
  // event from reaching its watermark — the worst case is the previous behavior. Reasoning is aged
  // in the first sweep regardless of size, because dropping it can't provoke a re-read (the model
  // cannot re-fetch its own reasoning) and so carries none of this risk.
  const out: AgeResult = { marked: 0, bulk: 0, crumbs: 0, kept: 0, short: 0 };
  // `kept` is counted at the end over what survived, not decremented as the sweeps run: a payload
  // skipped by the first sweep and taken by the second was never kept, and tracking that by hand is
  // exactly the bookkeeping that drifts.
  const survivingCrumbs = (): number => {
    let n = 0;
    for (let i = 0; i < protect; i++) {
      if (i === specIdx) continue;
      const m = history[i];
      if (m.role === 'tool' && m.payload && !m.aged && m.payload.length < SMALL_PAYLOAD_CHARS) n++;
    }
    return n;
  };
  // Spent continuation tails go BEFORE either size sweep (#284). The sweeps are oldest-first, so a
  // branch inside them would still lose the race to any older tool payload — and this is the one
  // thing in the window that is strictly cheaper to drop than anything else. A carried tail cannot
  // provoke a re-read (the model cannot re-fetch its own thinking, the same reason reasoning ages
  // first) and, being here at all, has already been superseded: `protect` starts at the assistant
  // message opening the active roundtrip, so while the continuation this tail feeds is still live
  // the tail IS that message and this loop never reaches it. Promoting the tail into `content` is
  // what makes it visible to the chat template; this is what keeps that promotion from becoming a
  // standing window cost only a fold could clear.
  for (let i = 0; i < protect; i++) {
    if (estimate() <= target) {
      out.kept = survivingCrumbs();
      return out;
    }
    const m = history[i];
    if (m.role === 'assistant' && m.continuationTail && m.content !== CONTINUATION_SHED_NOTE) {
      m.content = CONTINUATION_SHED_NOTE;
      out.marked++;
    }
  }
  for (const takeCrumbs of [false, true]) {
    for (let i = 0; i < protect; i++) {
      if (estimate() <= target) {
        out.kept = survivingCrumbs();
        return out;
      }
      if (i === specIdx) continue;
      const m = history[i];
      if (m.role === 'assistant' && m.reasoning && !m.reasoningAged) {
        if (!shedReasoning) continue;
        m.reasoningAged = true;
        out.marked++;
      } else if (m.role === 'tool' && m.payload && !m.aged) {
        if (!takeCrumbs && m.payload.length < SMALL_PAYLOAD_CHARS) continue;
        m.aged = true;
        delete m.rendered;
        out.marked++;
        if (takeCrumbs) out.crumbs++;
        else out.bulk++;
      }
    }
  }
  out.kept = survivingCrumbs();
  // Ran out of candidates while still over: everything sheddable outside the protected tail is
  // aged, and what remains is the active round plus whatever the floors hold.
  out.short = Math.max(0, Math.round(estimate() - target));
  return out;
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
// are already summarized by aging, so only the summary counts). The one message this under-prices
// is the pinned task spec (#227), which still carries its payload; bounded by TASK_SPEC_PIN_CHARS,
// so the keep-budget walk stays close enough.
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
      // An aged payload is not always just its summary: it may carry a bounded skeleton, or (under
      // the crossover where the skeleton costs more than the bytes) the payload itself. Pricing
      // those at the summary tells the walk it freed chars it did not, and it stops shedding early.
      return m.aged ? agedContentChars(m) : m.summary.length;
    case 'compaction':
      return m.content.length;
    default:
      return 0;
  }
}

// The recap's closing pointer. A single constant because a carried-forward recap already ends with
// it: appended unconditionally, N folds produced N identical notes (#247).
const OMISSION_NOTE = '(Older tool outputs were omitted here but can be re-read on demand.)';

// What a spent continuation tail collapses to. Kept as a short note rather than an empty string so
// the turn still reads as "there was work here that has been acted on", and so the shed is
// idempotent — the sweep recognizes its own marker instead of re-marking a tail every event.
export const CONTINUATION_SHED_NOTE =
  '(reika: earlier cut-off reasoning was continued and is no longer carried.)';

// Tools whose `path` argument names a file the turn actually worked on. `list` takes a DIRECTORY
// and grep/glob take a search ROOT, so reading the file list off "any call with a path arg" put
// bare `src` in it — a wrong entry that reads as a handled file (#247).
const FILE_TOOLS = new Set(['read', 'edit', 'write']);

// How many line ranges are spelled out per file before the rest become a count.
const MAX_RANGES = 3;
// Pages listed on the recap's "Pages fetched" line. Each entry is a URL plus a locator, ~100
// chars, so ten is the same order of bytes as the 25-file cap above.
const MAX_PAGES = 10;
// Queries listed on the recap's "Web searches run" line. A query is a few words, so ten is a
// fraction of what either list above costs.
const MAX_SEARCHES = 10;

// Share of the recap budget a carried-forward recap may occupy (#275). Half: the earlier session and
// this fold's own turns each keep a floor, so neither the deep history nor the recent work can be
// squeezed out by the other however many times a session folds.
const PRIOR_RECAP_SHARE = 0.5;

// Strip trailing copies of the closing pointer from a carried-forward recap, so the one appended
// at the end of this recap is the only one.
function stripOmissionNote(content: string): string {
  let out = content.trimEnd();
  while (out.endsWith(OMISSION_NOTE)) out = out.slice(0, -OMISSION_NOTE.length).trimEnd();
  return out;
}

// The preserved task definition that leads a recap (#251), and the closing line that bounds it so a
// later fold can find the whole block and carry it forward instead of electing a second one (#275).
// One block per recap, always at the front, always under TASK_SPEC_PIN_CHARS.
const SPEC_BLOCK_END = '(End of the preserved task definition; the recap of earlier work follows.)';

// The three things the block can hold, most trustworthy first. Only the first two make the strong
// claim, and both have earned it: a skill mandates its opening call (`/issue`, `/review` both fetch
// the spec first), and the user's own message IS the task. The third is elected by position alone —
// `taskSpecIndex` knows nothing about skills — so it says what is actually true and no more. A wrong
// claim under a header this assertive costs more than the content is worth (#275).
const SPEC_HEADER_SKILL =
  'The task this turn is working on, kept verbatim through the compaction ' +
  '(this is the real output, not a summary of it):';
const SPEC_HEADER_USER =
  'The task this turn is working on, kept verbatim through the compaction ' +
  "(the user's own request, not a summary of it):";
const SPEC_HEADER_FIRST =
  "This turn's first tool output, kept verbatim through the compaction (this is the real output, " +
  'not a summary of it). It is what ran first, which is not necessarily a statement of the task:';
const SPEC_HEADERS = [SPEC_HEADER_SKILL, SPEC_HEADER_USER, SPEC_HEADER_FIRST];

function specBlock(header: string, body: string): string {
  return `${header}\n\n${body}\n\n${SPEC_BLOCK_END}`;
}

// Split a recap into its leading preserved block (if any) and the narrative after it. Recognised by
// its own header at the front plus the closing line — not by "contains a header", so a header
// quoted inside a payload can't make the rest of the recap disappear.
function splitSpecBlock(content: string): { block?: string; rest: string } {
  const text = content.trimStart();
  if (!SPEC_HEADERS.some(h => text.startsWith(h))) return { rest: content };
  const end = text.indexOf(SPEC_BLOCK_END);
  if (end < 0) return { rest: content };
  const cut = end + SPEC_BLOCK_END.length;
  return { block: text.slice(0, cut), rest: text.slice(cut).trimStart() };
}

// The block a prior fold already elected, if one is being folded again. Its presence is what ends
// the election: the task does not change mid-turn, so re-running it can only replace a right answer
// with a newer wrong one.
function carriedSpecBlock(span: Message[]): string | undefined {
  for (const m of span) {
    if (m.role !== 'compaction') continue;
    const { block } = splitSpecBlock(m.content);
    if (block) return block;
  }
  return undefined;
}

// Choose what this recap preserves verbatim, in the order of what the choice can be trusted to be.
// Returns undefined rather than guessing: nothing is better than a false claim, and a recap with no
// block still carries the narrative.
function electSpecBlock(
  history: Message[],
  recapStart: number,
  keepFrom: number,
): string | undefined {
  const inSpan = (i: number): boolean => i >= recapStart && i < keepFrom;
  // The skill mark rides the turn's user message, so it is readable whether or not that message is
  // itself being folded.
  const userIdx = lastUserMessageIndex(history);
  const user = userIdx >= 0 ? history[userIdx] : undefined;
  const specIdx = taskSpecIndex(history);
  const specMsg = inSpan(specIdx) ? history[specIdx] : undefined;
  const spec = specMsg?.role === 'tool' && specMsg.payload ? specMsg : undefined;

  if (user?.role === 'user' && user.skill && spec) {
    return specBlock(SPEC_HEADER_SKILL, `${spec.summary}\n\n${spec.payload}`);
  }
  // A generic multi-turn session folds the user's own request into a `- User: …` line truncated to
  // MAX_TEXT, while an arbitrary first tool payload got up to TASK_SPEC_PIN_CHARS verbatim under a
  // header calling itself the task — the inversion #251 fixed, one turn over. The request is small,
  // so keep it whole (an oversized one is a pasted dump, not a definition; let the recap have it).
  if (
    user?.role === 'user' &&
    inSpan(userIdx) &&
    user.content.length > 0 &&
    user.content.length <= TASK_SPEC_PIN_CHARS
  ) {
    return specBlock(SPEC_HEADER_USER, user.content);
  }
  // Nothing guaranteed the election, but keeping the payload still spares the re-fetch loop #251
  // measured. It ships under the weaker header.
  return spec ? specBlock(SPEC_HEADER_FIRST, `${spec.summary}\n\n${spec.payload}`) : undefined;
}

// The line range a tool result covered, read off the result SUMMARY rather than the call args:
// `read` clamps its offset/limit to the file's real length, and an edit's line is only known after
// the match is found — so the args say what was asked for and the summary says what happened.
function summaryRange(summary: string): [number, number] | null {
  const span = /\blines (\d+)-(\d+)\b/.exec(summary);
  if (span) return [Number(span[1]), Number(span[2])];
  const one = /\bat line (\d+)\b/.exec(summary);
  return one ? [Number(one[1]), Number(one[1])] : null;
}

// Record one tool result against the file it addressed. Failed and declined calls are skipped:
// naming a file the turn never actually read is the same lie as naming a directory.
function noteFile(
  files: Map<string, [number, number][]>,
  call: ToolCall | undefined,
  summary: string,
): void {
  if (!call || !FILE_TOOLS.has(call.name)) return;
  const path = call.args.path;
  if (typeof path !== 'string' || !path) return;
  if (/^\S+ (failed|declined|timeout)\b/i.test(summary)) return;
  const ranges = files.get(path) ?? [];
  const range = summaryRange(summary);
  if (range) ranges.push(range);
  files.set(path, ranges);
}

// Record a fetched page against the file it was saved to (#296). The fold drops the page's bytes
// like any other payload; what the model kept losing with them was the fact that it HAD the page —
// its next move was to fetch the same URL again, which is the loop the saved copy exists to break
// (`tools/fetch.ts`). The `·` summary line carries the locator too, but it sits inside the entry
// budget and is trimmed by round; this line rides outside it, next to "Files touched", so a page
// the session read stays addressable through every fold. Pages too small to have been saved, and
// failed fetches, have nothing to point at and are left out.
function notePage(pages: Map<string, string>, call: ToolCall | undefined, summary: string): void {
  if (call?.name !== 'fetch_url') return;
  const saved = parseSavedPage(summary);
  if (saved) pages.set(saved.url, saved.path);
}

// Record a web search's query (#297). The fold drops the result list, and rightly — the model
// usually followed one of eight links, or lifted a snippet from one, and the rest was never worth
// the window. The query is the cheap handle on that list: the tool serves a repeat of it from the
// session's saved results (`tools/search.ts`), so a model that wants the list back copies the
// string and pays nothing. As with pages, the `·` summary line has it too but sits inside the
// entry budget; this line rides outside it. Searches that found nothing have no list to come back
// to and are left out.
function noteSearch(searches: Set<string>, call: ToolCall | undefined, summary: string): void {
  if (call?.name !== 'search') return;
  const query = parseSearchQuery(summary);
  if (query) searches.add(query);
}

// Merge overlapping and adjacent ranges so five reads walking one file come back as one span
// rather than five near-identical ones.
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// `path (lines 1-40, 120-160)` — the coordinates the fold used to drop (#247). Deliberately reads
// as coverage, not as content: what was looked at, still re-readable, not what it said.
function describeFile(path: string, ranges: [number, number][]): string {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return path;
  const shown = merged.slice(0, MAX_RANGES).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  const extra = merged.length > MAX_RANGES ? `, +${merged.length - MAX_RANGES} more` : '';
  return `${path} (lines ${shown.join(', ')}${extra})`;
}

// Deterministic recap of an older span — selection, not generation. Each turn's intent, the tool
// results that made up the work, aggregate tool usage, and files touched with the ranges covered,
// bounded to RECAP_FRACTION of the window: when there's more than fits, the most recent turns are
// kept and the rest are noted as a count. Any prior recap in the span is carried forward, trimmed to
// its own share of that budget so repeated folds can't stack.
// Share of the recap budget a compaction note may take. The rest goes to the read ledger, so a
// long note still leaves "what was opened" visible — the two answer different questions.
const NOTE_SHARE = 0.7;

function buildRecap(span: Message[], avail: number, calib: number, note?: CompactionNote): string {
  const recapBudget = (avail * CHARS_PER_TOKEN * RECAP_FRACTION) / calib;
  const priorRecaps: string[] = [];
  const entries: string[] = [];
  const toolCounts: Record<string, number> = {};
  const files = new Map<string, [number, number][]>();
  const pages = new Map<string, string>();
  const searches = new Set<string>();
  // Tool calls by id, so each result can be read together with the call that produced it: the call
  // knows the tool and the path, the result knows what actually happened.
  const calls = new Map<string, ToolCall>();
  let pending: string | null = null;

  const flush = (): void => {
    if (pending !== null) {
      entries.push(pending);
      pending = null;
    }
  };
  const add = (line: string): void => {
    pending = pending ? `${pending}\n${line}` : line;
  };

  for (const m of span) {
    if (m.role === 'compaction') {
      // The preserved block is dropped here; compactHistory carries that forward itself, exactly
      // once (#275). What is left is narrative, and it goes under the budget below.
      const carried = stripOmissionNote(splitSpecBlock(m.content).rest);
      if (carried) priorRecaps.push(carried);
    } else if (m.role === 'user' && !m.meta && !m.harness) {
      // Skip slash-command echoes — they're UI-only and must not re-enter context via the recap.
      // Skip harness nudges too: a folded "(your previous response was cut off … continue
      // concisely)" used to recap as `- User: …`, which the model reads as something the human
      // asked for, in a summary that outlives the round it steered (#287). The nudge is transient
      // by design; the recap records what the turn did, not how the harness kept it moving.
      flush();
      pending = `- User: ${trunc(m.display ?? m.content)}`;
    } else if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
        calls.set(tc.id, tc);
      }
      if (m.content?.trim()) add(`  → ${trunc(m.content)}`);
    } else if (m.role === 'tool') {
      // The narrative used to come from assistant `content` alone, which on a tool-heavy
      // exploration turn is empty on EVERY message — the thinking rides in `reasoning`, which the
      // recap doesn't read. Fifteen folded messages then recapped to `Tools used: 4 read, 3 bash`
      // and nothing else (#247). The result summaries are the record of what was actually done, and
      // they already carry paths, ranges, match counts and exit status.
      noteFile(files, calls.get(m.callId), m.summary);
      notePage(pages, calls.get(m.callId), m.summary);
      noteSearch(searches, calls.get(m.callId), m.summary);
      add(`  · ${trunc(m.summary)}`);
    }
  }
  flush();

  // Keep the most recent entries that fit the recap budget; count the rest as omitted. The newest
  // entry is TRIMMED to fit rather than exempted from the budget. Exempting it (the old
  // `&& kept.length > 0` guard) assumed entries are turn-sized, but an entry breaks only on a user
  // message — so one long agent turn is a SINGLE entry, and a recap that was supposed to free the
  // window came back many times its own budget (measured: 52k chars against a 6.3k budget on an
  // 800-round turn, i.e. most of a 16k window still spent right after the pass meant to reclaim it).
  // A carried recap gets a share of the budget rather than a pass on it (#275). Outside the budget —
  // as it used to be — each fold appended its own narrative to the previous fold's verbatim and the
  // "bounded to RECAP_FRACTION" contract above held only for the newest fold: five folds of one
  // measured session grew the recap from 4.1KB to 10.1KB inside a 24k window. Trimmed rather than
  // evicted, because the oldest material is also the most condensed — dropping it whenever a newer
  // turn wants the room would erase the whole early session at the first tight fold.
  // A note supersedes the prior narrative (see CompactionNote); without one the prior is carried.
  const noteBlock = note ? fitNote(note, Math.floor(recapBudget * NOTE_SHARE)) : null;
  const priorText = note ? '' : priorRecaps.join('\n\n');
  const prior = priorText ? fitEntry(priorText, Math.floor(recapBudget * PRIOR_RECAP_SHARE)) : null;
  const entryBudget =
    recapBudget - (prior ? prior.length + 1 : 0) - (noteBlock ? noteBlock.length + 1 : 0);

  const kept: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const len = entries[i].length + 1;
    if (used + len > entryBudget) {
      if (kept.length === 0) {
        const fitted = fitEntry(entries[i], Math.max(0, entryBudget - 1));
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
  if (noteBlock) out.push(noteBlock);
  if (prior) out.push(prior);
  if (omitted > 0) out.push(`(+${omitted} earlier turn${omitted === 1 ? '' : 's'} condensed)`);
  if (kept.length > 0) out.push(kept.join('\n'));

  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${c} ${n}`)
    .join(', ');
  if (toolSummary) out.push(`Tools used: ${toolSummary}`);
  if (files.size > 0) {
    // Cap the file list so the recap can't grow unbounded with a long session.
    const sorted = [...files.keys()].sort();
    const shown = sorted
      .slice(0, 25)
      .map(f => describeFile(f, files.get(f) ?? []))
      .join(', ');
    const extra = sorted.length > 25 ? `, +${sorted.length - 25} more` : '';
    out.push(`Files touched: ${shown}${extra}`);
  }
  if (pages.size > 0) {
    // Same cap discipline as the file list. Insertion order rather than sorted: a URL list has no
    // useful sort, and the order fetched is the order the model thinks of them in.
    const all = [...pages.entries()];
    const shown = all
      .slice(0, MAX_PAGES)
      .map(([url, path]) => `${url} → ${path}`)
      .join(', ');
    const extra = all.length > MAX_PAGES ? `, +${all.length - MAX_PAGES} more` : '';
    out.push(
      `Pages fetched (saved this session — read the path instead of fetching again): ${shown}${extra}`,
    );
  }
  if (searches.size > 0) {
    // "Web" to keep it apart from the plan ledger's `Searches run`, which lists grep patterns.
    const all = [...searches];
    const shown = all
      .slice(0, MAX_SEARCHES)
      .map(q => `"${q}"`)
      .join(', ');
    const extra = all.length > MAX_SEARCHES ? `, +${all.length - MAX_SEARCHES} more` : '';
    out.push(
      `Web searches run (results kept this session — repeat the exact query to see them again, ` +
        `at no budget): ${shown}${extra}`,
    );
  }
  out.push(OMISSION_NOTE);

  return out.join('\n\n');
}

// Trim one recap entry to `budget` chars. The header (the `- User:` intent line) is what makes an
// entry legible at all, so it is kept and the entry's own `→` rounds are dropped oldest-first —
// the most recent rounds are the ones that describe where the turn actually got to. Returns null
// when not even the header fits, in which case the caller keeps nothing rather than a fragment.
// A note is fitted from the FRONT, unlike a ledger entry (fitEntry keeps the newest rounds): the
// model leads with what it established, and its header must survive so the words stay its own.
function fitNote(note: CompactionNote, budget: number): string | null {
  const header = compactionNoteHeader(note.n);
  if (header.length + 2 > budget) return null;
  const room = budget - header.length - 1;
  const body = note.text.length <= room ? note.text : note.text.slice(0, room - 1).trimEnd() + '…';
  return `${header}\n${body}`;
}

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
  const marker = latestPlanMarker(history);
  if (!marker) return { folded: 0, reason: 'no-marker' };

  // The marker says the plan turn ENDED, not that it produced a plan: loop.ts stamps it on any
  // final plan-mode message, force-written spirals included (#126). Anchoring on a message with no
  // parsed steps is the worst of both worlds — the exploration that might have grounded the next
  // turn gets folded into a digest, and what survives verbatim is "I couldn't determine…". Leave
  // history alone instead; an un-distilled turn is merely bigger, not misleading. Same 0-step
  // definition `seedPlanProgress` has always used, so the two agree about what a plan is.
  if (marker.steps.length === 0) return { folded: 0, reason: 'no-steps' };
  const planIdx = marker.index;

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
  // Exploration through plan mode's read-only `bash` (#109) carries `command`, not `path`, so
  // without this the digest's "Files examined" line silently under-reports the plan phase — the
  // agent turn would inherit a handoff claiming less was explored than actually was. See
  // buildPlanLedger in loop.ts, which goes blind the same way for the same reason.
  const commands = new Set<string>();
  const priorRecaps: string[] = [];
  for (const m of span) {
    if (m.role === 'compaction') {
      priorRecaps.push(m.content);
    } else if (m.role === 'assistant') {
      for (const tc of m.toolCalls ?? []) {
        const p = tc.args.path;
        if (typeof p === 'string') files.add(p);
        const c = tc.args.command;
        if (typeof c === 'string') commands.add(c);
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
  if (commands.size > 0) {
    const sorted = [...commands].sort();
    const shown = sorted.slice(0, 25).join(', ');
    const extra = sorted.length > 25 ? `, +${sorted.length - 25} more` : '';
    out.push(`Commands run: ${shown}${extra}`);
  }
  if (priorRecaps.length > 0) out.push(priorRecaps.join('\n\n'));
  const findings = gatherPlanFindings(span, findingsBudget);
  if (findings.trim()) out.push(`Findings:\n${findings}`);
  return out.join('\n\n');
}
