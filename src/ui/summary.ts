import type { Message, Usage } from '../types.js';
import { scrubPaths } from './paths.js';

export type Approvals = {
  approved: number;
  declined: number;
};

export function buildSummary(
  messages: Message[],
  usage: Usage,
  startedAt: number,
  approvals: Approvals,
): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const userTurns = messages.filter(m => m.role === 'user' && !m.nested).length;
  const assistantTurns = messages.filter(m => m.role === 'assistant' && !m.nested).length;

  const toolCounts: Record<string, number> = {};
  const files = new Set<string>();

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
      if (tc.name === 'edit' || tc.name === 'write') {
        const p = tc.args.path;
        if (typeof p === 'string') files.add(p);
      }
    }
  }

  const totalTools = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  const subagentCount = toolCounts.subagent ?? 0;
  const breakdownEntries = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${c} ${n}`);
  const breakdown = breakdownEntries.length > 0 ? `  (${breakdownEntries.join(', ')})` : '';
  const filesText =
    files.size === 0
      ? '(none)'
      : Array.from(files)
          .sort()
          .map(f => scrubPaths(f))
          .join(', ');

  return [
    'Session summary',
    '─'.repeat(40),
    `Duration:        ${formatDuration(elapsed)}`,
    `Turns:           ${userTurns} user · ${assistantTurns} assistant`,
    `Tools:           ${totalTools}${breakdown}`,
    `Subagents:       ${subagentCount}`,
    `Tokens:          ${usage.promptTokens.toLocaleString()} ↑  ${usage.completionTokens.toLocaleString()} ↓`,
    ...(usage.cachedTokens && usage.promptTokens > 0
      ? [
          `Cache hits:      ${usage.cachedTokens.toLocaleString()} (${Math.round(
            (usage.cachedTokens / usage.promptTokens) * 100,
          )}% of prompt)`,
        ]
      : []),
    `Files modified:  ${filesText}`,
    `Approvals:       ${approvals.approved} approved, ${approvals.declined} declined`,
  ].join('\n');
}

export function hasActivity(messages: Message[]): boolean {
  return messages.some(m => m.role === 'user' && !m.nested);
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
