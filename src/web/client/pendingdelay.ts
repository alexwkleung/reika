import { PENDING_ROW_DELAY_MS } from '../../ui/pendingrow.js';

// The TUI's rule (ui/pendingrow.ts, #951): a call that returns inside the delay paints no
// `↳ Running…` row, since a row replaced a moment later reads as a flicker.

export { PENDING_ROW_DELAY_MS };

// When this tab first saw each call, keyed by its number. Not the server's `pending.since`: that
// is another machine's clock (or this one's, through a different process), and a skew or a tab
// that connects mid-call would make the delay and the elapsed chip lie.
export type CallSightings = { call: number; seenAt: number } | null;

export function sightCall(prev: CallSightings, call: number, now: number): CallSightings {
  return prev && prev.call === call ? prev : { call, seenAt: now };
}

// `force`: streamed output for the call is already on screen, which outranks the delay (as in the
// TUI), or the row would appear above output that drew first.
export function pendingRowDue(
  sighting: CallSightings,
  call: number,
  now: number,
  force = false,
): boolean {
  if (!sighting || sighting.call !== call) return force;
  return force || now - sighting.seenAt >= PENDING_ROW_DELAY_MS;
}

export function pendingElapsedMs(sighting: CallSightings, call: number, now: number): number {
  return sighting && sighting.call === call ? Math.max(0, now - sighting.seenAt) : 0;
}
