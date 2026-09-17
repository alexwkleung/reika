import type { ApprovalRequest, AutoApproveMode } from './types.js';

// Whether an approval request runs without asking. The one rule both front-ends share (#52):
// `safe` approves anything the danger scan didn't flag, `off` approves nothing, and `bypass`
// never gets here — a caller in that mode passes no `requestApproval` at all, so the tools skip
// the gate entirely. What a `false` means is the caller's: the TUI opens the prompt, headless
// declines, since there is no one to ask.
export function autoApproves(mode: AutoApproveMode, req: ApprovalRequest): boolean {
  if (mode !== 'safe') return false;
  return !req.warnings || req.warnings.length === 0;
}
