// Measurement-only instrumentation for the spill mechanism (`_spill.ts`). Records nothing about
// what a command or search *contained* — only sizes, and whether the saved artifact was opened.
//
// This exists to answer the one question the eval fixtures cannot: how often over-cap results
// happen in real use. An eval can show that a model follows a locator when the answer is only in
// the artifact; it cannot show what share of a week's `bash` calls exceed 64KB at all, and that is
// what decides whether the retained window is sized right or is provisioned for a case that fires
// twice a month.
//
// Deliberately NOT on `debugLog`: that sink is for one session (its default path truncates per
// process, #114) and turns on a flood of unrelated diagnostics. A passive measurement that runs
// for a week needs its own append-only file that costs nothing to leave enabled.
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function spillStatsEnabled(): boolean {
  return process.env.REIKA_SPILL_STATS === '1';
}

function statsPath(): string {
  return (
    process.env.REIKA_SPILL_STATS_FILE || join(homedir(), '.config', 'reika', 'spill-stats.jsonl')
  );
}

// One line per event, appended. JSONL rather than a running tally so the distribution survives —
// "how big are over-cap runs" and "how often" need the individual sizes, and a counter would
// answer only the second.
function write(event: Record<string, unknown>): void {
  if (!spillStatsEnabled()) return;
  try {
    appendFileSync(statsPath(), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch {
    // Best-effort: measurement must never break a turn. Same rule as the spill itself.
  }
}

// A tool result that exceeded its inline cap. `total`/`shown` are in the tool's own unit (bytes
// for bash, matches/paths for the search tools) — mixing units in one field is fine because
// `tool` disambiguates and nothing aggregates across tools.
export function recordCapped(opts: {
  tool: 'bash' | 'grep' | 'glob';
  total: number;
  shown: number;
  // Whether an artifact was written, and whether it held the whole result. `complete: false` is
  // the signal that a window is too small — for bash it means the 4MB tail dropped a middle.
  spilled: boolean;
  complete?: boolean;
}): void {
  write({ event: 'capped', ...opts });
}

// The model referenced a path we handed out. This is the payoff side of the ledger: `capped`
// events without matching `followed` events are windows being retained for nothing.
export function recordFollowed(opts: { by: string }): void {
  write({ event: 'followed', ...opts });
}
