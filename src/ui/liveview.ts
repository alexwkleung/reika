import { useCallback, useEffect, useRef, useState } from 'react';
import type { Controller, LiveTurn } from '../controller.js';
import type { LiveUsage } from '../agent/liveusage.js';
import type { Usage } from '../types.js';
import { prefillLabel } from './format.js';

// The TUI's view of the controller's live turn (#584): the state and its clearing rules are the
// controller's; what is left here is display timing.

// Streamed text repaints at most this often.
export const STREAM_FLUSH_MS = 50;

// How long the "Typechecking" indicator lingers after a check settles, so a sub-second warm check
// still reads. Long enough to perceive, short enough not to imply the check is still running.
export const TYPECHECK_LINGER_MS = 650;

// The estimate rides beside the view rather than in it: it moves on the clock tick, not per report.
export type LiveView = Omit<LiveTurn, 'usage'>;

// The estimate for the request in flight (#925), with the session total it was taken against: it
// is drawn only beside that total, since the real count reaches App through the snapshot.
export type ShownUsage = { usage: LiveUsage; base: Usage } | null;

export type LiveViewHandle = {
  view: LiveView;
  usage: ShownUsage;
  // Takes the latest estimate; App's one-second tick calls it.
  tick(): void;
  // When streamed output last arrived, for the dialog hold's ease.
  lastOutputAtRef: { readonly current: number };
};

// Text a `live` change carries is shown at once only when it does not continue what is shown: a
// clear or a reset. A continuation waits for the flush.
export function textToShow(shown: string, next: string): string {
  return next.startsWith(shown) ? shown : next;
}

// Same rule for the tool block, plus a block under another name, which replaces the old one now.
// A first block over nothing shown waits for the flush like any other output.
export function toolToShow(shown: LiveTurn['tool'], next: LiveTurn['tool']): LiveTurn['tool'] {
  if (next === null) return null;
  if (shown === null) return null;
  if (shown.name !== next.name) return next;
  return next.output.startsWith(shown.output) ? shown : next;
}

// A tool block the controller started since it was last seen: output, though no delta says so.
export function startsToolBlock(seen: LiveTurn['tool'], next: LiveTurn['tool']): boolean {
  return next !== null && (seen === null || seen.name !== next.name);
}

// The view a `live` change publishes: every non-text field from the controller, the text by the
// rules above. `typechecking` is the lingered value, which the caller owns.
export function viewForLiveChange(
  shown: LiveView,
  next: LiveTurn,
  running: LiveTurn['pending'],
  typechecking: boolean,
): LiveView {
  const { usage: _estimate, ...rest } = next;
  return {
    ...rest,
    pending: running,
    typechecking,
    content: textToShow(shown.content, next.content),
    reasoning: textToShow(shown.reasoning, next.reasoning),
    tool: toolToShow(shown.tool, next.tool),
  };
}

// The view a flush publishes: the controller's text as it stands.
export function viewForFlush(shown: LiveView, next: LiveTurn): LiveView {
  return { ...shown, content: next.content, reasoning: next.reasoning, tool: next.tool };
}

export function sameView(a: LiveView, b: LiveView): boolean {
  const keys = Object.keys(a) as (keyof LiveView)[];
  return keys.every(k => a[k] === b[k]);
}

// A round's first estimate is shown at once, so ↑ moves as the request goes out; later ones wait for
// the tick. A clear waits too: the real count or the next tick drops it.
export function showsEstimateAtOnce(
  reported: LiveUsage | null,
  next: LiveUsage | null,
): next is LiveUsage {
  return next !== null && reported === null;
}

// The controller resets the phase to null at a turn's end and sets it at the next start, in the same
// change that clears the stream, so these edges land where the turn hooks used to.
export function crossesTurnEdge(seen: LiveTurn['phase'], next: LiveTurn['phase']): boolean {
  return (seen === null) !== (next === null);
}

function initialView(controller: Controller): LiveView {
  const { usage: _estimate, ...rest } = controller.live;
  return { ...rest, pending: controller.runningCall };
}

export function useLiveView(controller: Controller): LiveViewHandle {
  const [view, setView] = useState<LiveView>(() => initialView(controller));
  const [usage, setUsage] = useState<ShownUsage>(null);
  const shownRef = useRef(view);
  const lastOutputAtRef = useRef(0);
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const typecheckShownRef = useRef(view.typechecking);
  const seenRef = useRef<LiveTurn>(controller.live);

  useEffect(() => {
    const publish = (next: LiveView): void => {
      if (sameView(shownRef.current, next)) return;
      shownRef.current = next;
      setView(next);
    };
    const cancelHide = (): boolean => {
      if (hideTimerRef.current === null) return false;
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
      return true;
    };
    const scheduleFlush = (): void => {
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        publish(viewForFlush(shownRef.current, controller.live));
      }, STREAM_FLUSH_MS);
    };
    // A check that starts shows at once; one that settles lingers, so a fast check still reads. A
    // new check cancels a pending hide, so back-to-back checks read as continuous.
    const followTypecheck = (was: boolean, now: boolean): void => {
      if (now === was) return;
      cancelHide();
      if (now) {
        typecheckShownRef.current = true;
        return;
      }
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        typecheckShownRef.current = false;
        publish({ ...shownRef.current, typechecking: false });
      }, TYPECHECK_LINGER_MS);
    };
    const unsubscribeLive = controller.subscribeLive(change => {
      const seen = seenRef.current;
      const next = controller.live;
      seenRef.current = next;
      if (change.type === 'delta') {
        lastOutputAtRef.current = Date.now();
        scheduleFlush();
        return;
      }
      if (startsToolBlock(seen.tool, next.tool)) {
        lastOutputAtRef.current = Date.now();
        scheduleFlush();
      }
      if (crossesTurnEdge(seen.phase, next.phase)) {
        // Un-lingered, and the estimate goes too: a request that threw never reported its count.
        cancelHide();
        typecheckShownRef.current = false;
        setUsage(null);
        if (next.phase === null && flushTimerRef.current !== null) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
      } else {
        followTypecheck(seen.typechecking, next.typechecking);
      }
      // The linger keeps a finished check on screen; a prefill worth naming is the newer fact, and
      // holding it back made its label land late (#914). A check still running keeps its label.
      const progressed = next.promptProgress !== seen.promptProgress;
      if (progressed && prefillLabel(next.promptProgress ?? undefined) && cancelHide()) {
        typecheckShownRef.current = false;
      }
      if (showsEstimateAtOnce(seen.usage, next.usage)) {
        setUsage({ usage: next.usage, base: controller.getSnapshot().usage });
      }
      publish(
        viewForLiveChange(
          shownRef.current,
          next,
          controller.runningCall,
          typecheckShownRef.current,
        ),
      );
    });
    return () => {
      unsubscribeLive();
      cancelHide();
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    };
  }, [controller]);

  const tick = useCallback(() => {
    const estimate = controller.live.usage;
    setUsage(estimate ? { usage: estimate, base: controller.getSnapshot().usage } : null);
  }, [controller]);

  return { view, usage, tick, lastOutputAtRef };
}
