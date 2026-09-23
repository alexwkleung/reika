import type { Message, Tool } from '../types.js';
import type { NativeImage } from '../agent/attachments.js';
import type { ChatMessageParam, ChatTool } from './transport.js';
import { imageContentPart } from './transport.js';
import { DEFAULT_MIN_GEN_TOKENS } from './budget.js';
import type { EndpointLatches } from './latches.js';

type ShapeLatches = Pick<EndpointLatches, 'reasoningRoundtrip' | 'toolMessageName'>;

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
// operator-provenance risk the sampling levers do. ON by default since 2026-09-18: it benched null
// (not negative) on windowed local turns, where prefix-stable bypasses it anyway (below), and the
// setups it does reach — no REIKA_CONTEXT_WINDOW, or REIKA_PREFIX_STABLE=0 — already rewrite
// mid-history every round, so a stub costs no cache validity that per-round aging hadn't spent. In
// those setups every non-trailing payload is a summary, which is exactly the trail it collapses.
// `=0` is the baseline arm; strict no-op when off. See dedupToolContent.
const DEDUP_PAYLOADS = process.env.REIKA_DEDUP_PAYLOADS !== '0';
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

// Aging is a cliff where capping is a slope: an over-cap payload keeps its head, a loud marker and
// its tail (capPayload), but an AGED one collapses to `summary` and the bytes are simply gone. For
// most results that is the right trade — the summary says what ran and how it came out. A unified
// diff is the exception (#227 follow-up). Under `/review` the diff IS the task, it arrives in
// 300-line pages far over TASK_SPEC_PIN_CHARS so no pin can hold it, and its summary — "Ran: gh pr
// diff 225 | sed -n '1,300p' (15169 bytes output)" — reads like a result rather than a hole. A model
// that later goes back to check a hunk reconstructs it from whatever else is in context: on #225,
// qwen3.8-27b invented an `import { resetSpillDir, spill, sweepStaleSpills }` line the diff never
// contained, then spent an hour of git archaeology defending it against the file on disk. Keeping
// the structural lines costs a bounded ~1KB, leaves a map of which files and which line ranges the
// page covered, and — the point — makes the omission unmistakable so a gap is read as a gap.
const AGED_DIFF_SKELETON_CHARS = 1024;

// #257: an aged payload this small is not worth the round-trip it costs. Aging is oldest-first and
// size-blind past the sweep split, so a 755-char `src/cli.tsx` gets shed inside an event that sheds
// tens of thousands — and the ~590-char hole marker means the eviction bought 114 chars. Measured
// twice, on two different runs of the same task: the model re-read that file three times, hit
// `maxrepeat=3`, and took a full tool withdrawal. The two runs that never shed it had zero dup-aged
// re-reads and finished in half the rounds and half the tokens. Below this floor an aged payload
// therefore keeps its bytes: the skeleton it displaces bounds what that costs, and a crumb the
// model still has is a round it doesn't spend re-reading. Same number and same trade as
// SMALL_PAYLOAD_FLOOR_CHARS on the cap path.
const SMALL_AGED_PAYLOAD_FLOOR_CHARS = 2048;
// Aggregate ceiling on that exemption within one request, mirroring SMALL_PAYLOAD_FLOOR_TOTAL_CHARS.
//
// The ceiling is what bounds this floor's ONE departure from #258's sweep split. That split only
// reordered — the second sweep took the crumbs anyway, so it could never keep a shrink event from
// reaching its watermark, and its worst case was the previous behavior exactly. This floor is not
// that: the exemption lives in serialization, the aging walk has no way to override it, so an event
// CAN come up short because of bytes held back here and escalate to a fold in the same round
// (loop.ts, `agedButAboveWatermark`). The ceiling is what keeps that bounded at ~1k tokens against
// a shrink event that sheds five or six times that — small enough to be the wrong explanation for
// any fold you find, but say so rather than assume it. The `short=` number on the batch-age line is
// there to settle it: measured over the three #279 verification runs, the only event that came up
// short was ~4000 tokens short with a single sheddable bulk payload left, so the crumbs were not
// what cost it.
//
// Granted NEWEST-first, not smallest-first as the cap path grants it: the cap is choosing which
// payloads arrive at all, while this is choosing which evictions the model is likeliest to have to
// undo, and that is a question about recency.
const SMALL_AGED_PAYLOAD_FLOOR_TOTAL_CHARS = 4096;
const DIFF_STRUCTURE_RE = /^(?:diff --git |--- |\+\+\+ |@@ )/;

