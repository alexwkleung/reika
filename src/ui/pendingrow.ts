import { useEffect, useState } from 'react';

// When the in-flight call's row is worth painting (#951).
//
// The row itself is #509's: the live `↳ Running…` in the slot the result will commit into, so a
// silent call doesn't leave the committed call row above it looking like the app stopped. What it
// is for is a call that *stalls* — and a call that does not stall has no reassurance to give, yet
// painted the row anyway, for the two or three frames between the announce and the result. A row
// that appears and is replaced that fast is a flicker, not information: at ~30fps a `read`, a
// `write`, an `edit` or a fast `grep` is on screen for one or two flushes and then a different row
// is in its place.
//
// So the row is held back until the call has outlived this delay. Everything from a `read` to a
// `grep` to a `write` finishes inside it and paints nothing; a `bash`, a `fetch`, a web search, an
// MCP call or a subagent — the calls whose silence is what the row is for — put it up as before,
// and their frames are identical to today's, just starting a moment later.
//
// A delay rather than a minimum time on screen: the row stands in the result's slot, so holding it
// after the result lands would mean hiding the result for that long.
//
// 150ms: past the point a wait is noticeable at all, and several frames of Ink's ~30fps, so a call
// that does paint the row is one the user has already been waiting on.
export const PENDING_ROW_DELAY_MS = 150;

// Which call the due flag belongs to, not just that one is due: two calls can land in a single
// React commit (a result and the next announcement batched together, or a mocked loop firing them
// back to back), and the second has to start its own delay rather than inherit the first's.
type Due = { tool: string; due: boolean };

const NONE: Due = { tool: '', due: false };

// The row to draw: `tool` once that same call has been pending past the delay, '' before then and
// for a snapshot that belongs to a call already replaced.
export function pendingRowTool(due: Due, tool: string): string {
  return due.due && due.tool === tool ? tool : '';
}

// The live row's gate, for App's `pendingTool`. Measured from the render the announce commits in
// rather than from the loop's own start stamp: that stamp is what the elapsed chip ages off, and it
// is read at render, so it has no edge to hang a timer on.
//
// `force` outranks the delay for a call whose approval the user has just answered (#897): that
// frame is the one that collapses the dialog into the row and the block it cleared, so it has to
// carry the row whether or not the call has outlived the delay. In a session it is moot — the
// dialog is up for far longer than the delay — but the answer frame must not depend on that race.
export function usePendingRow(tool: string, force = false): string {
  const [due, setDue] = useState<Due>(NONE);
  useEffect(() => {
    // An ended call leaves nothing due, so the next one starts over — even when it is the same
    // tool as the call before it.
    if (!tool) return setDue(d => (d === NONE ? d : NONE));
    const timer = setTimeout(() => setDue({ tool, due: true }), PENDING_ROW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tool]);
  return tool !== '' && force ? tool : pendingRowTool(due, tool);
}
