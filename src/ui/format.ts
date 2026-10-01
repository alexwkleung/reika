import { MCP_TOOL_PREFIX, type McpServerConfig } from '../mcp/config.js';

// Single source of truth for duration formatting so the status bar, "Worked for" scrollback
// lines, transcript exports, and /summary all render times identically (issue #74). Fields are
// zero-padded because the status bar ticks every second and must not jitter in width.
export function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

// Convenience for call sites holding milliseconds.
export function formatDurationMs(ms: number): string {
  return formatElapsed(Math.round(ms / 1000));
}

// Compact token counts: `999`, `1.2k`, `126k`, `1.3M`, `2.5B`. Lives here rather than in the
// status bar because the saved transcript's header quotes the same numbers (issue #199), and the
// two must not drift.
export function kFormat(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  if (n < 10_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n < 1_000_000_000) return Math.round(n / 1_000_000) + 'M';
  if (n < 10_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  return Math.round(n / 1_000_000_000) + 'B';
}

// `21 tok/s`, `8.4 tok/s`, `1.2k tok/s` — the decode throughput of the last measurable round, as
// the status bar shows it (#204). One decimal below 10, where the difference between 3.1 and 3.4 is
// what the reader is looking at, and whole numbers above it, where it isn't; four digits and up are
// compacted like token counts. Empty when no round has been measurable yet.
export function formatTokensPerSecond(rate?: number): string {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return '';
  // Rounded before the branch: 999.6 would otherwise print `1000 tok/s`, a width the chip never
  // shows for any other rate, one tick before `1.0k tok/s`.
  const whole = Math.round(rate);
  if (whole >= 1000) return `${kFormat(whole)} tok/s`;
  return `${rate < 10 ? Number(rate.toFixed(1)) : whole} tok/s`;
}

// Fraction of a context ceiling currently used, or null when either operand is unknown. The
// ceiling callers pass is the USABLE window (compactThreshold: window minus the generation reserve,
// under the safety factor) when they know it, not the raw window: history is shed at the usable
// ceiling, so a raw-window fraction tops out well short of 100% and reads as headroom that history
// will never get. At a 24k window with a 6144 reserve the shed trigger sits at 67% of the raw
// window, which is also why an `>= 0.8` warning color keyed to the raw fraction never fired.
export function contextFill(contextTokens?: number | null, ceiling?: number): number | null {
  if (!contextTokens || !ceiling) return null;
  return contextTokens / ceiling;
}

// `3 sheds · 1 fold` — the status line's shrink chips and the transcript header's `# shrink:`
// line, from one place so they can't drift. Empty when nothing has shrunk: the chips are absent,
// not `0 sheds`, because on a large window they never fire and a zero would be a standing question.
export function formatShrink(sheds: number, folds: number): string {
  const parts: string[] = [];
  if (sheds > 0) parts.push(`${sheds} shed${sheds === 1 ? '' : 's'}`);
  if (folds > 0) parts.push(`${folds} fold${folds === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// Names printed before the `+N more` tail; the line answers "what is it waiting for", not "what is
// configured" — `/mcp` is the inventory.
const STARTING_MCP_NAMES = 3;

// The one thing the pre-session frame says (#265). Bootstrap is otherwise silent and fast — its
// other legs are local and land in ~100ms — but an MCP server is a spawned subprocess whose
// handshake can take CONNECT_TIMEOUT_MS, and it is the only leg whose names are known before it
// finishes: `loadConfig` parses the server list synchronously, so the frame can say what it is
// waiting on rather than spinning. Undefined when no server is configured, which is the common
// launch — there the frame stays blank until the session lands, rather than printing a placeholder.
// `Starting MCP: mini, files…` / `Starting MCP: a, b, c +2 more…`.
export function mcpStartupLine(servers: readonly McpServerConfig[]): string | undefined {
  if (servers.length === 0) return undefined;
  const names = servers.slice(0, STARTING_MCP_NAMES).map(s => s.name);
  const rest = servers.length - names.length;
  return `Starting MCP: ${names.join(', ')}${rest > 0 ? ` +${rest} more` : ''}…`;
}

// Display name for a tool in the scrollback chip. Tool names are model-facing and picked for the
// model's benefit — `ask_user` names who is being asked, which a bare `ask` doesn't — but the chip
// is user-facing, where the one-word shape every other tool has reads better than a raw
// snake_case identifier. Only names needing an override are listed; everything else capitalizes.
// Both the rendered label and the hanging-wrap width math go through this, so they cannot drift.
const TOOL_LABELS: Record<string, string> = { ask_user: 'Ask', fetch_url: 'Fetch' };

export function toolLabel(name: string): string {
  const override = TOOL_LABELS[name];
  if (override) return override;
  if (name.startsWith(MCP_TOOL_PREFIX)) return `Mcp ${mcpNameTail(name)}`;
  return name.length > 0 ? name[0].toUpperCase() + name.slice(1) : name;
}

// `fs__read_file` → `fs:read_file`. The first `__` after the prefix is the one the namespace
// inserted; a later one belongs to the server's own tool name and is left alone.
function mcpNameTail(name: string): string {
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  return sep === -1 ? rest : `${rest.slice(0, sep)}:${rest.slice(sep + 2)}`;
}

// The in-flight verb for a call the loop has just dispatched (#509), for the live `↳ Running…` row
// `Scrollback` draws in the result's place. Each one parallel the past-tense verb its committed
// summary actually uses — `Ran:`, `Edited`, `Wrote`, `Read`, `Listed`, `Fetched`, `Asked`, and the
// `Found N matches` / `Found N file(s) matching` pair — so the pending row is the result row's own
// slot with the result not in it yet: one word swaps for the other and nothing on the line moves.
// The file-search pair reads `Matching…` rather than sharing web `search`'s `Searching…`: each verb
// names its own committed noun (matches / files matching, against results), and one word for both
// would read a local regex scan as an outbound query — the more expensive of the two to mistake.
const TOOL_VERBS: Record<string, string> = {
  read: 'Reading',
  list: 'Listing',
  grep: 'Matching',
  glob: 'Matching',
  edit: 'Editing',
  write: 'Writing',
  bash: 'Running',
  fetch_url: 'Fetching',
  search: 'Searching',
  ask_user: 'Asking',
  subagent: 'Delegating',
};

// Anything unlisted still gets an honest row rather than none: the label is ephemeral and carries
// no claim beyond "this call is in flight". MCP tools are unlisted by name on purpose — the set is
// whatever the user configured — but the prefix is enough to name the verb (#265).
export function toolVerb(name: string): string {
  if (name.startsWith(MCP_TOOL_PREFIX)) return 'Calling';
  return TOOL_VERBS[name] ?? 'Working';
}

// The elapsed chip for a call (#585), on both rows it appears on: the in-flight `↳ Running…` row
// #509 draws while it runs, and the `↳ Ran: …` row it commits as. One rule for the two, because the
// chip has to be the same in both for the swap at commit to be a text-only change of verb.
//
// Held back until the call has been running `TIMER_AFTER_S`: under that the question the chip
// answers ("is this stuck?") has not been asked yet, and a number counting up over every `ls` is a
// flicker rather than a signal. An empty return is what keeps every short call's row — live and
// committed — byte-identical to what it was before it existed.
//
// `bash` only. It is the one call that can legitimately run for minutes — #408 sized its bounds for
// a real build or test suite — and the one whose silence says nothing: a `subagent` streams its
// rounds into the same region (#342), `fetch_url`/`search` narrate what they are doing, and the file
// tools finish inside a second. A set rather than `name !== 'bash'` so widening the scope is a
// one-line change if a second tool ever earns it.
const TIMED_TOOLS = new Set(['bash']);
export const TIMER_AFTER_S = 5;

// ` · 12s`, or '' for a call that is not one of the above, has no duration yet, or is still under
// the threshold. The separator leads so the text reads as `${verb}…${timer}`.
export function toolTimer(name: string, ms: number | undefined): string {
  if (ms === undefined || ms < TIMER_AFTER_S * 1000 || !TIMED_TOOLS.has(name)) return '';
  return ` · ${formatDurationMs(ms)}`;
}

// `(+3 -1)`, `(new, +12)`, `(deleted, -40)`, `(binary)` — the stat tag after a file a bash command
// changed, in the scrollback and the saved transcript. Reads like the edit tool's `(+a -r)` so a
// shell edit and a tool edit scan the same, with the kind named only when the counts don't say it.
export function changeLabel(f: {
  kind: 'modified' | 'created' | 'deleted' | 'binary' | 'rewritten';
  added: number;
  removed: number;
}): string {
  switch (f.kind) {
    case 'binary':
      return '(binary)';
    case 'created':
      return `(new, +${f.added})`;
    case 'deleted':
      return `(deleted, -${f.removed})`;
    case 'rewritten':
      return `(rewritten, ${f.removed} → ${f.added} lines)`;
    default:
      return `(+${f.added} -${f.removed})`;
  }
}
