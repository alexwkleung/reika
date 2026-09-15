// EXPERIMENT (#343, REIKA_SUBAGENT_PRESSURE=1): the mid-session subagent trigger, harness-driven.
//
// The routing rule (#335) handles a request that ARRIVES trace-shaped. Mid-session the model has
// something it never has at round 0 — a grep or glob result — and "N files match" is an
// observation, not a forecast. #335's permission-shaped arm got 0/2 because its trigger was a
// forecast; #280's run 3 showed the model delegating unprompted the moment a harness line told it
// "the context is about to be compacted". So: put the pressure in front of the model at the moment
// of decision, in the channel it is already reading (the #102 tool-output-affordance move).
//
// Gated on pressure because a subagent call evicts the parent's KV prefix on a single-slot server
// and costs a full re-prefill on resume. Below the compaction threshold that is a pure loss; at
// the threshold a shed is coming anyway — it reprocesses the whole prefix too — so a subagent
// call there costs the same one reprocess and PREVENTS the shed, because the reads never enter
// the parent. The harness has both numbers (files in the result, estimate vs threshold); the
// model has neither.
//
// Rides the payload as a footer, where the spill and cap footers already live: capPayload keeps
// head and tail, so a footer survives the cap. Once per turn. Never inside a subagent (it has no
// subagent tool). Flag read per call; strict no-op when off.

export function subagentPressureEnabled(): boolean {
  return process.env.REIKA_SUBAGENT_PRESSURE === '1';
}

// The tool description's own trigger (">3 files").
export const PRESSURE_MIN_FILES = 4;
// What reading one of those files would cost: a default read page (300 lines) is ~10k chars, so
// ~2.5k tokens. The forecast is "the model reads the files it just found", capped at a handful —
// the question is whether the NEXT few reads cross the threshold, not whether all N would.
export const READ_COST_TOKENS = 2500;
export const PRESSURE_READ_HORIZON = 4;

// Distinct files a grep/glob result spans. grep lines are `path:LINE: text` / `path:LINE- text`
// with `--` separators (tools/grep.ts); glob lines are one path each. Footers (spill locator, cap
// marker) start with `[` or `(` and are skipped; a line without a path shape is skipped.
export function filesInResult(tool: string, payload: string | undefined): number {
  if (!payload) return 0;
  const files = new Set<string>();
  for (const raw of payload.split('\n')) {
    const line = raw.trim();
    if (!line || line === '--' || line.startsWith('[') || line.startsWith('(')) continue;
    if (tool === 'grep') {
      const m = line.match(/^(.+?):\d+[:-] /);
      if (m) files.add(m[1]);
    } else if (tool === 'glob') {
      files.add(line);
    }
  }
  return files.size;
}

// Whether the reads this result invites would push the request over the compaction threshold.
export function underPressure(opts: {
  files: number;
  estimateTokens: number;
  thresholdTokens: number;
}): boolean {
  if (opts.files < PRESSURE_MIN_FILES) return false;
  const reads = Math.min(opts.files, PRESSURE_READ_HORIZON);
  return opts.estimateTokens + reads * READ_COST_TOKENS > opts.thresholdTokens;
}

export function buildSubagentAffordance(files: number): string {
  return (
    `(reika: ${files} files match. Reading them all here would push the context past its limit ` +
    'and force a shrink that drops what you have already read. Hand the list to subagent with ' +
    'what you need from each — its reads stay out of your context and its report comes back ' +
    'bounded, with a note naming any file it did not get to.)'
  );
}
