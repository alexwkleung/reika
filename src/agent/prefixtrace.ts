// Instrumentation for issue #69: how much of each request could an inference engine's
// prompt-prefix cache actually reuse? llama.cpp (and every LCP-style cache) reuses the KV state up
// to the first byte that differs from the previous request — and SWA/hybrid-memory models are all
// or nothing: any divergence before their checkpoint forces a FULL re-process. The harness's
// context discipline (payload aging, reasoning pruning, regenerated system suffixes, compaction)
// rewrites earlier bytes by design, so this trace makes the cost visible: per request, where the
// first divergence sits, what fraction of the prompt was stable, and which mechanism class caused
// it. Model-invisible — only the REIKA_DEBUG log reads it (see loop.ts's onRequest hook).
//
// Serialized-JSON chars are a proxy for template tokens — proportions and divergence *position*
// are what matter, not absolute counts.

export type PrefixCause =
  // No prior request to compare against (first round of a turn).
  | 'first-request'
  // The previous request is a byte-identical prefix of this one — the cacheable ideal.
  | 'append-only'
  // The leading system message changed (suffix ledgers, compaction recap) — invalidates everything.
  | 'system-changed'
  // A message between system and the tail changed (payload aging, reasoning pruning, re-capping).
  | 'mid-history'
  // The ONLY divergence is the slot the previous request's transient harness note occupied — the
  // round was a pure append and the note was displaced by it (see the `trailingNote` option).
  | 'trailing-note'
  // This request is shorter than the last (compaction spliced messages out).
  | 'shrunk'
  // The tool list differs from the previous request's (a report round that withheld tools, the
  // loop-breaking withdrawal). Templates render the list into the system turn — Qwen3.8 puts it
  // BEFORE the system prompt — so this invalidates from the first bytes whatever the messages did;
  // reported ahead of every message-level cause, with nothing counted stable, since the trace
  // cannot see where a given template places it (#426).
  | 'tools-changed';

export type PrefixDivergence = {
  cause: PrefixCause;
  // Messages (and chars) from the start that were byte-identical to the previous request.
  stableMessages: number;
  totalMessages: number;
  stableChars: number;
  totalChars: number;
  // Role of the first changed/removed message, when there is one.
  changedRole?: string;
};

export class PrefixTrace {
  private prev: string[] | null = null;
  private prevRoles: string[] = [];
  private prevHadNote = false;
  private prevTools = '';

  // `trailingNote` says the final message of THIS request is the transient harness note (loop
  // ledger / nudge) that prefix-stable mode rides at the end of the prompt. It is regenerated every
  // round and never enters history, so the next round's append lands *on its slot* — which the
  // byte comparison correctly sees as a divergence, but which is not history churn. Told about it,
  // the next record() names that case instead of reporting `mid-history firstChanged=assistant` for
  // what was a pure append. See issue #253: on a 24k run this was a constant 436 chars/round, and
  // the label made it read as reasoning-aging invalidating the cache on every single round.
  //
  // `tools` is the request's tool list as serialized on the wire (any stable string form). The
  // messages alone cannot show a tool-list change, and that was how the report round's full
  // re-prefill stayed invisible: byte-identical messages, no tools, `trailing-note` in the log.
  record(
    messages: Array<{ role: string }>,
    opts?: { trailingNote?: boolean; tools?: unknown },
  ): PrefixDivergence {
    const cur = messages.map(m => JSON.stringify(m));
    const roles = messages.map(m => m.role);
    const tools = opts?.tools === undefined ? '' : JSON.stringify(opts.tools);
    const prev = this.prev;
    const prevRoles = this.prevRoles;
    const prevHadNote = this.prevHadNote;
    const prevTools = this.prevTools;
    this.prev = cur;
    this.prevRoles = roles;
    this.prevHadNote = !!opts?.trailingNote;
    this.prevTools = tools;

    const totalChars = cur.reduce((a, s) => a + s.length, 0);
    const base = { totalMessages: cur.length, totalChars };
    if (!prev) {
      return { cause: 'first-request', stableMessages: 0, stableChars: 0, ...base };
    }
    if (tools !== prevTools) {
      return { cause: 'tools-changed', stableMessages: 0, stableChars: 0, ...base };
    }
    let i = 0;
    while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
    let stableChars = 0;
    for (let j = 0; j < i; j++) stableChars += cur[j].length;

    if (i === prev.length) {
      // Everything previously sent is intact (a byte-identical retry counts too).
      return { cause: 'append-only', stableMessages: i, stableChars, ...base };
    }
    if (i === cur.length) {
      return {
        cause: 'shrunk',
        stableMessages: i,
        stableChars,
        changedRole: prevRoles[i],
        ...base,
      };
    }
    // Count the intra-message common prefix too — the engine caches bytes, not messages.
    stableChars += lcpLength(prev[i], cur[i]);
    if (prevHadNote && i === prev.length - 1) {
      // Everything the previous request sent BEFORE its note is intact: the note's slot is the only
      // thing that moved. No `changedRole` — the cause already names what changed, and reporting
      // the role that displaced the note is the misreading this case exists to prevent.
      return { cause: 'trailing-note', stableMessages: i, stableChars, ...base };
    }
    return {
      cause: i === 0 ? 'system-changed' : 'mid-history',
      stableMessages: i,
      stableChars,
      changedRole: roles[i],
      ...base,
    };
  }
}

function lcpLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let k = 0;
  while (k < n && a[k] === b[k]) k++;
  return k;
}
