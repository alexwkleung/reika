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
