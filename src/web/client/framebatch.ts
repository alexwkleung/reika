// Live text arrives many times a second; the page draws at most once per animation frame. The
// scheduler is handed in so a test drives frames by hand.

export type FrameScheduler = (callback: () => void) => void;

export function frameBatched(notify: () => void, schedule: FrameScheduler): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      notify();
    });
  };
}

// A hidden tab gets no animation frames, so a frame alone would leave it showing a dialog another
// tab already answered. The timer draws it instead, throttled by the browser; whichever fires first
// runs the callback, once.
export const HIDDEN_TAB_DRAW_MS = 250;

export function frameOrTimer(
  requestFrame: (callback: () => void) => unknown,
  setTimer: (callback: () => void, ms: number) => unknown,
): FrameScheduler {
  return callback => {
    let ran = false;
    const run = () => {
      if (ran) return;
      ran = true;
      callback();
    };
    requestFrame(run);
    setTimer(run, HIDDEN_TAB_DRAW_MS);
  };
}
