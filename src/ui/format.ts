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

// `21 t/s`, `8.4 t/s`, `1.2k t/s` — the decode throughput of the last measurable round, as the
// status bar shows it (#204). One decimal below 10, where the difference between 3.1 and 3.4 is
// what the reader is looking at, and whole numbers above it, where it isn't; four digits and up are
// compacted like token counts. Empty when no round has been measurable yet.
export function formatTokensPerSecond(rate?: number): string {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return '';
  if (rate >= 1000) return `${kFormat(rate)} t/s`;
  return `${rate < 10 ? Number(rate.toFixed(1)) : Math.round(rate)} t/s`;
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

// Display name for a tool in the scrollback chip. Tool names are model-facing and picked for the
// model's benefit — `ask_user` names who is being asked, which a bare `ask` doesn't — but the chip
// is user-facing, where the one-word shape every other tool has reads better than a raw
// snake_case identifier. Only names needing an override are listed; everything else capitalizes.
// Both the rendered label and the hanging-wrap width math go through this, so they cannot drift.
const TOOL_LABELS: Record<string, string> = { ask_user: 'Ask', fetch_url: 'Fetch' };

export function toolLabel(name: string): string {
  const override = TOOL_LABELS[name];
  if (override) return override;
  return name.length > 0 ? name[0].toUpperCase() + name.slice(1) : name;
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
