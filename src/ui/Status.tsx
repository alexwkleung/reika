import { Box, Text } from 'ink';
import type { Usage } from '../types.js';
import { theme } from './theme.js';
import { contextFill, formatElapsed, formatShrink, kFormat } from './format.js';

export function Status({
  model,
  turns,
  status,
  elapsed,
  usage,
  contextTokens,
  contextWindow,
  contextUsable,
  sheds,
  folds,
  cachedTokens,
  pr,
  autoApprove,
  modeTag,
  exitArmed,
}: {
  model: string;
  turns: number;
  status: string;
  elapsed: number | null;
  usage: Usage;
  contextTokens?: number | null;
  contextWindow?: number;
  // The shed ceiling (compactThreshold) when the window is known — what the fill % is measured
  // against, so 100% means "the next request sheds", not "the window is physically full".
  contextUsable?: number;
  // Session-cumulative shrink events: batch-age sheds and compaction folds. Ambient chips — the
  // gauge sawtooth already shows the events, the counts say how many teeth.
  sheds?: number;
  folds?: number;
  cachedTokens?: number;
  pr?: number | null;
  autoApprove?: 'safe' | 'bypass';
  modeTag?: string;
  exitArmed?: boolean;
}) {
  const busy = elapsed !== null;
  const timer = busy ? ` · ${formatElapsed(elapsed)}` : '';
  const keys = busy ? 'ctrl-c to abort' : 'ctrl-c to exit';
  const tokens =
    usage.promptTokens > 0 || usage.completionTokens > 0
      ? ` · ${kFormat(usage.promptTokens)}↑ ${kFormat(usage.completionTokens)}↓`
      : '';

  // Current context size and how full the window is. The fill % drives the color so a
  // long run that's approaching the limit is visible at a glance.
  const fill = contextFill(contextTokens, contextUsable ?? contextWindow);
  const ctx = formatContext(contextTokens, contextWindow, contextUsable);
  const ctxColor = fill != null && fill >= 0.8 ? theme.warning : theme.muted;
  // Share of the prompt the provider served from cache last call. Absent when the
  // provider doesn't report it.
  const cache = formatCache(cachedTokens, contextTokens);
  const shrinkText = formatShrink(sheds ?? 0, folds ?? 0);
  const shrink = shrinkText ? ` · ${shrinkText}` : '';
  // Which PR the checked-out branch is attached to, when one exists.
  const prBadge = formatPr(pr);

  return (
    <Box>
      {modeTag ? (
        <>
          <Text color={modeColor(modeTag)}>{modeTag}</Text>
          <Text color={theme.muted}>{' (shift+tab to cycle) · '}</Text>
        </>
      ) : null}
      {autoApprove ? (
        <>
          <Text color={autoApprove === 'bypass' ? theme.error : theme.warning}>
            {autoApprove === 'bypass' ? 'bypass approvals' : 'auto approve'}
          </Text>
          <Text color={theme.muted}>{' · '}</Text>
        </>
      ) : null}
      <Text color={theme.muted}>{`${model} · turn ${turns} · ${status}${timer}${tokens}`}</Text>
      {ctx ? <Text color={ctxColor}>{ctx}</Text> : null}
      {shrink ? <Text color={theme.muted}>{shrink}</Text> : null}
      {cache ? <Text color={theme.muted}>{cache}</Text> : null}
      {prBadge ? <Text color={theme.secondary}>{prBadge}</Text> : null}
      <Text color={theme.muted}>{' · '}</Text>
      {exitArmed ? (
        <Text color={theme.tool}>press ctrl-c again to exit</Text>
      ) : (
        <Text color={theme.muted}>{keys}</Text>
      )}
    </Box>
  );
}

// Soft pastel per mode tag; falls back to muted for anything unexpected.
function modeColor(mode: string): string {
  switch (mode) {
    case 'plan':
      return theme.modePlan;
    case 'vibe':
      return theme.modeVibe;
    case 'chat':
      return theme.modeChat;
    case 'shell':
      return theme.modeShell;
    default:
      return theme.modeAgent;
  }
}

// ` · ctx 16k/24k (100% of 16k)` when the window and its usable ceiling are known — the ratio is
// the raw window (what REIKA_CONTEXT_WINDOW was set to, worth a sanity check at a glance) and the
// percent is of the usable ceiling, which is the number that says how close the next shed is.
// ` · ctx 45k/128k (35%)` when only the window is known, ` · ctx 45k` when only the size is, empty
// string when there's nothing to show yet.
export function formatContext(
  contextTokens?: number | null,
  contextWindow?: number,
  contextUsable?: number,
): string {
  if (contextTokens == null || contextTokens <= 0) return '';
  if (!contextWindow) return ` · ctx ${kFormat(contextTokens)}`;
  const size = `${kFormat(contextTokens)}/${kFormat(contextWindow)}`;
  const fill = contextFill(contextTokens, contextUsable ?? contextWindow);
  const pct = Math.round(fill! * 100);
  return contextUsable
    ? ` · ctx ${size} (${pct}% of ${kFormat(contextUsable)})`
    : ` · ctx ${size} (${pct}%)`;
}

// ` · cache 89%` (cached share of the last prompt), empty when unavailable.
export function formatCache(cachedTokens?: number, contextTokens?: number | null): string {
  if (cachedTokens == null || !contextTokens) return '';
  return ` · cache ${Math.round((cachedTokens / contextTokens) * 100)}%`;
}

// ` · PR: #12` when the branch has an open PR, empty when it doesn't (or we couldn't tell).
export function formatPr(pr?: number | null): string {
  return pr == null || pr <= 0 ? '' : ` · PR: #${pr}`;
}
