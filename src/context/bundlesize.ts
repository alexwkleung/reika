import { buildSystemPrompt } from '../agent/prompt.js';
import { estimateTokens } from '../provider/tokens.js';
import { compactThreshold } from '../agent/compaction.js';
import { DEFAULT_MIN_GEN_TOKENS } from '../provider/budget.js';
import type { ContextBundle } from '../types.js';

// The opening bundle is built once per session and then carried in every request, so its size
// is a fixed prefill cost paid on every round. On a slow local endpoint (~23 tok/s measured on
// an M2 serving a 27B) round 0 alone is minutes of wall clock before the first token, and
// nothing reported how big it was — see #194. This turns the bundle into a readable number.

export type BundleSection = {
  name: string;
  chars: number;
  tokens: number;
};

// Only the sections buildSystemPrompt interpolates. fileIndex and skills live in the bundle
// but never reach the prompt (mention expansion and skill routing consume them locally), so
// counting them here would overstate the prefill cost.
export function bundleSections(bundle: ContextBundle): BundleSection[] {
  return (['projectSummary', 'repoMap', 'instructions'] as const).map(name => ({
    name,
    chars: bundle[name].length,
    tokens: estimateTokens(bundle[name]),
  }));
}

// `prompt` is the agent-mode system prompt: the sections plus the fixed rules block and cwd
// line — what round 0 actually prefills. Plan mode differs by ~150 chars; agent is the default
// and the useful reference point, so one number stays comparable across sessions.
export function formatBundleSize(bundle: ContextBundle): string {
  const sections = bundleSections(bundle);
  const chars = sections.reduce((n, s) => n + s.chars, 0);
  const tokens = sections.reduce((n, s) => n + s.tokens, 0);
  const prompt = buildSystemPrompt({ bundle, mode: 'agent' });
  return (
    `[reika:debug] bundle hash=${bundle.hash} ` +
    `${sections.map(s => `${s.name}=${s.chars}c/${s.tokens}t`).join(' ')} ` +
    `sections=${chars}c/${tokens}t prompt=${prompt.length}c/${estimateTokens(prompt)}t`
  );
}

// Room the conversation actually gets: what compaction lets the prompt grow to, minus the
// fixed system block that is in every request. Everything else — history, recaps, and the
// fresh tool payloads the fit-to-window cap divides — lives inside this number.
export function historyBudgetTokens(
  bundle: ContextBundle,
  contextWindow: number,
  minGenTokens?: number,
): number {
  const prompt = buildSystemPrompt({ bundle, mode: 'agent' });
  return Math.round(compactThreshold(contextWindow, minGenTokens) - estimateTokens(prompt));
}

// Below this many tokens of history budget the harness stops working rather than degrading:
// every read comes back a fragment, so the model re-reads the same file instead of finishing.
// Calibrated on one machine against a ~2,060t system block (issue #262): 3,208t derailed a run
// (caps of 2.6-3.4KB, 13 of 17 rounds truncated, the same 455-line file read three times),
// 6,808t was tight but workable, 14,008t was fine. A floor between the two, nearer the bad end
// so an ordinary tight config isn't nagged.
export const MIN_WORKABLE_HISTORY_TOKENS = 4096;

// The same arithmetic as a debug line, logged every session whether or not it warns: the
// numbers behind a degraded run are otherwise unrecoverable after the fact (#262).
export function formatBudget(
  bundle: ContextBundle,
  opts: { contextWindow?: number; minGenTokens?: number },
): string {
  const cw = opts.contextWindow;
  if (!cw) return '[reika:debug] budget window=unset (no cap, no floor)';
  const reserve =
    opts.minGenTokens && opts.minGenTokens > 0 ? opts.minGenTokens : DEFAULT_MIN_GEN_TOKENS;
  const threshold = Math.round(compactThreshold(cw, opts.minGenTokens));
  const systemTokens = estimateTokens(buildSystemPrompt({ bundle, mode: 'agent' }));
  const history = historyBudgetTokens(bundle, cw, opts.minGenTokens);
  return (
    `[reika:debug] budget window=${cw} reserve=${reserve} threshold=${threshold} ` +
    `system=${systemTokens}t history=${history}t floor=${MIN_WORKABLE_HISTORY_TOKENS}` +
    `${history < MIN_WORKABLE_HISTORY_TOKENS ? ' UNWORKABLE' : ''}`
  );
}

// One startup line when the configured window and generation reserve leave too little room to
// work in — the numbers exist at startup but nothing reported them, so a misconfigured run was
// indistinguishable from a bad model or a harness bug (#262). Returns undefined when the budget
// is workable, or when no window is configured (nothing is capped then, so there is no floor).
export function budgetWarning(
  bundle: ContextBundle,
  opts: { contextWindow?: number; minGenTokens?: number },
): string | undefined {
  const { contextWindow: cw, minGenTokens } = opts;
  if (!cw) return undefined;
  const budget = historyBudgetTokens(bundle, cw, minGenTokens);
  if (budget >= MIN_WORKABLE_HISTORY_TOKENS) return undefined;
  const reserve = minGenTokens && minGenTokens > 0 ? minGenTokens : DEFAULT_MIN_GEN_TOKENS;
  const systemTokens = estimateTokens(buildSystemPrompt({ bundle, mode: 'agent' }));
  const n = (t: number): string => t.toLocaleString('en-US');
  return (
    `Context budget is very small: ~${n(budget)} tokens for conversation and tool results ` +
    `(window ${n(cw)} − generation reserve ${n(reserve)} → ${n(Math.round(compactThreshold(cw, minGenTokens)))} usable, ` +
    `− system prompt ${n(systemTokens)}). Expect reads to come back truncated every round. ` +
    `Raise REIKA_CONTEXT_WINDOW, or lower REIKA_MIN_GEN_TOKENS if the model does not need ` +
    `${n(reserve)} tokens of generation room.`
  );
}
