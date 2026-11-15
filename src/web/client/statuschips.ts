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

// The status line's chips, in the TUI status bar's order (ui/Status.tsx statusChips), built from
// the same helpers. `tone` names a CSS class; the TUI's keybinding hints have no place here.

export type StatusChip = { text: string; tone: string };

// `/Users/a/very/long/path` → `/Users/a/…/path`: both ends say where you are.
export function shortenMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

export const CWD_MAX_CHARS = 40;

export function statusLineChips(
  s: WireState,
  turns: number,
  stream: StreamStatus | null,
): StatusChip[] {
  const chips: StatusChip[] = [{ text: s.mode, tone: `mode-${s.mode}` }];
  // Where a tool can ask, as in the TUI: chat's tools never prompt, shell never runs the model.
  const gated = s.mode !== 'chat' && s.mode !== 'shell';
  if (gated && s.autoApprove !== 'off') {
    chips.push(
      s.autoApprove === 'bypass'
        ? { text: 'bypass approvals', tone: 'bypass' }
        : { text: 'auto approve', tone: 'auto-approve' },
    );
  }
  if (gated && s.unattended && s.autoApprove !== 'bypass') {
    chips.push({ text: 'unattended', tone: 'auto-approve' });
  }
  if (s.model) chips.push({ text: s.model, tone: 'muted' });
  chips.push({ text: `turn ${turns}`, tone: 'muted' });
  chips.push({ text: s.status, tone: 'muted' });
  const approx = s.usage.estimated ? '~' : '';
  if (s.usage.promptTokens > 0 || s.usage.completionTokens > 0) {
    chips.push({
      text: `${approx}${kFormat(s.usage.promptTokens)}↑ ${approx}${kFormat(s.usage.completionTokens)}↓`,
      tone: 'muted',
    });
  }
  const rate = formatTokensPerSecond(s.decodeRate ?? undefined);
  if (rate) chips.push({ text: rate, tone: 'muted' });
  // The TUI measures against the usable ceiling, which needs the generation reserve; the wire
  // carries only the window, so the percent here is of the window.
  const contextTokens = s.lastUsage?.promptTokens ?? s.estimatedContext;
  const window = s.contextWindow ?? undefined;
  const ctx = formatContext(contextTokens, window);
  if (ctx) {
    const fill = contextFill(contextTokens, window);
    chips.push({ text: ctx, tone: fill != null && fill >= 0.8 ? 'warning' : 'muted' });
  }
  const shrink = formatShrink(s.shrink.sheds, s.shrink.folds);
  if (shrink) chips.push({ text: shrink, tone: 'muted' });
  const cache = formatCache(s.lastUsage?.cachedTokens, contextTokens);
  if (cache) chips.push({ text: cache, tone: 'muted' });
  if (s.cwd) chips.push({ text: shortenMiddle(s.cwd, CWD_MAX_CHARS), tone: 'muted' });
  if (stream && stream !== 'open') chips.push({ text: stream, tone: 'warning' });
  return chips;
}
