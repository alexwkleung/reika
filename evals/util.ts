import type { Message, ToolCall } from '../src/types.js';

export function lastAssistantContent(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) return m.content;
  }
  return null;
}

export function calledTool(messages: Message[], name: string): boolean {
  return messages.some(m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.name === name));
}

// The locator an over-cap grep/glob result pointed the model at (tools/_spill.ts), or null when
// nothing was capped — which is also what you get with REIKA_SPILL off, so a fixture can tell
// "the flag is off" apart from "the model ignored the footer".
export function spilledPath(messages: Message[]): string | null {
  for (const m of messages) {
    if (m.role !== 'tool' || !m.payload) continue;
    const hit = /saved to (\S+\.txt)/.exec(m.payload);
    if (hit) return hit[1];
  }
  return null;
}

// Tool calls issued after the result that carried `path` — the window the follow-the-locator
// question lives in. The call immediately after a capped result is the whole experiment: reading
// the spill file, re-running the search, or routing around it.
export function callsAfterSpill(messages: Message[], path: string): ToolCall[] {
  const at = messages.findIndex(m => m.role === 'tool' && !!m.payload && m.payload.includes(path));
  if (at < 0) return [];
  return messages.slice(at + 1).flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
}

// Whether a call reads back the spill artifact, by either supported route (`read` it or `grep`
// it) — the retrieval hint names both, so both count as following the locator.
export function readsSpill(call: ToolCall, path: string): boolean {
  if (call.name !== 'read' && call.name !== 'grep') return false;
  return Object.values(call.args).some(v => typeof v === 'string' && v.includes(path));
}
