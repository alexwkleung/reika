// Per-turn generation budget: the max_tokens backstop and the one generation-reserve
// number the fit-to-window cap and the compaction trigger also derive from.
//
// The mental model (see also ./toolcall.ts and ../agent/compaction.ts):
//   - max_tokens is the *ceiling*: window − prompt − margin. It only fires on a genuine
//     spiral; on a normal turn there's room to spare.
//   - minGenTokens is the *floor*, enforced upstream by compaction keeping the prompt
//     under window − minGen. So the ceiling lands ≥ minGen on every normal turn — the
//     two meet without either side double-enforcing, and an explicit REIKA_MAX_TOKENS
//     still wins as a hard cap.

// Generation room reserved from the window, in tokens. Reasoning-OFF models need ~2K
// (a tool call plus brief prose); reasoning-ON thinking models want 6–8K of think-room
// before the call. Per-profile via REIKA_MIN_GEN_TOKENS so a 16k thinking model and a
// 128k model tune independently. This is the shared default when none is configured.
export const DEFAULT_MIN_GEN_TOKENS = 2048;

// Subtracted from the computed ceiling as slack for tokenizer-estimate drift and the
// special tokens the chat template adds, so a slightly-off prompt estimate doesn't bump
// the server's hard wall and truncate a tool call mid-emission.
export const BUDGET_MARGIN_TOKENS = 384;

// The per-turn max_tokens to send. Returns the room actually left in the window (or the
// user's fixed cap, whichever is smaller); undefined — meaning "use the server default",
// the pre-existing behavior — when the window is unknown. The minGen floor is NOT applied
// here on purpose: it's guaranteed by compaction, and forcing it up would override an
// intentionally-small REIKA_MAX_TOKENS. The 256 floor is a last-resort so a prompt that
// (even after compaction) nearly fills the window still gets a few tokens to emit an
// error or a terse reply rather than a zero-budget request.
export function computeMaxTokens(opts: {
  contextWindow?: number;
  promptTokens: number; // calibrated, real-token estimate of the prompt
  userMaxTokens?: number;
}): number | undefined {
  const { contextWindow: cw, promptTokens, userMaxTokens } = opts;
  if (!cw) return userMaxTokens;
  const ceiling = Math.max(256, cw - promptTokens - BUDGET_MARGIN_TOKENS);
  return userMaxTokens ? Math.min(userMaxTokens, ceiling) : ceiling;
}

// Consecutive length-stops the loop will try to recover from before accepting the partial.
export const MAX_LENGTH_RETRIES = 1;

// A `length` finish_reason with no usable tool call is generation cut off mid-thought (the
// backstop firing, or a spiral hitting max_tokens) — not a real final answer. The loop
// nudges once to recover; a second consecutive truncation means the model is stuck, so it
// accepts the partial and stops rather than looping. A length-stop that still produced a
// tool call is left alone — the call closed before the cut, so it's usable.
export function shouldRetryTruncated(opts: {
  finishReason?: string;
  hasToolCalls: boolean;
  priorRetries: number;
}): boolean {
  return (
    opts.finishReason === 'length' && !opts.hasToolCalls && opts.priorRetries < MAX_LENGTH_RETRIES
  );
}
