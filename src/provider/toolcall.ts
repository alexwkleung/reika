import type { Message, Tool } from '../types.js';
import type { ChatMessageParam, ChatTool } from './transport.js';
import { DEFAULT_MIN_GEN_TOKENS } from './budget.js';

// Keep in sync with CHARS_PER_TOKEN in ./tokens.ts — the heuristic that maps the
// token-denominated window to the char-denominated payload length.
const CHARS_PER_TOKEN = 4;
// Use only this fraction of the computed budget, as slack against estimate error and the
// learned calibration lagging a step behind a sudden content shift.
const BUDGET_SAFETY = 0.9;
// Floor on the calibration used *for the cap* (calibration = real tokens per estimate ≈
// 4/chars-per-token). The learned average is trained on whatever the session has seen
// (often prose-heavy reasoning, ~3.5 chars/token) and badly under-counts a sudden dump of
// dense content. Since the cap is a safety backstop and truncation is recoverable, assume
// the dense worst case here so a single tool dump can't overflow the window while calibration
// is still catching up. 2.5 (not 2.0): a multi-file UI turn carrying SVG path data + CSS +
// code in the kept reasoning was observed tokenizing at ~1.6 chars/token — real 25,389 tok
// vs a 9,941 char/4 estimate (2.5×), which sailed past compaction and 400'd a 24,576 window.
// 4/2.5 = 1.6 chars per budget-token covers that worst case.
const CAP_DENSITY_FLOOR = 2.5;
// Floor on the calibration used for content that has ALREADY BEEN SENT (issue #189). The 2.5 floor
// above is a guess about content whose real token cost is not yet known; applied to already-sent
// bytes it is an over-correction, because those bytes went over the wire and their real cost was
// measured — `calibration` IS that measurement (provider prompt_tokens / our char-4 estimate of the
// request that carried them). Counting them at 2.5 anyway over-charges ordinary source (~3.5-4
// chars/token) by ~2.2-2.5x, and under REIKA_PREFIX_STABLE — where a live payload is never aged —
// the over-charge only accumulates, so the fresh budget goes negative mid-turn and every new read
// collapses to the SMALL_PAYLOAD_FLOOR_CHARS exemption (observed: 300-line read at turn 3, 60-line
// read at turn 13, at a real 63% fill). Flooring at 1 removes only the below-baseline optimism (a
// prose-heavy session drives calibration to ~0.9) — it never assumes SPARSER than char/4. Same
// value and same reasoning as COMPACTION_CALIBRATION_FLOOR in agent/loop.ts, deliberately: the
// compaction trigger and the cap now agree on what retained content costs, instead of disagreeing
// by 2.5x on the same bytes.
const SENT_DENSITY_FLOOR = 1;

// EXPERIMENT (REIKA_DEDUP_PAYLOADS): content-identity dedup of tool messages — the "deny the
// attractor" context-hygiene layer. A weak/low-bit model is a pattern-completer, so identical content
// repeated in the context (see agent/reasoningtrace.ts) raises the odds the model repeats too;
// collapsing that repetition before it feeds back removes the fuel a loop needs, one step EARLIER than
// the reactive read-trace ledger (which only nags once the loop is already forming). Deterministic and
// model-agnostic — it changes only what is re-serialized, never sampling, so it carries none of the
// operator-provenance risk the sampling levers do. Strict no-op when off. See dedupToolContent.
const DEDUP_PAYLOADS = process.env.REIKA_DEDUP_PAYLOADS === '1';
// Replaces a stubbed FRESH payload (an identical full result still simultaneously in context — a
// parallel or in-band re-read of one file within a single round). The summary is kept, so the model
// still sees what the result was; only the duplicated body is dropped.
const DEDUP_PAYLOAD_STUB =
  '(reika: identical to an earlier result above — body omitted, you already have it)';
