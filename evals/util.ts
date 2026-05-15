import type { Message } from '../src/types.js';

export function lastAssistantContent(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content) return m.content;
  }
  return null;
}

export function calledTool(messages: Message[], name: string): boolean {
  return messages.some(
    m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.name === name),
  );
}