// The same trade as AGED_DIFF_SKELETON_CHARS, applied to the other payload shape that ages badly:
// a line-numbered `read`. #260 measured 7 of 8 re-reads in four `/review` runs happening with no
// fold at all — the summary already carries the coordinates (`Read src/tools/_spill.ts lines 1-244
// of 244`) and the model re-read the whole file anyway, because the range was never the missing
// part. Keeping the top-level declaration lines — with their real line numbers — leaves an outline
// the model can orient from: which symbols the range contained and where each one starts, so a
// follow-up read can be a narrow one, or unnecessary. Bodies are what must go; they are the bytes.
const AGED_READ_SKELETON_CHARS = 1024;
// A `read` payload's gutter (see tools/read.ts). Nothing else in the harness emits it, so it is
// also what identifies the payload as a code read rather than command output.
const READ_GUTTER_RE = /^\s*(\d+)│(.*)$/;
// Top-level declarations only: a declaration keyword at column zero. Indented matches are excluded
// deliberately — at any indent this fires on locals and object literals and the outline stops being
// an outline. Deliberately several languages wide and shallow; a missed dialect degrades to the
// summary, which is today's behaviour, while a false positive costs bounded chars.
const DECLARATION_RE =
  /^(?:export|import|from|declare|async|function|class|interface|type|enum|const|let|var|def|fn|pub|impl|struct|trait|package|module|public|private|protected|func|abstract|extension|namespace)\b/;
// The other half of "structural", and the one a keyword list can never reach (#269): a column-zero
// line that OPENS something. `describe('footers', () => {` is the shape 15 of 23 missed reads had —
// a call, not a declaration — and the same rule picks up Go's `func`, Ruby's `def`, a Python `class`
// and a Lua `function` without enumerating any of them. Applied only inside a known code extension,
// where a line ending in `{`/`:`/`=>` is structure; in prose it is a sentence.
const BLOCK_OPENER_RE = /(?:\{|=>|:)\s*$/;
// Lines that sit at column zero and are structure's opposite: a closing bracket, or a comment.
// `#` is in here for shell and Python, which is exactly why markdown headings need their own rule
// rather than a shared one.
const NON_STRUCTURE_RE = /^(?:[)\]}]|\/\/|\/\*|\*|#|--|;;)/;
// Markdown structure is the heading tree; JSON's is its top-level keys (at indent 2 in every
// formatter anyone uses, so allow a shallow indent rather than requiring column zero).
const MARKDOWN_HEADING_RE = /^#{1,6}\s+\S/;
const JSON_KEY_RE = /^ {0,2}"[^"]+"\s*:/;
// Extensions whose structure is line-shaped enough for BLOCK_OPENER_RE. An extension missing here
// falls back to declaration keywords alone — today's behaviour, which is the point: an unknown
// language degrades, it does not misfire. Grow this from evals/agedoutline-report.ts, never from
// imagination.
const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'rb',
  'lua',
  'sh',
  'bash',
  'zsh',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'java',
  'kt',
  'swift',
  'php',
  'cs',
  'scala',
  'zig',
  'ex',
  'exs',
  'vue',
  'svelte',
  'sql',
]);
// Aggregate ceiling on that exemption within one round, so a round of eight small greps can't
// smuggle 16k chars past the budget. Granted smallest-first, which saves the most payloads.
const SMALL_PAYLOAD_FLOOR_TOTAL_CHARS = 4096;

// Fix for #227: the largest payload worth pinning as the turn's task spec (see taskSpecIndex).
// Same number and same trade as PROTECTED_READ_FLOOR_CHARS — a spec is small (the issue that
// motivated this was 505 bytes), and a first result larger than this is a dump, not a definition,
// which aging should stay free to collapse.
export const TASK_SPEC_PIN_CHARS = 4096;

// What the fit-to-window cap did to THIS request's fresh tool payloads (#253). Measurement only —
// nothing reads it but the debug log. The cap is sized from the room left after everything else in
// the request, so retaining more old payloads tightens it: raising the aging watermark buys
// old-payload retention by truncating NEW tool output, and without this that half of the trade is
// invisible in a log.
//
// Counted where the cap is actually applied, which is the moment a payload first enters a request.
// Under prefix-stable a frozen `rendered` payload is not re-capped, so these numbers describe the
// payloads ARRIVING this round rather than every payload in the prompt — which is the quantity the
// question is about.
export type CapStats = {
  // The per-payload char cap in force (undefined = no window configured, nothing capped).
  cap: number | undefined;
  // Fresh payloads serialized this request, and how many the cap actually cut.
  fresh: number;
  truncated: number;
  // Chars dropped across those.
  omitted: number;
  // Fresh payloads that shipped WHOLE — either no cap was in force (the request already fit) or the
  // payload was exempt (newest-read protection, or under the small-payload floor). One number
  // because the question it answers is "did this arrive intact", not why.
  uncapped: number;
  // Payloads that got NO body at all because the budget was exhausted (cap <= 0) — the #179 shape,
  // worth its own count because it is a different failure from ordinary truncation.
  starved: number;
};

