import OpenAI from 'openai';
import type { Config, Message, Tool, ToolCall, Usage } from '../types.js';
import { messagesToOpenAI, toolsToOpenAI } from './toolcall.js';

export type ModelResponse = {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
};

export async function callModel(opts: {
  system: string;
  history: Message[];
  tools: Tool[];
  config: Config;
  onContentDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<ModelResponse> {
  if (opts.signal?.aborted) {
    return { content: '', toolCalls: undefined };
  }
  const client = new OpenAI({
    baseURL: opts.config.baseURL,
    apiKey: opts.config.apiKey,
  });
  const messages = messagesToOpenAI(opts.system, opts.history);

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage | undefined;

  try {
    const stream = await client.chat.completions.create(
      {
        model: opts.config.model,
        messages,
        tools: opts.tools.length > 0 ? toolsToOpenAI(opts.tools) : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: opts.signal },
    );

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
      const delta = chunk.choices[0]?.delta as
        | (typeof chunk.choices[0]['delta'] & { reasoning_content?: string | null })
        | undefined;
      if (!delta) continue;
      if (delta.content) {
        contentParts.push(delta.content);
        opts.onContentDelta?.(delta.content);
      }
      if (delta.reasoning_content) {
        reasoningParts.push(delta.reasoning_content);
        opts.onReasoningDelta?.(delta.reasoning_content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let acc = callsByIndex.get(idx);
          if (!acc) {
            acc = { id: tc.id ?? '', name: '', args: '' };
            callsByIndex.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) {
      return {
        content: contentParts.join(''),
        reasoning: reasoningParts.join('') || undefined,
        toolCalls: undefined,
        usage,
      };
    }
    throw e;
  }

  const toolCalls: ToolCall[] = [];
  for (const [, acc] of callsByIndex) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(acc.args || '{}');
    } catch {}
    toolCalls.push({ id: acc.id, name: acc.name, args: parsed });
  }

  let content = contentParts.join('');

  if (toolCalls.length === 0) {
    const fallback = extractToolCallsFromContent(content);
    if (fallback.calls.length > 0) {
      toolCalls.push(...fallback.calls);
      content = fallback.cleanedContent;
    }
  }

  return {
    content,
    reasoning: reasoningParts.join('') || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
  };
}

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

function extractToolCallsFromContent(
  content: string,
): { calls: ToolCall[]; cleanedContent: string } {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as {
        name?: unknown;
        arguments?: unknown;
        args?: unknown;
      };
      if (typeof parsed.name !== 'string') continue;
      const rawArgs = parsed.arguments ?? parsed.args ?? {};
      const args =
        typeof rawArgs === 'object' && rawArgs !== null
          ? (rawArgs as Record<string, unknown>)
          : {};
      calls.push({
        id: `xml-${Math.random().toString(36).slice(2, 10)}`,
        name: parsed.name,
        args,
      });
    } catch {}
  }
  const cleanedContent = content.replace(TOOL_CALL_RE, '').trim();
  return { calls, cleanedContent };
}
