// Whether the view follows new rows: it does while the reader is at the bottom, and a scroll away
// from it stops that until they come back (or press "Jump to latest").

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

// Slack for sub-pixel scroll positions and a row landing mid-scroll.
export const BOTTOM_SLACK_PX = 48;

export function isAtBottom(m: ScrollMetrics, slack = BOTTOM_SLACK_PX): boolean {
  return m.scrollHeight - (m.scrollTop + m.clientHeight) <= slack;
}

export type FollowEvent =
  | { type: 'user-scroll'; metrics: ScrollMetrics; previousTop?: number }
  | { type: 'scroll-up-intent' }
  | { type: 'content-grew' }
  | { type: 'jump' };

// `content-grew` never changes the answer: a reader who scrolled up stays where they are however
// much arrives, and one following stays following even though the new row put them off the bottom.
// Any move up lets go at once, slack or not: inside the slack, the next streamed row scrolled the
// reader back down, so a slow scroll up while Thinking grew jittered in place. A move up that ends
// on the bottom is the content shrinking under the view (a block collapsing), not the reader. Once
// let go, only a move down into the slack (or the bottom itself) takes it back: being inside the
// slack alone re-caught a reader whose small scroll up had just let go.
export function nextFollow(following: boolean, event: FollowEvent): boolean {
  switch (event.type) {
    case 'user-scroll': {
      const m = event.metrics;
      const previous = event.previousTop;
      if (previous === undefined) return isAtBottom(m);
      if (m.scrollTop < previous - 0.5) return isAtBottom(m, 1);
      if (following) return true;
      return isAtBottom(m, 1) || (m.scrollTop > previous + 0.5 && isAtBottom(m));
    }
    case 'scroll-up-intent':
      return false;
    case 'content-grew':
      return following;
    case 'jump':
      return true;
  }
}