// Replaces a stubbed AGED summary (a byte-identical "Read A lines …" line repeating down the trail
// across rounds — the cross-round pattern that survives payload-aging, since aging only collapses the
// payload, not the summary). The originating tool_call args above still name the target, so dropping
// the duplicated summary loses nothing but the repetition itself.
const DEDUP_TRAIL_STUB = '(reika: repeat of an earlier identical result — omitted)';
// An outcome-bearing summary (a failure / decline / empty-result line) must NEVER collapse to the
// neutral trail stub: a summary-only result is never "fresh" (fresh requires a payload), so a
// repeated "Edit failed" in the ACTIVE round deduped to "(… omitted)" — and the model, told
// nothing about the outcome, concluded its retry succeeded (captured: qq2 harness-bug evidence,
// req-013). The repeat framing is kept — "you got this exact result again" is itself an anti-loop
// signal — but the outcome rides along verbatim. Matching errs generous: a false positive merely
// keeps a summary the stub would have dropped; a false negative hides a failure.
// `exit \d+` / `killed by` are how a bash result reports a non-zero status since #200: it reads
// `Ran: npm test (exit 1, 4120 bytes output)`, which carries none of the failure words above. Without
// them an aged repeat of a failing command would collapse to the bare trail stub and the model would
// lose the one thing distinguishing it from the run that passed.
const OUTCOME_SUMMARY_RE =
  /\b(fail(ed|ure)?|error|invalid|declined|denied|timed?\s?out|exceeded|not found|no (results?|match(es)?)|past end|found 0|listed 0|exit \d+|killed by)\b/i;
const NO_STUBS: ReadonlySet<number> = new Set();

// Fix for the read→edit-fail→re-read spiral (qq2 evidence, req-012): the newest fresh read is the
// model's edit source — old_string can only be assembled from bytes it actually saw, so a gutted
// read makes every subsequent edit fail unrecoverably. When the computed fresh budget says there
// is no room (the pessimistic CAP_DENSITY_FLOOR priced a 2,229-char recovery read at zero), still
// send the newest read verbatim up to this many chars: the 10% BUDGET_SAFETY slack plus the
// floor's own overestimate of non-fresh content absorb it in practice, and a rare overflow is
// recoverable (truncation retry) while the spiral is not. Reads larger than this fall back to the
// shared cap — overflow safety wins at scale.
const PROTECTED_READ_FLOOR_CHARS = 4096;

// Fix for #179: a payload this small is ALWAYS sent verbatim, whatever the computed cap says.
// Field evidence: a grep whose whole result was "Found 1 matches" plus 3 lines, and a 1,573-char
// `sed -n '1,40p'`, were both omitted entirely at 61% context — the cap arithmetic (pessimistic
// density floor + safety slack + a split across parallel payloads) can reach <= 0 while the window
// still has room, and the <= 0 branch drops a payload regardless of its length. Omitting a few
// hundred bytes never buys back a meaningful amount of window, but it costs a whole round-trip and
// reads to the model as a broken tool — the classic narrow-and-retry spiral. Same trade as
// PROTECTED_READ_FLOOR_CHARS: a rare overflow is recoverable, the spiral is not.
const SMALL_PAYLOAD_FLOOR_CHARS = 2048;
// Aggregate ceiling on that exemption within one round, so a round of eight small greps can't
// smuggle 16k chars past the budget. Granted smallest-first, which saves the most payloads.
const SMALL_PAYLOAD_FLOOR_TOTAL_CHARS = 4096;

// Fix for #227: the largest payload worth pinning as the turn's task spec (see taskSpecIndex).
// Same number and same trade as PROTECTED_READ_FLOOR_CHARS — a spec is small (the issue that
// motivated this was 505 bytes), and a first result larger than this is a dump, not a definition,
// which aging should stay free to collapse.
const TASK_SPEC_PIN_CHARS = 4096;

