import type { EnginePrompt, EngineTimings } from '../provider/client.js';
import { estimateTokens } from '../provider/tokens.js';
import type { Usage } from '../types.js';
import { derivedDecodeRate, engineDecodeRate } from './decoderate.js';

// The status bar's figures for a request still in flight (#925). A real count only arrives in the
// stream's last chunk, unless the engine sends running totals (llama.cpp's `timings_per_token`), so
// these are usually estimates. Either way they are display only, replaced when `usage` lands, and
// never read by calibration, the decode rate or the reserve (#906's rule). `exact` marks a report
// whose counts all came from the engine.
export type LiveUsage = {
  promptTokens: number;
  completionTokens: number;
  rate?: number;
  exact?: boolean;
};

// Estimates from stream text rather than stream events, since a hosted API may batch tokens into
// one event. The first engine report ends the estimating for the round: the two disagree, so
// alternating between them would make the chips jump.
export class LiveRound {
  private output = '';
  private firstOutputAt: number | undefined;
  private engineReported = false;

  constructor(
    private readonly promptTokens: number,
    private readonly density: number,
    private readonly report: (live: LiveUsage) => void,
    private readonly now: () => number = Date.now,
  ) {
    report({ promptTokens, completionTokens: 0 });
  }

  add(text: string): void {
    if (this.engineReported) return;
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

  engine(timings: EngineTimings, prompt: EnginePrompt | undefined): void {
    this.engineReported = true;
    // Both halves or neither: `prompt_n` alone is only what the cache could not serve.
    const promptReported = prompt?.promptN != null && prompt.cacheN != null;
    const rate = engineDecodeRate(timings);
    this.report({
      promptTokens: promptReported ? prompt.promptN! + prompt.cacheN! : this.promptTokens,
      completionTokens: timings.predictedN,
      ...(rate != null ? { rate } : {}),
      ...(promptReported ? { exact: true } : {}),
    });
  }
}

export function withLiveUsage(total: Usage, live: LiveUsage | undefined): Usage {
  if (!live) return total;
  return {
    ...total,
    promptTokens: total.promptTokens + live.promptTokens,
    completionTokens: total.completionTokens + live.completionTokens,
    ...(live.exact ? {} : { estimated: true }),
  };
}
