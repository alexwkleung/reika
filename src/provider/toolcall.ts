import type OpenAI from 'openai';
import type { Message, Tool } from '../types.js';

export function messagesToOpenAI(
  system: string,
  history: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const freshFrom = findFreshToolBlockStart(history);
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: msg.content,
        tool_calls: msg.toolCalls?.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      });
    } else if (msg.role === 'tool') {
      const fresh = i >= freshFrom && msg.payload;
      const content = fresh
        ? `${msg.summary}\n\n${msg.payload}`
        : msg.summary;
      out.push({
        role: 'tool',
        tool_call_id: msg.callId,
        content,
      });
    }
  }
  return out;
}

// Start index of the trailing block of tool messages — tool messages at or after
// this index keep their payloads; earlier ones collapse to summary.
function findFreshToolBlockStart(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'tool') return i + 1;
  }
  return 0;
}

export function toolsToOpenAI(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