// Which branch agedToolContent took for one message. `whole` is an aged payload kept verbatim —
// either because it is a crumb the floor spared (#257) or because its skeleton would have cost more
// than it did.
// `report` is a subagent's digest kept by its head (#354): a report is already compressed, and
// its chain/"Established" section leads by construction of the report directive.
type AgedKind = 'summary' | 'diff' | 'outline' | 'whole' | 'report';
type AgedContent = { content: string; kind: AgedKind };

// What eviction did to this request, counted where it happens (#260). Aging is otherwise invisible
// in the logs: the summaries and skeletons live only in the serialized request, which nothing
// records, so a verification run could not tell an outline that fired from one that never did.
export type AgedStats = Record<AgedKind, number>;

// Endpoint-shape rejections (latched per endpoint in latches.ts, the same family as the
// logprobs/tool_choice latches). Strict upstreams — the validators behind hosted routers like OpenCode Go — 400 on two
// shapes reika emits by default:
//   - a pruned old `reasoning_content` ("The reasoning_content in the thinking mode must be
//     passed back to the API"): the REIKA_REASONING_ROUNDS window and the prefix-stable aging
//     sweep both drop older reasoning, and this endpoint wants every bit it returned passed back;
//   - the `name` this file adds to tool messages (`"name" is not supported by this endpoint):
//     OpenAI's wire shape accepts role/tool_call_id/content on tool messages only.
// client.ts's degrade ladder classifies the rejection text (shapeRejection), latches it for that
// endpoint, and re-serializes — the retried request, and every later request to that endpoint,
// carry the shape it accepts (the caller passes the latches in as `opts.latches`). Cost when the
// reasoning latch fires: that endpoint gives up the round-window saving for the session — a 400
// costs the turn outright, so keeping is the only side that can lose.

export type ShapeRejection = 'reasoning-roundtrip' | 'tool-message-name';

// Classify a transport error by the backend's own words; null for anything else — only a
// rejection naming its cause may spend a retry. Matched against the whole error string
// (`chat/completions failed: 400 … — {raw JSON body}`), whose quotes arrive JSON-escaped, so
// each pattern tolerates a backslash before them.
export function shapeRejection(reason: string): ShapeRejection | null {
  if (/`?reasoning_content`?[\s\S]{0,80}must be passed back/.test(reason))
    return 'reasoning-roundtrip';
  if (/(\\?")name(\\?") is not supported/.test(reason)) return 'tool-message-name';
  return null;
}

