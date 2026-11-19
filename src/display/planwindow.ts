// Which plan steps the live checklist shows. The TUI's panel is chrome in a frame that must stay
// under the terminal's height, so a long plan folds its leading checked steps into one summary row
// and truncates the tail. Ink-free so the browser client (src/web/client/LiveTurn.tsx) folds the
// same way.

export const MAX_STEP_ROWS = 8;

export type PlanWindow<S> = { collapsedDone: number; visible: S[]; hiddenTail: number };

export function planWindow<S extends { done: boolean }>(steps: S[]): PlanWindow<S> {
  if (steps.length <= MAX_STEP_ROWS) return { collapsedDone: 0, visible: steps, hiddenTail: 0 };
  let collapsedDone = 0;
  while (collapsedDone < steps.length && steps[collapsedDone]!.done) collapsedDone++;
  const rest = steps.slice(collapsedDone);
  const room = MAX_STEP_ROWS - (collapsedDone > 0 ? 1 : 0);
  const visible = rest.length > room ? rest.slice(0, room - 1) : rest;
  return { collapsedDone, visible, hiddenTail: rest.length - visible.length };
}
