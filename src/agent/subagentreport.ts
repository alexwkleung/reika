import type { Message } from '../types.js';

// Subagent bounded return (#340). A subagent's end product is a report, exactly as plan mode's is a
// plan, and it needs the same closure signal: without one, a subagent under aging re-reads what it
// lost until someone aborts it (observed: 90 minutes, 14 slices of one file, `(aborted)` handed
// back to the parent). At its last round the loop withdraws every tool and sends this; the reply is
// the digest. Partial and grounded beats nothing.
//
// "Not covered" is asked for by name because it is what the parent acts on: the coverage note below
// is the harness's deterministic version of the same list, and the two together are what let the
// parent hand the remainder to a second subagent instead of reading it into its own context.
export const SUBAGENT_REPORT_DIRECTIVE =
  '(reika: this is your last round and tools are withdrawn. Write your report now from what you ' +
  'have already read: the chain in order with file and function names, what each does, and any ' +
  'string the task asked for quoted verbatim. Then, under "Not covered:", list every file or ' +
  'question from the task you did not get to. Do not apologise and do not ask to continue.)';

// The directive above only reaches a subagent that runs to its cap; one that finishes early writes
// its report under the agent prompt's "Be concise" alone, and a thin report is what sent the #340
// parent back to re-read what its subagent had covered. So the report's shape rides the subagent's
// system prompt from round 0 — stable for the whole run, so no cache churn. File and function names,
// not line numbers: pinning lines is what drove a subagent to read one file in 14 slices (#341).
export const SUBAGENT_REPORT_FRAME = [
  'You are a subagent. Your final message is the report the parent agent acts on, and the only part',
  'of your work it sees. Keep messages between tool calls short, but make the report complete: the',
  'chain in order with file and function names, what each does, and any string the task asked for',
  'quoted verbatim. Name files and functions, not line numbers.',
].join('\n');

// Subagent DECISIONS per parent turn — rounds that dispatched at least one subagent. The coverage
// note invites a re-spawn for what a subagent left unread, so the loop needs a floor under it: a
// model that re-spawns on every return would burn N × the subagent cap in rounds and evict the
// parent's KV prefix each time. 3 covers a task, its remainder, and one retry.
//
// Counted per round, not per call (#354): a parent that decomposes a task into four stage-wise
// subagents in ONE round has made one decision, and the fourth call being refused by a cap sized
// for serial re-spawns left a stage untraced. Width within a round is bounded separately below.
export const MAX_SUBAGENTS_PER_TURN = 3;
// Parallel subagent calls honoured within one round. On a single-slot server they run one after
// another at up to a full subagent budget each, so width is wall-clock: 4 stages is a decomposition,
// "one per file" is a runaway.
export const MAX_SUBAGENTS_PER_ROUND = 4;
export type SubagentBudget = { rounds: number; inRound: number };

// A subagent call is exclusive in its round (#346). Returned in place of a sibling inspection call
// (read/grep/glob/list, or an inspection-shaped bash) issued alongside `subagent`. The first
// bounded-return run had the parent "call subagent (mandatory first call) and read a few core
// files in parallel": four fresh payloads shared the window on the next round and all four were
// truncated — INCLUDING the 6400-char report — after which the parent re-read files the report had
// already covered because its own capped copies looked incomplete. Holding the siblings is what
// guarantees the report arrives as the only fresh payload in its round, with the full cap. No
// content, so it can't re-fuel anything (cf. WITHDRAWAL_DIRECTIVE); it states the rule and the way
// out.
export const SUBAGENT_HOLD_NOTE =
  '(reika: held — the subagent you dispatched this round covers exploration, and its report ' +
  'arrives with this round. Use the report; hand it anything the report leaves open rather than ' +
  'reading it here.)';

// Path-like tokens in free text: at least one directory separator and an extension, bare or in
// backticks, allowed to end a sentence. The parent writes the task as prose ("In src/tools/bash.ts
// (and any helpers…)"), so the plan grounder's backtick-only extraction would see none of it. The
// directory component is required on purpose: a bare `types.ts` is plausible in a task, but
// without it "e.g." and "config.autoApprove"-style tokens need an extension allowlist to exclude.
const PATH_TOKEN =
  /(?:^|[\s(`'",:;])((?:\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,6})(?=[\s)`'",:;.]|$)/g;

function normalize(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

// Files the task names, in order of first mention, deduped.
export function extractTaskPaths(task: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of task.matchAll(PATH_TOKEN)) {
    const p = normalize(m[1]);
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// Files the subagent actually opened with `read` — any range counts. grep/glob hits don't: a match
// list is not the file, and the spiral this exists to report on was a model grepping a symbol into
// 37 matches and never following them.
export function readPathsIn(history: Message[]): Set<string> {
  const out = new Set<string>();
  for (const m of history) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      if (c.name !== 'read') continue;
      const p = c.args.path;
      if (typeof p === 'string' && p.trim()) out.add(normalize(p.trim()));
    }
  }
  return out;
}

// A task path counts as read if a read path equals it or ends with it (the task says
// `tools/bash.ts`, the model reads `src/tools/bash.ts`), or the reverse.
function wasRead(taskPath: string, reads: Set<string>): boolean {
  for (const r of reads) {
    if (r === taskPath || r.endsWith('/' + taskPath) || taskPath.endsWith('/' + r)) return true;
  }
  return false;
}

// Appended to the subagent's digest when the task named files the subagent never opened. Empty
// when the task named nothing path-like (nothing to check against) or everything was read. It is
// an observation, not a directive: the parent's routing rule already says what to do with a
// multi-file remainder, and the observed failure (#273 arm 2) was the parent planning to "verify
// myself" — reading the remainder into the context the subagent was meant to protect.
export function buildCoverageNote(task: string, history: Message[]): string {
  const named = extractTaskPaths(task);
  if (named.length === 0) return '';
  const reads = readPathsIn(history);
  const unread = named.filter(p => !wasRead(p, reads));
  if (unread.length === 0) return '';
  const read = named.filter(p => wasRead(p, reads));
  return (
    `(reika: the task named ${named.length} file${named.length === 1 ? '' : 's'}; the subagent ` +
    (read.length > 0 ? `read ${read.join(', ')} and ` : '') +
    `did not read ${unread.join(', ')}. If the report leaves those open, hand them to subagent ` +
    'again rather than reading them here.)'
  );
}
