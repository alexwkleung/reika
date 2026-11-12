import { useEffect, useState } from 'react';

// Held back so a call that returns inside it paints no row: one replaced two frames later is a flicker (#951).
export const PENDING_ROW_DELAY_MS = 150;

// Keyed on the call, not the tool name, so a same-name call batched with the last one's result starts its own delay.
export function usePendingRow(tool: string, call: number, force = false): string {
  const [dueFor, setDueFor] = useState(-1);
  useEffect(() => {
    if (!tool) return;
    const timer = setTimeout(() => setDueFor(call), PENDING_ROW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tool, call]);
  if (!tool) return '';
  return force || dueFor === call ? tool : '';
}
