import {
  contextFill,
  formatCache,
  formatContext,
  formatShrink,
  formatTokensPerSecond,
  kFormat,
} from '../../ui/format.js';
import type { WireState } from '../protocol.js';
import type { StreamStatus } from './eventstream.js';

// The quiet strip under the input box (direction B), built from the TUI status bar's helpers. The
// mode and model are the box's pills now, and whether a turn runs is the Stop button, so neither is
// repeated here; `turn N` was dropped with B. Each item is typed, so the strip can draw a meter.

export type StripItem =
  | { kind: 'tag'; text: string; tone: 'auto-approve' | 'bypass' }
  // `fill` is null with no window known: the count is shown with no bar to fill.
  | { kind: 'meter'; fill: number | null; text: string; title: string; warn: boolean }
  | { kind: 'stat'; text: string; title: string }
  | { kind: 'path'; text: string }
  | { kind: 'alert'; text: string };

// `/Users/a/very/long/path` → `/Users/a/…/path`: both ends say where you are.
export function shortenMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

export const CWD_MAX_CHARS = 40;

// The TUI's warning point on its gauge.
const CONTEXT_WARN_FILL = 0.8;

export function statusStrip(s: WireState, stream: StreamStatus | null): StripItem[] {
  const items: StripItem[] = [];
  // Where a tool can ask, as in the TUI: chat's tools never prompt, shell never runs the model.
  const gated = s.mode !== 'chat' && s.mode !== 'shell';
  if (gated && s.autoApprove === 'bypass') {
    items.push({ kind: 'tag', text: 'bypass approvals', tone: 'bypass' });
  } else if (gated && s.autoApprove === 'safe') {
    items.push({ kind: 'tag', text: 'auto approve', tone: 'auto-approve' });
  }
  if (gated && s.unattended && s.autoApprove !== 'bypass') {
    items.push({ kind: 'tag', text: 'unattended', tone: 'auto-approve' });
  }

  // The TUI measures against the usable ceiling, which needs the generation reserve; the wire
  // carries only the window, so the percent here is of the window.
  const contextTokens = s.lastUsage?.promptTokens ?? s.estimatedContext ?? 0;
  const window = s.contextWindow ?? undefined;
  if (window) {
    const fill = contextFill(contextTokens, window) ?? 0;
    items.push({
      kind: 'meter',
      fill: Math.min(1, fill),
      text: `${Math.round(fill * 100)}% of ${kFormat(window)}`,
      title: formatContext(contextTokens, window) || `ctx 0/${kFormat(window)}`,
      warn: fill >= CONTEXT_WARN_FILL,
    });
  } else if (contextTokens > 0) {
    const text = formatContext(contextTokens);
    items.push({
      kind: 'meter',
      fill: null,
      text,
      title: `${text} (no context window known)`,
      warn: false,
    });
  }

  const approx = s.usage.estimated ? '~' : '';
  if (s.usage.promptTokens > 0 || s.usage.completionTokens > 0) {
    items.push({
      kind: 'stat',
      text: `${approx}${kFormat(s.usage.promptTokens)} ↑ ${approx}${kFormat(s.usage.completionTokens)} ↓`,
      title: 'Tokens sent and received this session',
    });
  }
  const rate = formatTokensPerSecond(s.decodeRate ?? undefined);
  if (rate) items.push({ kind: 'stat', text: rate, title: 'Decode speed' });
  const cached = s.lastUsage?.cachedTokens;
  if (cached != null && contextTokens > 0) {
    items.push({
      kind: 'stat',
      text: `cache ${Math.round((cached / contextTokens) * 100)}%`,
      title: formatCache(cached, contextTokens),
    });
  }
  const shrink = formatShrink(s.shrink.sheds, s.shrink.folds);
  if (shrink)
    items.push({ kind: 'stat', text: shrink, title: 'Context shed and folded this session' });
  if (stream && stream !== 'open') items.push({ kind: 'alert', text: stream });
  if (s.cwd) items.push({ kind: 'path', text: s.cwd });
  return items;
}
