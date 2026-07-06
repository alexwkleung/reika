import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { renderInlineMarkdown } from './markdown.js';
import type { PlanStep } from '../agent/plantrack.js';

// Live checklist for a plan being implemented (#71). State comes from the loop's deterministic
// tracker (agent/plantrack.ts) via onPlanProgress — steps check off when the harness observes a
// successful edit/write to a file the step names, never from model claims. Lives in the dynamic
// region (below Scrollback), so it re-renders as steps flip; the durable per-step record is the
// system line the loop emits alongside.

// Height cap: the panel is chrome below Scrollback's live region, and the live frame must stay
// strictly under stdout.rows or Ink falls into its full-repaint path (flicker + scrollback loss).
// A long plan collapses its leading checked steps into one summary row, then truncates the tail.
const MAX_STEP_ROWS = 8;

type Layout = { collapsedDone: number; visible: PlanStep[]; hiddenTail: number };

function layout(steps: PlanStep[]): Layout {
  if (steps.length <= MAX_STEP_ROWS) return { collapsedDone: 0, visible: steps, hiddenTail: 0 };
  let collapsedDone = 0;
  while (collapsedDone < steps.length && steps[collapsedDone].done) collapsedDone++;
  const rest = steps.slice(collapsedDone);
  const room = MAX_STEP_ROWS - (collapsedDone > 0 ? 1 : 0);
  const visible = rest.length > room ? rest.slice(0, room - 1) : rest;
  return { collapsedDone, visible, hiddenTail: rest.length - visible.length };
}

// Exact rendered height in rows (marginTop + header + step/summary rows). App passes this to
// Scrollback's chromeRows so the live-region budget accounts for the panel.
export function planProgressRows(steps: PlanStep[]): number {
  const l = layout(steps);
  return 2 + (l.collapsedDone > 0 ? 1 : 0) + l.visible.length + (l.hiddenTail > 0 ? 1 : 0);
}

export function PlanProgress({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter(s => s.done).length;
  const waived = steps.filter(s => s.waived).length;
  const { collapsedDone, visible, hiddenTail } = layout(steps);
  const nextIdx = visible.findIndex(s => !s.done && !s.waived);
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header in the plan teal (same hue as the status bar's plan tag) so the panel reads as
          plan state at a glance — and so ▸ stays the panel's single accent/focus element. */}
      <Text color={theme.modePlan}>
        Plan {done}/{steps.length}
        {waived > 0 ? <Text color={theme.muted}> · {waived} waived</Text> : null}
      </Text>
      {collapsedDone > 0 ? (
        <Text color={theme.muted}>
          <Text color={theme.success}>{'✓ '}</Text>
          steps {steps[0].n}–{steps[collapsedDone - 1].n} done
        </Text>
      ) : null}
      {visible.map((s, i) => (
        // Single Text per row with the marker nested (never a row Box: see AGENTS.md Ink wrapping
        // pitfalls), truncated so a long step stays one line. Step text is rendered inline-only
        // (styled codespans, no raw backtick/bold syntax, no block reflow). Waived (~) = the
        // done-gate asked once and the model finished anyway — adjudicated, not observed done.
        <Text
          key={s.n}
          color={s.done || s.waived ? theme.muted : theme.secondary}
          wrap="truncate-end"
        >
          <Text
            color={
              s.done
                ? theme.success
                : s.waived
                  ? theme.warning
                  : i === nextIdx
                    ? theme.accent
                    : theme.muted
            }
          >
            {s.done ? '✓ ' : s.waived ? '~ ' : i === nextIdx ? '▸ ' : '· '}
          </Text>
          {s.n}. {renderInlineMarkdown(s.text)}
        </Text>
      ))}
      {hiddenTail > 0 ? <Text color={theme.muted}>… {hiddenTail} more</Text> : null}
    </Box>
  );
}
