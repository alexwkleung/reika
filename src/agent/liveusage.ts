import { estimateTokens } from '../provider/tokens.js';
import type { Usage } from '../types.js';
import { derivedDecodeRate } from './decoderate.js';

// The status bar's figures for a request still in flight (#925). A real count only arrives in the
// stream's last chunk, on every endpoint, so these are estimates: display only, replaced when
// `usage` lands, and never read by calibration, the decode rate or the reserve (#906's rule).
export type LiveUsage = { promptTokens: number; completionTokens: number; rate?: number };

// Counts stream text rather than stream events, since a hosted API may batch tokens into one event.
export class LiveRound {
  private output = '';
  private firstOutputAt: number | undefined;

  constructor(
    private readonly promptTokens: number,
    private readonly density: number,
    private readonly report: (live: LiveUsage) => void,
    private readonly now: () => number = Date.now,
  ) {
    report({ promptTokens, completionTokens: 0 });
  }

  add(text: string): void {
    this.output += text;
    const at = this.now();
    this.firstOutputAt ??= at;
    const completionTokens = Math.round(estimateTokens(this.output) * this.density);
    // The chip's own sample bounds apply, so a first burst can't print a wild rate.
    const rate = derivedDecodeRate(
      { promptTokens: 0, completionTokens },
      { ttftMs: 0, totalMs: at - this.firstOutputAt },
    );
    this.report({
      promptTokens: this.promptTokens,
      completionTokens,
      ...(rate != null ? { rate } : {}),
    });
  }
}

export function withLiveUsage(total: Usage, live: LiveUsage | undefined): Usage {
  if (!live) return total;
  return {
    ...total,
    promptTokens: total.promptTokens + live.promptTokens,
    completionTokens: total.completionTokens + live.completionTokens,
    estimated: true,
  };
}