export function messagesToOpenAI(
  system: string,
  history: Message[],
  opts?: {
    contextWindow?: number;
    calibration?: number;
    reasoningRounds?: number;
    minGenTokens?: number;
    // EXPERIMENT (REIKA_PREFIX_STABLE, issue #69): serialize for prompt-prefix stability. Payload
    // liveness becomes sticky (`m.aged`, set only by batch aging) instead of trailing-block-only,
    // reasoning retention becomes sticky (`m.reasoningAged`) instead of last-N-rounds, and a live
    // payload's bytes are frozen via `m.rendered` — so between shrink events consecutive requests
    // are append-only and the inference engine's prompt cache stays valid. See agent/compaction.ts
    // batchAgePayloads for the aging side.
    prefixStable?: boolean;
    // Persist `m.rendered` stamps while serializing. True only on the real call path (client.ts):
    // estimates must not stamp, or WHEN a payload freezes would depend on estimate timing (which
    // varies with debug logging) instead of deterministically on the request that first sent it.
    stampRenders?: boolean;
    // Transient per-round harness note (loop ledgers / nudges) appended as the FINAL user message
    // instead of mutating the system prompt — a system-suffix change invalidates the prefix cache
    // from token 0; a tail message costs nothing. Never enters history.
    trailingNote?: string;
  },
): ChatMessageParam[] {
  const prefixStable = !!opts?.prefixStable;
  const freshFrom = prefixStable ? 0 : findFreshToolBlockStart(history);
  // Content-identity dedup (deny-the-attractor). Computed once, before the window cap below, so a
  // stubbed payload frees its budget for the surviving copies rather than being counted then dropped.
  // Bypassed under prefix-stable: a stub decision flipping when a later duplicate arrives would
  // rewrite mid-history bytes — the exact prefix-cache invalidation that mode exists to prevent.
  // #227: keep the turn's task-defining payload live past the trailing block. Prefix-stable mode
  // is exempt — there the pin belongs to batch aging (compaction.ts), because resurrecting bytes
  // that already serialized as a summary is exactly the mid-history rewrite that mode forbids.
  // Computed before dedup (which needs it to sign the pinned payload correctly) and dropped if
  // dedup stubbed it anyway — keep-first means the earliest copy survives, so it normally can't.
  const specCandidate = prefixStable ? -1 : taskSpecIndex(history);
  const stubbed =
    DEDUP_PAYLOADS && !prefixStable
      ? dedupToolContent(history, freshFrom, specCandidate)
      : NO_STUBS;
  const specIdx = specCandidate >= 0 && !stubbed.has(specCandidate) ? specCandidate : -1;
  // Reasoning is scratch work that a thinking model emits every round; kept unbounded it
  // starves the budget over a long multi-round turn, but pruning it too hard makes the
  // model re-derive the same analysis across rounds. Keep the last N tool-call rounds (the
  // active roundtrip is always among them — required so providers that validate it don't
  // break, see the cloud-thinking-models note) and drop older reasoning.
  const reasoningRounds =
    opts?.reasoningRounds && opts.reasoningRounds > 0 ? opts.reasoningRounds : 1;
  const keepReasoningFrom = reasoningKeepFromIndex(history, reasoningRounds);
  // Compaction recaps fold into the single leading system block (rather than a second
  // system message mid-array) for the widest chat-template compatibility.
  const recaps = history.filter(m => m.role === 'compaction').map(m => m.content);
  // Will any real user turn reach the model? Meta (slash-command echo) turns are skipped below, and
  // compaction folds user turns into the recap — so a heavily-compacted long turn can end up with
  // ZERO user messages. Some chat templates hard-raise on that ("No user query found in messages",
  // observed on a 35B served by llama.cpp right after a mid-turn compaction → 400). Keep folding the
  // recap into the system block normally, but when there'd be no user turn at all, surface the recap
  // as a user message instead so the request always contains one.
  const hasUserTurn = history.some(m => m.role === 'user' && !m.meta);
  const recapText = recaps.length
    ? `# Earlier conversation (compacted)\n\n${recaps.join('\n\n')}`
    : '';
  const systemContent = recapText && hasUserTurn ? `${system}\n\n${recapText}` : system;
  // The newest live read is the model's edit source — candidate for verbatim protection (see
  // PROTECTED_READ_FLOOR_CHARS). Whether protection actually holds is the cap's call below.
  const protectedIdx = newestLiveReadIndex(history, freshFrom, stubbed, prefixStable);
  // Fit-to-window: cap the fresh tool payloads to whatever room is left after everything
  // else in the request, so a single big tool round can never overflow the server.
  const { cap: perPayloadCap, verbatim } = freshPayloadCharCap(
    systemContent,
    history,
    freshFrom,
    keepReasoningFrom,
    stubbed,
    protectedIdx,
    specIdx,
    opts,
  );
  const out: ChatMessageParam[] = [{ role: 'system', content: systemContent }];
  // Compaction left no user turn — surface the recap as the user message so a user-requiring
  // template still renders. (Normal case: hasUserTurn is true and the recap stayed in the system
  // block above.) Carries the original task too, since buildRecap records "- User: <task>".
  if (recapText && !hasUserTurn) {
    out.push({ role: 'user', content: recapText });
  }
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'user') {
      // Slash-command echoes (meta) belong to the UI scrollback only — the model never
      // sees a bare `/model` or `/stats` turn (its system response was already dropped).
      if (msg.meta) continue;
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const hasTools = !!msg.toolCalls && msg.toolCalls.length > 0;
      const param: Record<string, unknown> = {
        role: 'assistant',
        content: hasTools && !msg.content ? null : msg.content,
      };
      if (hasTools) {
        param.tool_calls = msg.toolCalls!.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));
      }
      if (msg.reasoning && (prefixStable ? !msg.reasoningAged : i >= keepReasoningFrom)) {
        param.reasoning_content = msg.reasoning;
      }
      out.push(param as unknown as ChatMessageParam);
    } else if (msg.role === 'tool') {
      let content: string;
      if (prefixStable) {
        if (msg.payload && !msg.aged) {
          // Frozen bytes: reuse the stamped rendering while live; stamp on the real call only.
          const cap = verbatim.has(i) ? undefined : perPayloadCap;
          const rendered = msg.rendered ?? `${msg.summary}\n\n${capPayload(msg.payload, cap)}`;
          if (opts?.stampRenders) msg.rendered = rendered;
          content = rendered;
        } else {
          content = msg.summary;
        }
      } else {
        const fresh = !!msg.payload && (i >= freshFrom || i === specIdx);
        if (stubbed.has(i)) {
          // A byte-identical repeat of an earlier tool result. Keep the summary on a fresh dup (the
          // model still sees what it was, minus the redundant body); collapse an aged-trail dup to a
          // bare back-reference (its summary is the very thing repeating) — UNLESS the summary
          // carries an outcome, which must survive the stub (see OUTCOME_SUMMARY_RE). tool_call_id
          // pairing is untouched, so the provider still matches every call to a response.
          content = fresh
            ? `${msg.summary}\n\n${DEDUP_PAYLOAD_STUB}`
            : OUTCOME_SUMMARY_RE.test(msg.summary)
              ? `(reika: repeat of an earlier identical result — same outcome again: ${msg.summary})`
              : DEDUP_TRAIL_STUB;
        } else {
          const cap = verbatim.has(i) ? undefined : perPayloadCap;
          content = fresh ? `${msg.summary}\n\n${capPayload(msg.payload!, cap)}` : msg.summary;
        }
      }
      const toolName = findToolNameForCall(history, i);
      const param: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: msg.callId,
        content,
      };
      if (toolName) param.name = toolName;
      out.push(param as unknown as ChatMessageParam);
    }
    // error messages are UI-only and intentionally skipped here
  }
  // The transient harness note rides at the very END: the tail is rewritten every round anyway (new
  // tool results), so a note here is free for the prefix cache — and recency-adjacent, where a small
  // model attends hardest. It also counts as the user message a user-requiring template needs.
  if (opts?.trailingNote) {
    out.push({ role: 'user', content: opts.trailingNote });
  }
  // Final backstop: if somehow still no user message (e.g. an all-meta history with no recap), inject
  // a minimal one right after the system block so a user-requiring template doesn't 400. Cheap
  // insurance; not hit in the normal flow (which always has a user turn or a recap).
  if (!out.some(m => m.role === 'user')) {
    out.splice(1, 0, { role: 'user', content: '(continue)' });
  }
  return out;
}

