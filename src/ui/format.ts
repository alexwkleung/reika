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

// Fraction of the context window currently used, or null when either operand is unknown.
export function contextFill(contextTokens?: number | null, contextWindow?: number): number | null {
  if (!contextTokens || !contextWindow) return null;
  return contextTokens / contextWindow;
}

// Display name for a tool in the scrollback chip. Tool names are model-facing and picked for the
// model's benefit — `ask_user` names who is being asked, which a bare `ask` doesn't — but the chip
// is user-facing, where the one-word shape every other tool has reads better than a raw
// snake_case identifier. Only names needing an override are listed; everything else capitalizes.
// Both the rendered label and the hanging-wrap width math go through this, so they cannot drift.
const TOOL_LABELS: Record<string, string> = { ask_user: 'Ask' };

export function toolLabel(name: string): string {
  const override = TOOL_LABELS[name];
  if (override) return override;
  return name.length > 0 ? name[0].toUpperCase() + name.slice(1) : name;
}
