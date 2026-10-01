import { Fragment } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { supportsHyperlink } from 'supports-hyperlinks';
import type { Usage } from '../types.js';
import type { PrRef } from './pr.js';
import { theme } from './theme.js';
import {
  contextFill,
  formatElapsed,
  formatShrink,
  formatTokensPerSecond,
  kFormat,
} from './format.js';
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
  decodeRate,
  pr,
  autoApprove,
  unattended,
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
  // Decode throughput of the last measurable round (#204), from agent/decoderate.ts — the engine's
  // own number where the engine reports one (#536, llama.cpp), our derivation otherwise. Absent
  // until a round generated enough tokens to measure one, and whenever the provider reported no
  // usage and no stats.
  decodeRate?: number;
  // Which PR the checked-out branch is attached to (ui/pr.ts), with its web URL when `gh`
  // reported one. Null until resolved, and whenever there is no open PR to show.
  pr?: PrRef | null;
  autoApprove?: 'safe' | 'bypass';
  // REIKA_UNATTENDED (#526). A standing chip because the mode silently declines: left on by
  // accident during the day, it refuses a command the user would have approved.
  unattended?: boolean;
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
  // How fast the last measurable round decoded (#204). No color of its own: it is a fact about the
  // engine, not a warning about anything the user should act on.
  const rate = formatTokensPerSecond(decodeRate);
  const shrink = formatShrink(sheds ?? 0, folds ?? 0);
  // Which PR the checked-out branch is attached to, when one exists — the number links out.
  const prChipSegments = prChip(pr);

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
  // Not under bypass: nothing prompts there, so there is nothing for unattended to decline.
  if (unattended && autoApprove !== 'bypass' && modeTag !== 'chat' && modeTag !== 'shell') {
    chips.push([{ text: 'unattended', color: theme.autoApprove }]);
  }
  chips.push(muted(model), muted(`turn ${turns}`), muted(`${status}${timer}`));
  if (tokens) chips.push(muted(tokens));
  if (rate) chips.push(muted(rate));
  if (ctx) chips.push([{ text: ctx, color: ctxColor }]);
  if (shrink) chips.push(muted(shrink));
  if (cache) chips.push(muted(cache));
  if (prChipSegments) chips.push(prChipSegments);
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
                <Text key={k} color={seg.color} underline={seg.underline}>
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

// `underline` is the one attribute a segment carries beyond its hue — the link underline, which
// promises a click and so is set only where the terminal can deliver one (see prChip).
type Segment = { text: string; color: string; underline?: boolean };
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
    case 'grind':
      return theme.modeGrind;
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

// `PR #12` when the branch has an open PR, empty when it doesn't (or we couldn't tell). The
// number is the click target, the `PR` label is not, so the chip comes in two segments — and the
// separating space rides on the *label*, not the number: a segment's underline runs the whole
// width of the segment it is on, so a leading space inside the number would draw a column of
// underline before the `#` and open a clickable gap ahead of it.
//
// `links` is the OSC 8 gate, injected so the plain-text branch is testable where stdout is a pipe
// (the same function-form check markdown.ts's renderLink makes, and for the same reason: it re-reads
// the environment, so FORCE_HYPERLINK reaches it). Where the terminal takes hyperlinks the number
// is an underlined `theme.link` run that opens the PR; where it doesn't, or where `gh` never gave
// us a URL, the plain number keeps a link hue and no underline — the underline is the one cue that
// says "this clicks", and it stays off exactly when there is nothing to click.
export function prChip(
  pr?: PrRef | null,
  links: boolean = supportsHyperlink(process.stdout),
): Chip | null {
  const number = pr?.number;
  if (number == null || number <= 0) return null;
  const label: Segment = { text: 'PR ', color: theme.secondary };
  const shown = `#${number}`;
  const url = pr?.url;
  if (url && links) {
    return [
      label,
      { text: `\x1b]8;;${url}\x07${shown}\x1b]8;;\x07`, color: theme.link, underline: true },
    ];
  }
  return [label, { text: shown, color: url ? theme.link : theme.secondary }];
}