// Indices of tool messages whose serialized content byte-identically repeats an earlier tool
// message's — the later copies are pure repetition. Keep-first: the earliest (still-in-context)
// occurrence stays whole and every repeat becomes a back-reference, so the model sees each distinct
// result exactly once. The signature is exactly what WOULD be serialized for that message (a fresh
// message serializes its payload; an aged one its summary), prefixed by kind so a payload can never
// collide with a summary. Two scales fall out of the one rule: simultaneous full-payload dups within a
// round (fresh↔fresh on the payload) and the aged summary trail across rounds (aged↔aged on the
// summary). Pure + exported for tests. See DEDUP_PAYLOADS.
export function dedupToolContent(history: Message[], freshFrom: number, specIdx = -1): Set<number> {
  const firstSeen = new Map<string, number>();
  const stubbed = new Set<number>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'tool') continue;
    // The pinned task spec (#227) serializes its payload even outside the fresh block, so its
    // signature is the payload's — keeping "the signature is what WOULD be serialized" true.
    const fresh = (i >= freshFrom || i === specIdx) && m.payload;
    const sig = fresh ? `p:${m.payload}` : `s:${m.summary}`;
    if (firstSeen.has(sig)) stubbed.add(i);
    else firstSeen.set(sig, i);
  }
  return stubbed;
}

