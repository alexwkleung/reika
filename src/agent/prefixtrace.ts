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
  // This request is shorter than the last (compaction spliced messages out).
  | 'shrunk';

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

  record(messages: Array<{ role: string }>): PrefixDivergence {
    const cur = messages.map(m => JSON.stringify(m));
    const roles = messages.map(m => m.role);
    const prev = this.prev;
    const prevRoles = this.prevRoles;
    this.prev = cur;
    this.prevRoles = roles;

    const totalChars = cur.reduce((a, s) => a + s.length, 0);
    const base = { totalMessages: cur.length, totalChars };
    if (!prev) {
      return { cause: 'first-request', stableMessages: 0, stableChars: 0, ...base };
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
