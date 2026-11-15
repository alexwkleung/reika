// Whether the view follows new rows: it does while the reader is at the bottom, and a scroll away
// from it stops that until they come back (or press "Jump to latest").

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

// Slack for sub-pixel scroll positions and a row landing mid-scroll.
export const BOTTOM_SLACK_PX = 48;

export function isAtBottom(m: ScrollMetrics, slack = BOTTOM_SLACK_PX): boolean {
  return m.scrollHeight - (m.scrollTop + m.clientHeight) <= slack;
}

export type FollowEvent =
  | { type: 'user-scroll'; metrics: ScrollMetrics }
  | { type: 'content-grew' }
  | { type: 'jump' };

// `content-grew` never changes the answer: a reader who scrolled up stays where they are however
// much arrives, and one following stays following even though the new row put them off the bottom.
export function nextFollow(following: boolean, event: FollowEvent): boolean {
  switch (event.type) {
    case 'user-scroll':
      return isAtBottom(event.metrics);
    case 'content-grew':
      return following;
    case 'jump':
      return true;
  }
}