// The request shape is the OpenAI-compatible `/v1/chat/completions` protocol (`ChatMessageParam`,
// transport.ts) that every backend we talk to speaks — llama.cpp, vLLM, Ollama — not OpenAI itself.
export function messagesToChatParams(
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
    // Ignore the frozen `m.rendered` stamps for this pass, so live payloads are re-rendered — and
    // therefore re-capped — instead of reusing bytes capped against a different request. Set only
    // by client.ts's shape-rejection retry: the first serialize stamped under a cap that did not
    // yet count the reasoning the retry restores, and a frozen payload is a *fixed* cost to the
    // cap, so without this the retry would carry the payloads AND the reasoning it just re-added —
    // over the budget the cap exists to enforce, on the one request that must not 400 again.
    rerender?: boolean;
    // The target endpoint's shape latches (latches.ts). Estimates pass them too, so a latched
    // endpoint's larger request is what the compaction trigger and the cap measure.
    latches?: ShapeLatches;
    // Transient per-round harness note (loop ledgers / nudges) appended as the FINAL user message
    // instead of mutating the system prompt — a system-suffix change invalidates the prefix cache
    // from token 0; a tail message costs nothing. Never enters history.
    trailingNote?: string;
    // Pasted images to hand to the model directly, for a profile whose model can already see
    // (VisionRoute 'native'). Each is attached to the one history user message whose text carries
    // its marker — the message the user actually pasted it into — and only that message. An image
    // whose marker is no longer in the serialized text is dropped rather than sent anyway: the
    // marker is the user's handle on the attachment, and deleting it has to mean "don't send this"
    // (the same rule attachImageBlocks applies to the text block).
    //
    // The parts land on the LAST matching user message, which is the tail of the request, so the
    // prefix ahead of it is untouched and the prompt cache stays valid across a turn's rounds.
    nativeImages?: NativeImage[];
    // Debug-only hook: reports what the fit-to-window cap did to this request (#253).
    onCapStats?: (stats: CapStats) => void;
    onAgedStats?: (stats: AgedStats) => void;
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
  // Latched roundtrip (shape rejection above): keep every round's reasoning, not just the last N.
  const keepAllReasoning = !!opts?.latches?.reasoningRoundtrip;
  const keepReasoningFrom = keepAllReasoning ? 0 : reasoningKeepFromIndex(history, reasoningRounds);
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
  const protectedIdx = newestLiveReadIndex(
    history,
    freshFrom,
    stubbed,
    prefixStable,
    !!opts?.rerender,
  );
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
  // How each tool message is served this request, and — of the ones being aged — which crumbs keep
  // their bytes under the floor (#257). Both the loop below and the ceiling read this one map.
  const disposition = toolDispositions(history, prefixStable, freshFrom, specIdx, stubbed);
  const keptWhole = agedWholeIndices(history, disposition);
  const capStats: CapStats = {
    cap: perPayloadCap,
    fresh: 0,
    truncated: 0,
    omitted: 0,
    uncapped: 0,
    starved: 0,
  };
  // Wraps capPayload so the counts can never drift from what was actually serialized — the two call
  // sites below are the only places a fresh payload's body is produced.
  const applyCap = (payload: string, cap: number | undefined): string => {
    capStats.fresh++;
    if (cap !== undefined && payload.length > cap) {
      capStats.truncated++;
      capStats.omitted += payload.length - Math.max(cap, 0);
      if (cap <= 0) capStats.starved++;
    } else {
      capStats.uncapped++;
    }
    return capPayload(payload, cap);
  };
  const agedStats: AgedStats = { summary: 0, diff: 0, outline: 0, whole: 0, report: 0 };
  // Same discipline as applyCap: count where the content is produced, so the line can never
  // describe a serialization that didn't happen.
  const serializeAged = (msg: Extract<Message, { role: 'tool' }>, i: number): string => {
    const { content, kind } = agedToolContent(msg, keptWhole.has(i));
    agedStats[kind]++;
    return content;
  };
  const out: ChatMessageParam[] = [{ role: 'system', content: systemContent }];
  // Index of the last user message that came from *history* — never the recap above nor the
  // trailing note below. Native-image parts attach to it, and only to it.
  let lastUserIdx = -1;
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
      // A harness nudge mid-turn (typecheck send-back, continuation, length/verbatim recovery) is a
      // user message too, but it never carries the marker — targeting it would drop the images for
      // the rest of the turn.
      if (!msg.harness) lastUserIdx = out.length - 1;
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
      const keepReasoning =
        keepAllReasoning || (prefixStable ? !msg.reasoningAged : i >= keepReasoningFrom);
      if (msg.reasoning && keepReasoning) {
        param.reasoning_content = msg.reasoning;
      }
      out.push(param as unknown as ChatMessageParam);
    } else if (msg.role === 'tool') {
      let content: string;
      // Total by construction: toolDispositions classifies every tool message in `history`. The
      // switch below is exhaustive over ToolDisposition, so adding a disposition is a type error
      // here rather than a silently unserialized message.
      switch (disposition.get(i)!) {
        case 'live': {
          const cap = verbatim.has(i) ? undefined : perPayloadCap;
          const body = (): string => `${msg.summary}\n\n${applyCap(msg.payload!, cap)}`;
          if (!prefixStable) {
            content = body();
            break;
          }
          // Frozen bytes: reuse the stamped rendering while live; stamp on the real call only.
          // `rerender` (the shape-rejection retry) drops the stamp instead: those bytes were capped
          // against a request that did not yet carry the reasoning the retry restores.
          const rendered = opts?.rerender ? body() : (msg.rendered ?? body());
          if (opts?.stampRenders) msg.rendered = rendered;
          content = rendered;
          break;
        }
        case 'aged':
          content = serializeAged(msg, i);
          break;
        // A byte-identical repeat of an earlier tool result. Keep the summary on a fresh dup (the
        // model still sees what it was, minus the redundant body); collapse an aged-trail dup to a
        // bare back-reference (its summary is the very thing repeating) — UNLESS the summary carries
        // an outcome, which must survive the stub (see OUTCOME_SUMMARY_RE). tool_call_id pairing is
        // untouched, so the provider still matches every call to a response.
        case 'stub-fresh':
          content = `${msg.summary}\n\n${DEDUP_PAYLOAD_STUB}`;
          break;
        case 'stub-aged':
          content = OUTCOME_SUMMARY_RE.test(msg.summary)
            ? `(reika: repeat of an earlier identical result — same outcome again: ${msg.summary})`
            : DEDUP_TRAIL_STUB;
          break;
      }
      const toolName = findToolNameForCall(history, i);
      const param: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: msg.callId,
        content,
      };
      if (toolName && !opts?.latches?.toolMessageName) param.name = toolName;
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
  // Native vision: fold this turn's pasted images into the user message they were pasted into, as
  // OpenAI multimodal parts. The message stays text in history — only this outgoing copy carries
  // bytes, so nothing downstream (aging, compaction, spill, transcripts) ever sees a non-string.
  if (opts?.nativeImages?.length && lastUserIdx >= 0) {
    const target = out[lastUserIdx];
    const text =
      target.role === 'user' && typeof target.content === 'string' ? target.content : null;
    if (text !== null) {
      // One filter for the whole group, against that message's own text: the marker is what links
      // an attachment to the turn, so a marker the user deleted can't smuggle its bytes in.
      const live = opts.nativeImages.filter(im => text.includes(im.marker));
      if (live.length > 0) {
        // Text first, then images — the order ocr/vision.ts uses for the same wire shape.
        out[lastUserIdx] = {
          role: 'user',
          content: [{ type: 'text', text }, ...live.map(im => imageContentPart(im.mime, im.bytes))],
        };
      }
    }
  }
  // Final backstop: if somehow still no user message (e.g. an all-meta history with no recap), inject
  // a minimal one right after the system block so a user-requiring template doesn't 400. Cheap
  // insurance; not hit in the normal flow (which always has a user turn or a recap).
  if (!out.some(m => m.role === 'user')) {
    out.splice(1, 0, { role: 'user', content: '(continue)' });
  }
  opts?.onCapStats?.(capStats);
  opts?.onAgedStats?.(agedStats);
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
  rerender: boolean,
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'tool' || !m.payload) continue;
    // "Live" mirrors the serialization rules: prefix-stable sends any unaged payload, but an
    // already-stamped rendering is frozen — protection can only shape a first render. `rerender`
    // drops the stamps, so every unaged payload is a first render again and the edit source keeps
    // its protection instead of joining the shared split.
    const live = prefixStable
      ? !m.aged && (rerender || m.rendered === undefined)
      : i >= freshFrom && !stubbed.has(i);
    if (!live) continue;
    if (findToolNameForCall(history, i) === 'read') return i;
  }
  return -1;
}

