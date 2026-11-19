import { toolLabel } from '../../display/format.js';

// The words the dialogs put on what they ask about. Pure, so the wording is tested without a page.

// What an approval will do, as the transcript says it after: "Run", "Edit src/app.ts".
export function approvalHeading(
  tool: string,
  subject: string,
): { verb: string; target: string | null; where: string | null } {
  switch (tool) {
    case 'bash':
      // A command's subject is the directory it runs in.
      return { verb: 'Run a command', target: null, where: subject };
    case 'edit':
      return { verb: 'Edit', target: subject, where: null };
    case 'write':
      return { verb: 'Write', target: subject, where: null };
    case 'fetch_url':
      return { verb: 'Fetch from', target: subject, where: null };
    default:
      return { verb: toolLabel(tool), target: subject || null, where: null };
  }
}

// `+3 −1` for a preview in the `+ `/`- ` diff format; null when it holds no changed lines.
export function diffStat(preview: string): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  for (const line of preview.split('\n')) {
    if (line.startsWith('+ ')) added++;
    else if (line.startsWith('- ')) removed++;
  }
  return added || removed ? { added, removed } : null;
}

// `just now`, `5 min ago`, `2 h ago`, `3 d ago`, then the date: a resume list read at a glance.
export function savedAgo(savedAt: string, now: number): string {
  const at = Date.parse(savedAt);
  if (!Number.isFinite(at)) return savedAt;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(at).toISOString().slice(0, 10);
}
