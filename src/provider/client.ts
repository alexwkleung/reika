import OpenAI from 'openai';
import type { Config, Message, Tool, ToolCall } from '../types.js';
import { messagesToOpenAI, toolsToOpenAI } from './toolcall.js';

export type ModelResponse = {
  content: string;
  toolCalls?: ToolCall[];
};

export async function callModel(opts: {
  system: string;
  history: Message[];
  tools: Tool[];
  config: Config;
  onContentDelta?: (text: string) => void;
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
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>();

  try {
    const stream = await client.chat.completions.create(
      {
        model: opts.config.model,
        messages,
        tools: opts.tools.length > 0 ? toolsToOpenAI(opts.tools) : undefined,
        stream: true,
      },
      { signal: opts.signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        contentParts.push(delta.content);
        opts.onContentDelta?.(delta.content);
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
      return { content: contentParts.join(''), toolCalls: undefined };
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

  return {
    content: contentParts.join(''),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}
