import type { Config, ContextBundle, Message, Tool } from '../types.js';
import type { PromptMode } from './prompt.js';
import { buildRoundZeroPrefix, prefixStableActive } from './loop.js';
import { shouldCompact } from './compaction.js';
import { estimateRequestTokens } from '../provider/tokens.js';
import { callModel } from '../provider/client.js';
import { debugLog } from '../debug.js';

// EXPERIMENT (#81, REIKA_WARM=1): speculative KV-cache warming. On the first keystroke of a
// prompt, fire a throwaway 1-token request carrying the exact round-0 prefix — system +
// history minus the not-yet-typed user message — so a llama.cpp-style server prefills the KV
// cache in the typing gap. The engine matches by longest common token prefix and keeps
// processed KV in the slot cache even on client disconnect, so the real submit re-processes
// only the user message (and an aborted warm still helps). buildRoundZeroPrefix (agent/loop.ts)
// single-sources the prefix with runTurn's round 0; the drift test in warm.test.ts locks the
// two together. Strict no-op when the flag is off; every failure is swallowed (debugLog only) —
// a warm must never affect a turn, the UI, or the caller's history array.

// Everything the real turn will be dispatched with, captured at keystroke time. `config` must
// be the profile-resolved config and `calibration` the same learned factor the turn will get
// as priorCalibration, or the warm serializes different bytes than the real request.
export type WarmContext = {
  // The live UI history array; copied internally, never mutated.
  history: Message[];
  bundle: ContextBundle;
  config: Config;
  tools: Tool[];
  promptMode: PromptMode;
  calibration: number;
};

// Raw-estimate headroom reserved for the user message the warm can't see yet: if the submit
// would land close enough to the window to compact, compaction rewrites mid-history and the
// warmed prefix is wasted — skip instead of heating the box for nothing.
const USER_MSG_ALLOWANCE_TOKENS = 512;

export function warmEnabled(): boolean {
  return process.env.REIKA_WARM === '1';
}

// Identity of a warmable prefix. History length + a last-message fingerprint stand in for
// deep content identity: every turn and slash command appends to history, so the key rolls
// naturally; mode/model/baseURL/bundle cover everything else that changes the serialized
// prefix (`/model`, `/cd`, mode switches). No explicit invalidation needed anywhere.
export function warmKey(ctx: WarmContext): string {
  const last = ctx.history[ctx.history.length - 1];
  const lastLen = !last
    ? 0
    : last.role === 'tool'
      ? last.summary.length
      : 'content' in last
        ? last.content.length
        : 0;
  const fingerprint = last ? `${last.role}:${lastLen}` : 'empty';
  return [
    ctx.promptMode,
    ctx.config.model,
    ctx.config.baseURL,
    ctx.bundle.hash,
    ctx.history.length,
    fingerprint,
  ].join('\0');
}

// Build the warm request's payload: the exact system + history prefix runTurn's round 0 will
// send, minus the user message. Operates on a copy — buildRoundZeroPrefix splices the copy
// (plan-handoff distillation) but never mutates the shared message objects.
export function buildWarmPayload(ctx: WarmContext): { system: string; history: Message[] } {
  const history = ctx.history.slice();
  const system = buildRoundZeroPrefix({
    history,
    bundle: ctx.bundle,
    promptMode: ctx.promptMode,
    tools: ctx.tools,
    contextWindow: ctx.config.contextWindow,
    calibration: ctx.calibration,
    minGenTokens: ctx.config.minGenTokens,
  });
  return { system, history };
}

// Reasons not to warm, mirroring the loop's own compaction trigger (rawEstimate * calibration
// against the window) with the user-message allowance added. Returns null when warming is safe.
export function shouldSkipWarm(
  ctx: WarmContext,
  system: string,
  history: Message[],
): string | null {
  if (!ctx.config.contextWindow) return null;
  const estimate = estimateRequestTokens(system, history, ctx.tools, {
    contextWindow: ctx.config.contextWindow,
    calibration: ctx.calibration,
    reasoningRounds: ctx.config.reasoningRounds,
    minGenTokens: ctx.config.minGenTokens,
    prefixStable: prefixStableActive(ctx.config.contextWindow),
  });
  const projected = (estimate + USER_MSG_ALLOWANCE_TOKENS) * ctx.calibration;
  if (shouldCompact(projected, ctx.config.contextWindow, ctx.config.minGenTokens)) {
    return 'near-compaction';
  }
  return null;
}

export type PrefixWarmer = {
  // Fire-and-forget: dedupes, skips, and swallows every failure internally.
  onEdge(ctx: WarmContext): void;
  // Abort any in-flight warm (called at submit so the real request gets the server slot).
  cancel(reason: string): void;
};

export function createPrefixWarmer(): PrefixWarmer {
  let inflight: { key: string; controller: AbortController } | null = null;
  // The last prefix successfully warmed. A failed or aborted warm does NOT set this, so the
  // next edge retries — retries are human-paced (one edge per cleared input), never a hammer.
  let completedKey: string | null = null;

  return {
    onEdge(ctx: WarmContext): void {
      try {
        if (!warmEnabled()) return;
        const key = warmKey(ctx);
        if (key === completedKey || key === inflight?.key) {
          debugLog(`[reika:debug] warm skipped reason=dup mode=${ctx.promptMode}`);
          return;
        }
        // A different-key warm in flight is stale (mode/model/history moved on) — replace it.
        if (inflight) {
          inflight.controller.abort();
          inflight = null;
        }
        const { system, history } = buildWarmPayload(ctx);
        const skip = shouldSkipWarm(ctx, system, history);
        if (skip) {
          debugLog(`[reika:debug] warm skipped reason=${skip} mode=${ctx.promptMode}`);
          return;
        }
        const controller = new AbortController();
        inflight = { key, controller };
        const started = Date.now();
        debugLog(
          `[reika:debug] warm fired mode=${ctx.promptMode} model=${ctx.config.model} ` +
            `histLen=${history.length}`,
        );
        // callModel returns (not throws) on abort, so the aborted path lands in .then too.
        // Under REIKA_PREFIX_STABLE the warm serializes with the same frozen-byte semantics as
        // the real call (no trailing note — that lands after the warm's whole prefix), but must
        // never stamp `rendered` on shared history: freezing is the real call's job.
        void callModel({
          system,
          history,
          tools: ctx.tools,
          config: ctx.config,
          calibration: ctx.calibration,
          maxTokens: 1,
          signal: controller.signal,
          prefixStable: prefixStableActive(ctx.config.contextWindow),
          stampRenders: false,
        })
          .then(res => {
            if (inflight?.controller === controller) inflight = null;
            if (controller.signal.aborted) {
              debugLog(`[reika:debug] warm aborted ms=${Date.now() - started}`);
              return;
            }
            completedKey = key;
            debugLog(
              `[reika:debug] warm completed promptTokens=${res.usage?.promptTokens ?? '?'} ` +
                `cached=${res.usage?.cachedTokens ?? '?'} ms=${Date.now() - started}`,
            );
          })
          .catch((e: unknown) => {
            if (inflight?.controller === controller) inflight = null;
            debugLog(`[reika:debug] warm failed err=${e instanceof Error ? e.message : e}`);
          });
      } catch (e) {
        inflight = null;
        debugLog(`[reika:debug] warm failed err=${e instanceof Error ? e.message : e}`);
      }
    },

    cancel(reason: string): void {
      if (!inflight) return;
      inflight.controller.abort();
      inflight = null;
      debugLog(`[reika:debug] warm cancel reason=${reason}`);
    },
  };
}