// Index of the newest tool message whose payload will be serialized live this request AND whose
// originating call was a `read` — the edit source the cap must not gut (see
// PROTECTED_READ_FLOOR_CHARS). A dedup-stubbed read is skipped: its body was dropped precisely
// because the identical bytes are already in context. Returns -1 when no live read exists.
function newestLiveReadIndex(
  history: Message[],
  freshFrom: number,
  stubbed: ReadonlySet<number>,
  prefixStable: boolean,
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'tool' || !m.payload) continue;
    // "Live" mirrors the serialization rules: prefix-stable sends any unaged payload, but an
    // already-stamped rendering is frozen — protection can only shape a first render.
    const live = prefixStable
      ? !m.aged && m.rendered === undefined
      : i >= freshFrom && !stubbed.has(i);
    if (!live) continue;
    if (findToolNameForCall(history, i) === 'read') return i;
  }
  return -1;
}

// Does this request drop any tool payload it once carried? True when at least one tool message
// will serialize to its summary alone despite HAVING a payload — i.e. content the model saw and
// no longer has. Mirrors the two serialization branches in messagesToOpenAI exactly, and lives
// beside them so the two can't drift; the loop turns a true into the one-line notice that says so
// (#227). A result that never had a payload doesn't count: nothing was dropped, and there is
// nothing to re-run for.
export function hasDroppedPayloads(history: Message[], prefixStable = false): boolean {
  const freshFrom = prefixStable ? 0 : findFreshToolBlockStart(history);
  return history.some((m, i) =>
    m.role === 'tool' && m.payload ? (prefixStable ? !!m.aged : i < freshFrom) : false,
  );
}

// Start index of the trailing block of tool messages — tool messages at or after
// this index keep their payloads; earlier ones collapse to summary. Exported for
// batch aging (agent/compaction.ts), which must never age the active round's results.
export function findFreshToolBlockStart(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'tool') return i + 1;
  }
  return 0;
}

// Index of the CURRENT turn's task-defining tool result — the first tool payload after the last
// real user message — or -1 when there isn't one worth pinning. Aging is oldest-first with no
// notion of which payload defines the task, so under a skill that mandates a spec fetch as the
// opening call (`/issue`, `/review` both do) the payload holding the task definition is always the
// FIRST one sacrificed, which inverts the priority (#227). `verbatim` only exempts a fresh payload
// from the char cap and newest-read protection only covers a `read`, so neither reaches a `bash`
// result holding the issue text. Scoped to the turn in progress and capped at TASK_SPEC_PIN_CHARS,
// so the pin costs a bounded few KB and the next turn's own opening result moves it. Deliberately
// not "the first SMALL payload": the opening call is the spec candidate, and a huge one means this
// turn didn't open with a spec fetch at all. Pure + exported for tests and batch aging.
// Index of the newest real user message, or -1. "Real" excludes `meta` — a slash-command echo is
// UI scrollback, never a turn boundary the model sees. taskSpecIndex walks every user message (it
// falls through turns that landed no tool result); this names just the current one, which is what
// tells a pin belonging to THIS turn from one carried over from an earlier one.
export function lastUserMessageIndex(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && !m.meta) return i;
  }
  return -1;
}

export function taskSpecIndex(history: Message[]): number {
  for (let u = history.length - 1; u >= 0; u--) {
    const m = history[u];
    if (m.role !== 'user' || m.meta) continue;
    for (let i = u + 1; i < history.length; i++) {
      const t = history[i];
      if (t.role !== 'tool' || !t.payload) continue;
      return t.payload.length <= TASK_SPEC_PIN_CHARS ? i : -1;
    }
    // This turn has no tool result yet (round 0), so nothing has replaced the spec — keep the
    // previous turn's pin rather than releasing it the instant the user hits enter. Releasing at
    // round 0 would shrink mid-history bytes on the exact request the prompt-prefix warm-up
    // (agent/warm.ts) prebuilt from the pre-turn history, breaking its append-only guarantee for
    // no gain. The handover happens one round later, when this turn's own opening result lands.
  }
  return -1;
}