// Does this request drop any tool payload it once carried? True when at least one tool message
// LOSES its payload despite having had one — i.e. content the model saw and no longer has. Counted
// off `aged`/position, never off the rendered bytes, so it tracks the two serialization branches in
// messagesToChatParams without depending on what they emit; the loop turns a true into the one-line
// notice that says so (#227). "Lost the payload" is not the same as "serializes to the summary
// alone": an aged *diff* also carries a bounded structural skeleton (agedToolContent), and it still
// counts — the hunk bodies are gone, which is the thing the notice is about. Keep it that way; a
// content-sniffing count would silently stop counting the payload type most worth counting. A result that never had a payload doesn't count: nothing was dropped, and there is
// nothing to re-run for — and neither does the pinned task spec, which is the whole point of the
// pin: it stays live, so a request whose ONLY summary-only payload is the spec has dropped nothing
// and must not claim otherwise. Prefix-stable needs no such exclusion — there the pin lives in
// batch aging, so an unpinned-and-unaged payload is already not counted.
export function droppedPayloadCount(history: Message[], prefixStable = false): number {
  const freshFrom = prefixStable ? 0 : findFreshToolBlockStart(history);
  const specIdx = prefixStable ? -1 : taskSpecIndex(history);
  return history.filter((m, i) =>
    m.role === 'tool' && m.payload && i !== specIdx
      ? prefixStable
        ? !!m.aged
        : i < freshFrom
      : false,
  ).length;
}

export function hasDroppedPayloads(history: Message[], prefixStable = false): boolean {
  return droppedPayloadCount(history, prefixStable) > 0;
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
// UI scrollback, never a turn boundary the model sees — and `harness`, a recovery nudge the model
// must read but which does not start a turn (see the field in types.ts). taskSpecIndex walks every user message (it
// falls through turns that landed no tool result); this names just the current one, which is what
// tells a pin belonging to THIS turn from one carried over from an earlier one.
export function lastUserMessageIndex(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && !m.meta && !m.harness) return i;
  }
  return -1;
}

