import { Fragment } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { Usage } from '../types.js';
import { theme } from './theme.js';
import { contextFill, formatElapsed, formatShrink, kFormat } from './format.js';
import { useContentWidth } from './layout.js';

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
  const width = useContentWidth();
  const busy = elapsed !== null;
  const timer = busy ? ` · ${formatElapsed(elapsed)}` : '';
  const keys = busy ? 'ctrl-c to abort' : 'ctrl-c to exit';
  const tokens =
    usage.promptTokens > 0 || usage.completionTokens > 0
      ? `${kFormat(usage.promptTokens)}↑ ${kFormat(usage.completionTokens)}↓`
      : '';

  // Current context size and how full the window is. The fill % drives the color so a
  // long run that's approaching the limit is visible at a glance.
  const fill = contextFill(contextTokens, contextUsable ?? contextWindow);
  const ctx = formatContext(contextTokens, contextWindow, contextUsable);
  const ctxColor = fill != null && fill >= 0.8 ? theme.warning : theme.muted;
  // Share of the prompt the provider served from cache last call. Absent when the
  // provider doesn't report it.
  const cache = formatCache(cachedTokens, contextTokens);
  const shrink = formatShrink(sheds ?? 0, folds ?? 0);
  // Which PR the checked-out branch is attached to, when one exists.
  const prBadge = formatPr(pr);

  // The line as a list of chips, each an unbreakable run of colored segments; the separator goes
  // in between at layout time.
  const chips: Chip[] = [];
  if (modeTag) {
    chips.push([
      { text: modeTag, color: modeColor(modeTag) },
      { text: ' (shift+tab to cycle)', color: theme.muted },
    ]);
  }
  // The approval chip only means something where a tool can ask: chat mode's tools (fetch,
  // search) never request approval and shell mode never runs the model, so in both the chip
  // would promise a gate that nothing goes through (#373).
  if (autoApprove && modeTag !== 'chat' && modeTag !== 'shell') {
    chips.push([
      {
        text: autoApprove === 'bypass' ? 'bypass approvals' : 'auto approve',
        color: autoApprove === 'bypass' ? theme.error : theme.autoApprove,
      },
    ]);
  }
  chips.push(muted(model), muted(`turn ${turns}`), muted(`${status}${timer}`));
  if (tokens) chips.push(muted(tokens));
  if (ctx) chips.push([{ text: ctx, color: ctxColor }]);
  if (shrink) chips.push(muted(shrink));
  if (cache) chips.push(muted(cache));
  if (prBadge) chips.push([{ text: prBadge, color: theme.secondary }]);
  chips.push(
    exitArmed
      ? [{ text: 'press ctrl-c again to exit', color: theme.tool }]
      : [{ text: keys, color: theme.muted }],
  );

  // One <Text> per packed line, chips as nested runs rather than siblings: a row Box of sibling
  // <Text>s hands each its own column when the row overflows, and every chip wraps in place into
  // a stack of two-to-four-character shards (#295). Packing here is what decides where the line
  // breaks; Ink's own wrap only ever sees a line that already fits, except for a single chip
  // wider than the terminal, which it hard-wraps as a last resort.
  return (
    <Box flexDirection="column">
      {packChips(chips, width).map((line, i) => (
        <Text key={i}>
          {line.map((chip, j) => (
            <Fragment key={j}>
              {j > 0 ? <Text color={theme.muted}>{SEP}</Text> : null}
              {chip.map((seg, k) => (
                <Text key={k} color={seg.color}>
                  {seg.text}
                </Text>
              ))}
            </Fragment>
          ))}
        </Text>
      ))}
    </Box>
  );
}

type Segment = { text: string; color: string };
// A chip is the unit the status wraps at — never split across lines.
export type Chip = Segment[];

const SEP = ' · ';

function muted(text: string): Chip {
  return [{ text, color: theme.muted }];
}

function chipWidth(chip: Chip): number {
  return chip.reduce((n, seg) => n + stringWidth(seg.text), 0);
}

// Greedy first-fit: chips go on the current line while they fit (separator included), and the
// first one that doesn't starts the next. Chips never split, and the separator never leads or
// trails a line — a continuation row starts on its chip, like a wrapped list. A chip wider than
// the whole width still gets a line of its own; the overflow is Ink's to wrap.
export function packChips(chips: Chip[], width: number): Chip[][] {
  const lines: Chip[][] = [];
  let line: Chip[] = [];
  let used = 0;
  for (const chip of chips) {
    const w = chipWidth(chip);
    const need = line.length === 0 ? w : used + SEP.length + w;
    if (line.length > 0 && need > width) {
      lines.push(line);
      line = [chip];
      used = w;
    } else {
      line.push(chip);
      used = need;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

// Soft pastel per mode tag; falls back to muted for anything unexpected.
function modeColor(mode: string): string {
  switch (mode) {
    case 'plan':
      return theme.modePlan;
    case 'vibe':
      return theme.modeVibe;
    case 'minimal':
      return theme.modeMinimal;
    case 'chat':
      return theme.modeChat;
    case 'shell':
      return theme.modeShell;
    default:
      return theme.modeAgent;
  }
}

// `ctx 16k/24k (100% of 16k)` when the window and its usable ceiling are known — the ratio is
// the raw window (what REIKA_CONTEXT_WINDOW was set to, worth a sanity check at a glance) and the
// percent is of the usable ceiling, which is the number that says how close the next shed is.
// `ctx 45k/128k (35%)` when only the window is known, `ctx 45k` when only the size is, empty
// string when there's nothing to show yet.
export function formatContext(
  contextTokens?: number | null,
  contextWindow?: number,
  contextUsable?: number,
): string {
  if (contextTokens == null || contextTokens <= 0) return '';
  if (!contextWindow) return `ctx ${kFormat(contextTokens)}`;
  const size = `${kFormat(contextTokens)}/${kFormat(contextWindow)}`;
  const fill = contextFill(contextTokens, contextUsable ?? contextWindow);
  const pct = Math.round(fill! * 100);
  return contextUsable
    ? `ctx ${size} (${pct}% of ${kFormat(contextUsable)})`
    : `ctx ${size} (${pct}%)`;
}

// `89% cached (40k)` — the share of the last prompt the provider served from cache, and how
// many tokens that was (#360). Empty when unavailable. A cold call is `0% cached` with no count:
// `(0)` would only repeat the percent. The count stays when it's nonzero but rounds to 0% —
// `0% cached (200)` is the one place it says something the percent can't.
export function formatCache(cachedTokens?: number, contextTokens?: number | null): string {
  if (cachedTokens == null || !contextTokens) return '';
  const pct = Math.round((cachedTokens / contextTokens) * 100);
  return cachedTokens > 0 ? `${pct}% cached (${kFormat(cachedTokens)})` : `${pct}% cached`;
}

// `PR: #12` when the branch has an open PR, empty when it doesn't (or we couldn't tell).
export function formatPr(pr?: number | null): string {
  return pr == null || pr <= 0 ? '' : `PR: #${pr}`;
}
