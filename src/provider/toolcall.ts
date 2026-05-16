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
      const hasTools = !!msg.toolCalls && msg.toolCalls.length > 0;
      const param: Record<string, unknown> = {
        role: 'assistant',
        content: hasTools && !msg.content ? null : msg.content,
      };
      if (hasTools) {
        param.tool_calls = msg.toolCalls!.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));
      }
      if (msg.reasoning) {
        param.reasoning_content = msg.reasoning;
      }
      out.push(param as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    } else if (msg.role === 'tool') {
      const fresh = i >= freshFrom && msg.payload;
      const content = fresh
        ? `${msg.summary}\n\n${msg.payload}`
        : msg.summary;
      const toolName = findToolNameForCall(history, msg.callId);
      const param: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: msg.callId,
        content,
      };
      if (toolName) param.name = toolName;
      out.push(param as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    }
    // error messages are UI-only and intentionally skipped here
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

function findToolNameForCall(history: Message[], callId: string): string | undefined {
  for (const msg of history) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;
    const match = msg.toolCalls.find(tc => tc.id === callId);
    if (match) return match.name;
  }
  return undefined;
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
