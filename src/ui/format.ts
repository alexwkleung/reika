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