// Per-payload character budget for the fresh tool block, computed to *fit the window*:
// take the prompt's char budget (window minus response headroom, converted from tokens
// via the learned calibration), subtract everything else in the request, and split what
// remains across the fresh payloads. `cap` undefined (no cap) when the context window is
// unknown; 0 collapses payloads to summary-only when nothing else leaves room.
// `verbatim` holds the history indices exempt from the cap entirely. The pinned task spec
// (specIdx, #227) is exempt unconditionally — taskSpecIndex already bounded it. The newest live read
// (protectedIdx) is exempt when it fits the fresh budget whole, or — budget notwithstanding —
// when it is at most PROTECTED_READ_FLOOR_CHARS; a larger read that doesn't fit joins the
// shared split instead (overflow safety wins at scale). Any fresh payload at or under
// SMALL_PAYLOAD_FLOOR_CHARS is exempt too, smallest-first up to SMALL_PAYLOAD_FLOOR_TOTAL_CHARS
// (#179) — omitting a few hundred bytes frees no real window and only teaches the model its
// tools are broken. Exempt payloads are allocated BEFORE the split, so what they cost is
// subtracted from the budget the capped payloads divide rather than double-counted.
function freshPayloadCharCap(
  systemContent: string,
  history: Message[],
  freshFrom: number,
  keepReasoningFrom: number,
  stubbed: ReadonlySet<number>,
  protectedIdx: number,
  specIdx: number,
  opts?: {
    contextWindow?: number;
    calibration?: number;
    minGenTokens?: number;
    prefixStable?: boolean;
  },
): { cap: number | undefined; verbatim: ReadonlySet<number> } {
  const cw = opts?.contextWindow;
  // No window: nothing is capped, so protection is moot (capPayload passes everything through).
  if (!cw) return { cap: undefined, verbatim: NO_STUBS };
  const prefixStable = !!opts?.prefixStable;
  // Reserve the same generation room the backstop and compaction use, so a fresh tool
  // dump can't leave a thinking model with no tokens to respond in. See provider/budget.ts.
  const reserve =
    opts?.minGenTokens && opts.minGenTokens > 0 ? opts.minGenTokens : DEFAULT_MIN_GEN_TOKENS;
  const learned = opts?.calibration && opts.calibration > 0 ? opts.calibration : 1;
  // The pessimistic floor, for every byte whose real token cost is still a guess: the fresh-allowance
  // conversion and the part of the fixed overhead this request introduces. Under-counting unmeasured
  // content over-allocates to fresh and overflows — the observed 400 leaked partly through the fixed
  // overhead, because a round's freshly-kept reasoning quoted SVG path data / CSS and tokenized far
  // denser than the prose average the learned calibration carried.
  const capCalib = Math.max(learned, CAP_DENSITY_FLOOR);
  // The measured floor, for bytes a previous request already carried — `calibration` counted those,
  // so pricing them at the guess instead over-charges them ~2.5x. See SENT_DENSITY_FLOOR (#189).
  const sentCalib = Math.max(learned, SENT_DENSITY_FLOOR);
  // Split point between the two: everything from the assistant turn that opened the trailing tool
  // round onward is NEW in this request — this round's reasoning and tool summaries have never been
  // measured, so they price at the pessimistic floor exactly like a fresh payload does. (The dense
  // turn that motivated CAP_DENSITY_FLOOR overflowed partly through freshly-kept reasoning quoting
  // SVG path data; that content stays on the pessimistic side of this line.)
  const unsentFrom = unsentFromIndex(history);

  // Fresh payloads eligible for the shared split, with the lengths the floor exemption needs.
  const fresh: Array<{ idx: number; len: number }> = [];
  // Non-fresh chars, split by whether a previous request already carried them (measured, priced at
  // sentCalib) or not (unmeasured, priced at capCalib). The system block has been in every request.
  let sentChars = systemContent.length;
  let unsentChars = 0;
  const addNonFresh = (i: number, n: number): void => {
    if (i >= unsentFrom) unsentChars += n;
    else sentChars += n;
  };
  // Payload length of the protected read (0 = none in the live set). Held out of the shared
  // split; whether it goes verbatim or rejoins the split is decided after the budget is known.
  let protectedChars = 0;
  // Payload length of the pinned task spec (0 = none). Allocated verbatim ahead of everything
  // else — it is already bounded by TASK_SPEC_PIN_CHARS, and losing it is what #227 is about.
  let specChars = 0;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (prefixStable && m.role === 'tool' && m.payload && !m.aged) {
      if (m.rendered !== undefined) {
        // Already-frozen bytes are a fixed cost, not a share of the fresh budget — only payloads
        // that have never been sent split what's left. They are also *measured* whatever their
        // index: `rendered` is stamped only on the call path that actually sent them (stampRenders).
        sentChars += m.rendered.length;
      } else if (i === protectedIdx) {
        protectedChars = m.payload.length;
        addNonFresh(i, m.summary.length + 2);
      } else {
        fresh.push({ idx: i, len: m.payload.length });
        addNonFresh(i, m.summary.length + 2);
      }
    } else if (
      !prefixStable &&
      (i >= freshFrom || i === specIdx) &&
      m.role === 'tool' &&
      m.payload
    ) {
      if (i === specIdx) {
        specChars = m.payload.length;
        addNonFresh(i, m.summary.length + 2);
      } else if (stubbed.has(i)) {
        // A stubbed fresh dup carries no payload — only its summary + the fixed stub note — so it
        // must NOT claim a share of the fresh budget (it would shrink the survivors' cap for nothing).
        addNonFresh(i, m.summary.length + DEDUP_PAYLOAD_STUB.length + 2);
      } else if (i === protectedIdx) {
        protectedChars = m.payload.length;
        addNonFresh(i, m.summary.length + 2);
      } else {
        fresh.push({ idx: i, len: m.payload.length });
        addNonFresh(i, m.summary.length + 2); // the summary prefix is always sent
      }
    } else {
      // Match the build loop: reasoning only counts where it's actually sent.
      const includeReasoning = prefixStable
        ? !(m.role === 'assistant' && m.reasoningAged)
        : i >= keepReasoningFrom;
      addNonFresh(i, nonFreshChars0(m, includeReasoning));
    }
  }
  // Work in real tokens: budget the prompt, subtract the non-fresh content — already-sent bytes at
  // their measured density, this round's new bytes pessimistically — and convert what's left for
  // fresh payloads back to chars pessimistically.
  const promptTokenBudget = (cw - reserve) * BUDGET_SAFETY;
  const nonFreshTokens =
    (sentChars / CHARS_PER_TOKEN) * sentCalib + (unsentChars / CHARS_PER_TOKEN) * capCalib;
  let freshTokenBudget = promptTokenBudget - nonFreshTokens;
  // The pinned task spec is allocated first and unconditionally (#227) — taskSpecIndex already
  // bounded it, and losing the definition of the task is the failure this exists to prevent.
  // The protected read comes next — verbatim if it fits the whole fresh budget, and
  // verbatim regardless of budget up to the floor (the spiral is unrecoverable; a rare overflow
  // is not — see PROTECTED_READ_FLOOR_CHARS). Only a large read that doesn't fit falls back
  // into the shared split. Everything else divides what remains, which may be nothing.
  const verbatim = new Set<number>();
  if (specChars > 0) {
    verbatim.add(specIdx);
    freshTokenBudget -= (specChars / CHARS_PER_TOKEN) * capCalib;
  }
  if (protectedChars > 0) {
    const protectedTokens = (protectedChars / CHARS_PER_TOKEN) * capCalib;
    if (protectedTokens <= freshTokenBudget || protectedChars <= PROTECTED_READ_FLOOR_CHARS) {
      verbatim.add(protectedIdx);
      freshTokenBudget -= protectedTokens;
    } else {
      fresh.push({ idx: protectedIdx, len: protectedChars });
    }
  }
  // Small payloads next (#179), smallest-first so the ceiling saves as many as it can. Like the
  // protected read these are allocated even when the budget is already spent — that is the point.
  let smallChars = 0;
  for (const p of [...fresh].sort((a, b) => a.len - b.len)) {
    if (p.len > SMALL_PAYLOAD_FLOOR_CHARS) break;
    if (smallChars + p.len > SMALL_PAYLOAD_FLOOR_TOTAL_CHARS) break;
    smallChars += p.len;
    verbatim.add(p.idx);
    freshTokenBudget -= (p.len / CHARS_PER_TOKEN) * capCalib;
  }
  const capped = fresh.filter(p => !verbatim.has(p.idx)).length;
  if (capped === 0) return { cap: undefined, verbatim };
  if (freshTokenBudget <= 0) return { cap: 0, verbatim };
  const freshCharBudget = (freshTokenBudget * CHARS_PER_TOKEN) / capCalib;
  return { cap: Math.floor(freshCharBudget / capped), verbatim };
}

