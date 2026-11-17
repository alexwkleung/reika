import { PENDING_ROW_DELAY_MS } from '../../ui/pendingrow.js';

// The TUI's rule (ui/pendingrow.ts, #951): a call that returns inside the delay paints no
// `↳ Running…` row, since a row replaced a moment later reads as a flicker.

export { PENDING_ROW_DELAY_MS };

// A call's `since` is on the server's clock, and so is each live event's `now` (#991). The tab
// reads the server's time as its own plus the offset it last measured, so a skewed clock or a tab
// that connects mid-call still times the call from when it started.
export function serverTime(localNow: number, clockOffset: number | null): number {
  return localNow + (clockOffset ?? 0);
}

// The call's streamed output waits with the row rather than forcing it up: a command that prints
// and returns inside the delay otherwise drew row, chip and output for a frame or two, then swapped
// them for its result.
export function pendingRowDue(since: number, serverNow: number): boolean {
  return serverNow - since >= PENDING_ROW_DELAY_MS;
}

export function pendingElapsedMs(since: number, serverNow: number): number {
  return Math.max(0, serverNow - since);
}