export function taskSpecIndex(history: Message[]): number {
  for (let u = history.length - 1; u >= 0; u--) {
    const m = history[u];
    if (m.role !== 'user' || m.meta || m.harness) continue;
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
    rerender?: boolean;
    latches?: ShapeLatches;
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
      // `rerender` (the shape-rejection retry) ignores the stamps, so a frozen payload rejoins the
      // fresh split and can be traded against the reasoning the retry re-adds — a fixed cost is
      // exactly what the retry must not have, since the cap's whole job is to make that request fit.
      if (m.rendered !== undefined && !opts?.rerender) {
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
      const includeReasoning =
        !!opts?.latches?.reasoningRoundtrip ||
        (prefixStable ? !(m.role === 'assistant' && m.reasoningAged) : i >= keepReasoningFrom);
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
      // A skeleton is chars the request actually carries (up to ~1KB each, and a long session ages
      // many reads), so price what agedToolContent will emit rather than the summary alone —
      // under-counting here is what shrinks the fresh cap into an overflow.
      return agedContentChars(m);
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
// Structural residue for an aged unified diff, or null when the payload isn't one. `--- ` and
// `+++ ` alone are not evidence — they open plain prose and markdown rules — so an anchor line
// (`diff --git ` or a hunk header) is required before anything is kept. A page that carries no
// structural line at all (the tail of a hunk, e.g. `sed -n '301,317p'`) correctly returns null and
// ages to its summary: there is no map to keep.
function diffSkeleton(payload: string): string | null {
  const structural: string[] = [];
  let anchored = false;
  for (const line of payload.split('\n')) {
    if (!DIFF_STRUCTURE_RE.test(line)) continue;
    if (line.startsWith('diff --git ') || line.startsWith('@@ ')) anchored = true;
    structural.push(line);
  }
  if (!anchored || structural.length < 2) return null;
  // Head-first and whole lines only: the early hunks are the ones a later question is most likely
  // to be about, and half a hunk header is worse than one fewer.
  let kept = '';
  let n = 0;
  for (const line of structural) {
    if (kept.length + line.length + 1 > AGED_DIFF_SKELETON_CHARS) break;
    kept += (kept ? '\n' : '') + line;
    n++;
  }
  if (n === 0) return null;
  const rest = structural.length - n;
  return (
    `[reika: the body of this diff is no longer in context — a context-size limit, not a command ` +
    `error, and re-running this exact call won't help. Only its structure is kept below` +
    (rest > 0 ? `, and ${rest} further structural line(s) were dropped as well` : '') +
    `. You do NOT have the changed lines: do not quote a hunk, and do not state what one adds, ` +
    `removes or imports from memory — re-run the paged command above to see it again. If the file ` +
    `on disk disagrees with what you recall of this diff, the file is right.]\n\n${kept}`
  );
}

// Structural residue for an aged line-numbered `read`, or null when the payload isn't one. The
// gutter is the anchor — without it this is command output, which has no outline to keep — and two
// declarations are the minimum that makes a map rather than a fact.
// The file a read summary names: `Read <path> lines A-B of N`. The path is already in the message,
// so choosing a structure rule by extension needs no new plumbing — and an unrecognized shape
// (a summary from some other tool, a path with no extension) simply lands on the default rule.
function readExtension(summary: string): string {
  const path = summary.startsWith('Read ') ? summary.slice(5).split(' ')[0].replace(/:$/, '') : '';
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
}

// Whether one gutter-stripped line is structure, per the file's own shape (#269). Measured over 12
// real transcripts, the single-rule version scored 96% on plain source and 29%/0%/0% on test files,
// markdown and JSON — because `describe(`, `## Heading` and `"key":` are not declarations. Each
// rule is narrow and only ever applies to the extension that asked for it, so a wrong guess about
// one language cannot leak into another.
function isStructuralLine(content: string, ext: string): boolean {
  if (ext === 'md' || ext === 'markdown') return MARKDOWN_HEADING_RE.test(content);
  if (ext === 'json' || ext === 'jsonc') return JSON_KEY_RE.test(content);
  // Keywords stay column-zero-only: at any indent `const x = 1;` in a function body matches, and an
  // outline of locals is worse than no outline. Block openers do not have that problem (a body line
  // rarely ends in `{`), which is what lets them be read relative to the page — see shallowestIndent.
  if (content === content.trimStart() && DECLARATION_RE.test(content)) return true;
  if (!CODE_EXTENSIONS.has(ext)) return false;
  return !NON_STRUCTURE_RE.test(content) && BLOCK_OPENER_RE.test(content);
}

// Structure is relative to the PAGE, not to the file. A read of lines 42-186 lands inside a
// `describe(` whose opener is back at line 30, so every opener on the page is indented and a
// column-zero rule keeps nothing — 6 of the 12 remaining misses in the #269 measurement, plus
// `edit.ts lines 25-144`, which is entirely inside one object literal. Keeping the shallowest
// openers present gives each page the outline of its own scope: `it(` cases when the page is one
// suite's interior, `describe(` blocks when it is the whole file.
function shallowestIndent(contents: string[]): number {
  let min = Infinity;
  for (const c of contents) min = Math.min(min, c.length - c.trimStart().length);
  return min === Infinity ? 0 : min;
}

// How much of a subagent report an aged message keeps. Sized like a compaction note
// (agent/compactionreport.ts COMPACTION_NOTE_MAX_CHARS): the same class of artifact — the model's
// own digest of reads — and the same argument for keeping it, that it is already the compressed
// form. Head-first because the report directive (#344) puts the chain first and "Not covered"
// last, so a cut tail loses the list of gaps, not the findings. Whole lines, so a cut never lands
// mid-reference.
const REPORT_HEAD_CHARS = 2400;
// The subagent tool's summary shapes (`tools/subagent.ts` via makeSpawnSubagent): "Subagent
// completed (N chars)" and "Subagent (model) completed (N chars)". A budget refusal is also
// "Subagent …" but carries a short notice, not a report — it falls under the crumb floor anyway.
const SUBAGENT_SUMMARY_RE = /^Subagent(?: \([^)]*\))? completed \(/;

function reportHead(payload: string, summary: string): string | null {
  if (!SUBAGENT_SUMMARY_RE.test(summary)) return null;
  if (payload.length <= REPORT_HEAD_CHARS) return payload;
  const cut = payload.lastIndexOf('\n', REPORT_HEAD_CHARS);
  const head = payload.slice(0, cut > REPORT_HEAD_CHARS / 2 ? cut : REPORT_HEAD_CHARS).trimEnd();
  return `${head}\n(… report continues — ${payload.length - head.length} chars aged out; the head above is the chain, the cut part was what the subagent did not cover.)`;
}

function readSkeleton(payload: string, summary: string): string | null {
  const lines = payload.split('\n');
  const first = lines[0].match(READ_GUTTER_RE);
  if (!first) return null;
  const ext = readExtension(summary);
  const candidates: Array<{ line: string; content: string }> = [];
  for (const line of lines) {
    const m = line.match(READ_GUTTER_RE);
    if (!m || !isStructuralLine(m[2], ext)) continue;
    candidates.push({ line, content: m[2] });
  }
  const indent = shallowestIndent(candidates.map(c => c.content));
  const structural = candidates
    .filter(c => c.content.length - c.content.trimStart().length === indent)
    .map(c => c.line);
  // One structural line is still a map — `describe('footers', () => {` tells the model which suite
  // that range holds, and 4 of the #269 misses were exactly that. Below the crossover the whole
  // payload is kept anyway (agedToolContent), so a one-line outline can never be the expensive
  // branch. Zero is the only count with nothing to say.
  if (structural.length === 0) return null;
  // Head-first and whole lines only, as with diffSkeleton: the truncated tail is still covered by
  // the summary's range, and half a signature invites the model to complete it from memory.
  let kept = '';
  let n = 0;
  for (const line of structural) {
    if (kept.length + line.length + 1 > AGED_READ_SKELETON_CHARS) break;
    kept += (kept ? '\n' : '') + line;
    n++;
  }
  if (n === 0) return null;
  const rest = structural.length - n;
  return (
    `[reika: the body of this file read is no longer in context — a context-size limit, not a ` +
    `tool error. Only its structural lines are kept below, with their real line numbers` +
    (rest > 0 ? `, and ${rest} further structural line(s) were dropped as well` : '') +
    `. You do NOT have the contents: do not quote a line, and do not state what a section, ` +
    `function or import contains from memory. If you need one, read the narrow line range the ` +
    `outline points at rather than the whole file again. If the file on disk disagrees with what ` +
    `you recall, the file is right.]\n\n${kept}`
  );
}

// What an aged tool result serializes as, with the branch it took (AgedStats reads it). Summary
// only, except for a diff or a line-numbered read,
// which keep a bounded skeleton so the hole announces itself (AGED_*_SKELETON_CHARS). The two are
// mutually exclusive in practice — a diff has no gutter, a read has no hunk headers — so the order
// only settles the pathological case of a read of a .patch file, where the diff map is the better
// one.
// Chars an aged tool message actually contributes to a request. Exported because the aging walk
// (agent/compaction.ts) decides how much a shed payload frees, and if it prices one at its summary
// while serialization emits a skeleton — or the whole payload, under the crossover — the two
// disagree and the walk stops shedding while the request is still over target.
export function agedContentChars(
  msg: Extract<Message, { role: 'tool' }>,
  keepWhole?: boolean,
): number {
  return agedToolContent(msg, keepWhole).content.length;
}

// What this request does with each tool message. Computed once, read by both the crumb ceiling
// (#257) and the serialization loop, so "which payloads is this request evicting" has one answer
// instead of two copies of the same predicate drifting apart. The two modes disagree on what makes
// a payload live — prefix-stable liveness is sticky (`m.aged`, set only by batch aging) while the
// default is trailing-block-only — and that disagreement belongs here rather than at each use.
type ToolDisposition =
  // Payload serialized: frozen bytes under prefix-stable, capped under the default.
  | 'live'
  // Payload dropped for a summary, a skeleton, or — under a floor — its own bytes (agedToolContent).
  | 'aged'
  // Byte-identical repeat of a live payload: summary plus a back-reference (DEDUP_PAYLOADS only).
  | 'stub-fresh'
  // Byte-identical repeat within the aged trail, where the summary itself is what repeats.
  | 'stub-aged';

function toolDispositions(
  history: Message[],
  prefixStable: boolean,
  freshFrom: number,
  specIdx: number,
  stubbed: ReadonlySet<number>,
): Map<number, ToolDisposition> {
  const out = new Map<number, ToolDisposition>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'tool') continue;
    if (prefixStable) {
      out.set(i, m.payload && !m.aged ? 'live' : 'aged');
      continue;
    }
    const fresh = !!m.payload && (i >= freshFrom || i === specIdx);
    out.set(i, stubbed.has(i) ? (fresh ? 'stub-fresh' : 'stub-aged') : fresh ? 'live' : 'aged');
  }
  return out;
}

// Of the payloads this request ages, the crumbs that keep their bytes (#257): newest-first up to
// the aggregate ceiling. `continue` rather than `break` on the ceiling — a smaller, older crumb can
// still fit in what a larger one didn't, and skipping it would spend the exemption on nothing.
function agedWholeIndices(
  history: Message[],
  disposition: ReadonlyMap<number, ToolDisposition>,
): Set<number> {
  const aged = [...disposition].filter(([, d]) => d === 'aged').map(([i]) => i);
  const keep = new Set<number>();
  let total = 0;
  for (let k = aged.length - 1; k >= 0; k--) {
    const i = aged[k];
    const m = history[i];
    if (m.role !== 'tool' || !m.payload) continue;
    if (m.payload.length > SMALL_AGED_PAYLOAD_FLOOR_CHARS) continue;
    if (total + m.payload.length > SMALL_AGED_PAYLOAD_FLOOR_TOTAL_CHARS) continue;
    total += m.payload.length;
    keep.add(i);
  }
  return keep;
}

function agedToolContent(
  msg: Extract<Message, { role: 'tool' }>,
  // Whether the crumb floor's aggregate ceiling granted this payload its bytes. Undefined for the
  // estimators, which have no request-scoped budget to consult: they answer "crumb, so whole",
  // ignoring the ceiling. That is the safe direction — over-pricing an aged message shrinks the
  // fresh cap and makes the keep-budget walk fold sooner, while under-pricing one is what lets a
  // request the walk believed had shrunk go out over the window.
  keepWhole?: boolean,
): AgedContent {
  if (!msg.payload) return { content: msg.summary, kind: 'summary' };
  if (keepWhole ?? msg.payload.length <= SMALL_AGED_PAYLOAD_FLOOR_CHARS) {
    return { content: `${msg.summary}\n\n${msg.payload}`, kind: 'whole' };
  }
  // A subagent report before the skeletons: neither the diff map nor the read outline can see a
  // prose digest, so without this branch a 5k report aged to `Subagent completed (5165 chars)` —
  // a byte count — and the parent went back to reading the files the subagent had read, the exact
  // context spend delegation was meant to save (#354).
  const report = reportHead(msg.payload, msg.summary);
  if (report) return { content: `${msg.summary}\n\n${report}`, kind: 'report' };
  const diff = diffSkeleton(msg.payload);
  const skeleton = diff ?? readSkeleton(msg.payload, msg.summary);
  if (!skeleton) return { content: msg.summary, kind: 'summary' };
  // Second floor, for payloads over the crumb floor whose skeleton still isn't smaller than the
  // bytes it replaces (a long file of near-all-structural lines, say). Keeping them is never worse
  // for the window — the cost is bounded by the skeleton it displaces — and strictly better for the
  // model.
  if (skeleton.length >= msg.payload.length) {
    return { content: `${msg.summary}\n\n${msg.payload}`, kind: 'whole' };
  }
  return { content: `${msg.summary}\n\n${skeleton}`, kind: diff ? 'diff' : 'outline' };
}

// How many lines of THIS payload fit under the small-payload floor, i.e. the largest re-read that
// arrives whole. Said in lines because that is the unit the model controls (`limit`): it cannot see
// chars-per-line, and telling it only "narrower" sent one from 300 to 150 lines against a 2k cap —
// still 4x over, cut a second time, and it never learned why. Density is measured off the payload
// itself, so a comment-dense source file and a terse grep listing each get their own number.
function linesThatFitWhole(payload: string): number {
  const lines = payload.split('\n').length;
  const perLine = payload.length / Math.max(1, lines);
  return Math.max(1, Math.floor(SMALL_PAYLOAD_FLOOR_CHARS / perLine));
}

function capPayload(payload: string, cap: number | undefined): string {
  if (cap === undefined || payload.length <= cap) return payload;
  const fit = linesThatFitWhole(payload);
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
      `narrowed to return under that much (a targeted grep for one symbol, or a read of about ` +
      `${fit} lines of this output). Otherwise work from the summary line above.]`
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
    `the hidden part — about ${fit} lines of this output fit whole (${SMALL_PAYLOAD_FLOOR_CHARS} ` +
    `chars or less is always delivered in full). Output continues:]\n\n` +
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

export function toolsToChatTools(tools: Tool[]): ChatTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