// Index from which reasoning_content is kept: the start of the Nth-most-recent tool-call
// round. Messages at or after it keep their reasoning; earlier ones are pruned. Returns
// history.length (keep none) when there are no tool-call rounds at all.
function reasoningKeepFromIndex(history: Message[], rounds: number): number {
  let seen = 0;
  let earliestToolCall = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      earliestToolCall = i;
      if (++seen === rounds) return i;
    }
  }
  // Fewer than `rounds` tool-call rounds exist: keep from the earliest one, or — if there
  // are no tool-call rounds at all — keep none (final-answer reasoning isn't needed later).
  return earliestToolCall === -1 ? history.length : earliestToolCall;
}

// First index of content that is NEW in the request being built — the assistant turn that opened
// the trailing tool round, whose reasoning and tool_calls have never been sent, or history.length
// when the trailing block isn't a tool round at all. Everything before it rode in the previous
// request, so `calibration` measured it. Computed from the real trailing tool block rather than the
// caller's `freshFrom` (which prefix-stable forces to 0 for serialization purposes). See
// SENT_DENSITY_FLOOR.
function unsentFromIndex(history: Message[]): number {
  const block = findFreshToolBlockStart(history);
  const opener = history[block - 1];
  return opener?.role === 'assistant' && opener.toolCalls?.length ? block - 1 : block;
}

