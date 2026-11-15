// ↑/↓ recall over the shared input history, as the TUI's Input does it: the first step back keeps
// the draft, stepping past the newest entry brings the draft back.

export type Recall = { index: number | null; draft: string };

export const notRecalling: Recall = { index: null, draft: '' };

export function recallStep(
  history: string[],
  recall: Recall,
  current: string,
  direction: 'older' | 'newer',
): { recall: Recall; text: string } | null {
  if (direction === 'older') {
    if (history.length === 0) return null;
    if (recall.index === null) {
      const index = history.length - 1;
      return { recall: { index, draft: current }, text: history[index] };
    }
    if (recall.index === 0) return null;
    const index = recall.index - 1;
    return { recall: { ...recall, index }, text: history[index] };
  }
  if (recall.index === null) return null;
  if (recall.index < history.length - 1) {
    const index = recall.index + 1;
    return { recall: { ...recall, index }, text: history[index] };
  }
  return { recall: notRecalling, text: recall.draft };
}