// Approximate the chars a message contributes to the serialized request, excluding fresh
// payloads (handled separately). Compaction recaps are already folded into systemContent,
// so they count as 0 here to avoid double-counting.
function nonFreshChars0(m: Message, includeReasoning: boolean): number {
  switch (m.role) {
    case 'user':
      return m.content.length;
    case 'assistant':
      return (
        (m.content?.length ?? 0) +
        (includeReasoning ? (m.reasoning?.length ?? 0) : 0) +
        (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0)
      );
    case 'tool':
      return m.summary.length;
    default:
      return 0;
  }
}

// Truncate an over-budget payload, keeping the head AND the tail. Build/test/command
// output puts the signal (artifact paths, pass/fail, errors) at the *end*, so head-only
// truncation hands the model noise and hides the conclusion; we bias toward the tail.
// The marker makes clear this is a *context* limit, not the command failing — otherwise a
// model loops re-running with different flags. Full text stays in the PayloadStore.
const HEAD_FRACTION = 0.4;
function capPayload(payload: string, cap: number | undefined): string {
  if (cap === undefined || payload.length <= cap) return payload;
  // Budget exhausted entirely: say so plainly instead of sandwiching the marker between two
  // empty slices — "Output continues:" over nothing reads as tool output, not as an omission.
  if (cap <= 0) {
    // The remedy must be one that can actually work. This branch used to say "read a narrower line
    // range", which at cap <= 0 was false — the cap ignored payload length, so the model shrank
    // 300 -> 120 -> 70 -> 40 lines over 20 minutes and got nothing back every time (#179). Since
    // payloads at or under SMALL_PAYLOAD_FLOOR_CHARS now bypass the cap outright, narrowing IS a
    // real remedy — but only below that number, so state the number and the size that failed.
    return (
      `[reika: entire output (${payload.length} chars) omitted to fit the context window — a ` +
      `context-size limit, not a command error; re-running this exact call won't help. Results of ` +
      `${SMALL_PAYLOAD_FLOOR_CHARS} chars or less are always delivered in full, so re-run it ` +
      `narrowed to return under that much (a targeted grep for one symbol, or a read of a few ` +
      `dozen lines). Otherwise work from the summary line above.]`
    );
  }
  const head = Math.floor(cap * HEAD_FRACTION);
  const tail = cap - head;
  const omitted = payload.length - cap;
  // The marker sits AT the cut and must warn about edits: the model cannot know what the hidden
  // middle says, so an old_string spanning this gap is guaranteed not to match the real file
  // (qq2 evidence, req-010/012/015 — the read→edit-fail spiral).
  return (
    `${payload.slice(0, head)}\n\n` +
    `[reika: ${omitted} chars omitted here — the middle of this output is hidden to fit the ` +
    `context window; a context-size limit, not a command error; re-running won't help. Never ` +
    `build an edit old_string from text spanning this gap; read a narrower line range to see ` +
    `the hidden part. Output continues:]\n\n` +
    `${payload.slice(payload.length - tail)}`
  );
}

// Resolve which tool produced the tool message at `toolIdx` — by matching its callId within its
// OWN round only. Provider-issued ids are only unique per response (llama.cpp/qq2 emit `call_0`
// for every single-call round), so a global first-match pins every result to the OLDEST round
// that used the id: observed in the field as every tool result serializing with name='edit' and
// newest-read protection never firing (the read's callId resolved to an ancient edit call). A
// result's round is the nearest preceding assistant message that carries toolCalls — results
// follow their round contiguously, so scanning backward cannot land on a different round first.
function findToolNameForCall(history: Message[], toolIdx: number): string | undefined {
  const msg = history[toolIdx];
  if (msg.role !== 'tool') return undefined;
  for (let i = toolIdx - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    // Not found in its own round → unmatched; returning a name from an older round would lie.
    return m.toolCalls.find(tc => tc.id === msg.callId)?.name;
  }
  return undefined;
}

export function toolsToOpenAI(tools: Tool[]): ChatTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
