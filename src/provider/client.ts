import OpenAI from 'openai';
import { jsonrepair } from 'jsonrepair';
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
        ...(opts.config.maxTokens ? { max_tokens: opts.config.maxTokens } : {}),
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
        | ((typeof chunk.choices)[0]['delta'] & {
            reasoning_content?: string | null;
            reasoning?: string | null;
          })
        | undefined;
      if (!delta) continue;
      if (delta.content) {
        contentParts.push(delta.content);
        opts.onContentDelta?.(delta.content);
      }
      // Field name differs by provider: DeepSeek/Kimi use `reasoning_content`,
      // OpenRouter normalizes to `reasoning`. Accept either.
      const reasoningChunk = delta.reasoning_content ?? delta.reasoning;
      if (reasoningChunk) {
        reasoningParts.push(reasoningChunk);
        opts.onReasoningDelta?.(reasoningChunk);
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
    const name = sanitizeToolName(acc.name);
    const { args, repaired } = tryParseJson(acc.args || '{}');
    if (repaired) {
      process.stderr.write(`[reika] repaired malformed JSON in tool args for ${name}\n`);
    }
    toolCalls.push({ id: acc.id, name, args });
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

// Strip chat-template artifacts that some servers (Harmony / gpt-oss, certain
// llama.cpp builds) leak into the tool name field. Exported for unit tests.
export function sanitizeToolName(raw: string): string {
  return raw.replace(/<\|[^|]*\|>.*$/, '').trim();
}

// Parse tool-call JSON args with a forgiving fallback. Small/local models
// occasionally emit slop (trailing commas, single quotes, unquoted keys, truncation).
// `repaired: true` signals jsonrepair was used — caller may want to log it so
// "this tool got weird args" is debuggable. Exported for unit tests.
export function tryParseJson(input: string): {
  args: Record<string, unknown> & { name?: unknown; arguments?: unknown; args?: unknown };
  repaired: boolean;
} {
  const wrap = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  try {
    return { args: wrap(JSON.parse(input || '{}')), repaired: false };
  } catch {
    // fall through to repair
  }
  try {
    return { args: wrap(JSON.parse(jsonrepair(input))), repaired: true };
  } catch {
    return { args: {}, repaired: false };
  }
}

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

export function extractToolCallsFromContent(content: string): {
  calls: ToolCall[];
  cleanedContent: string;
} {
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(content)) !== null) {
    const { args: parsed, repaired } = tryParseJson(match[1]);
    if (typeof parsed.name !== 'string') continue;
    const rawArgs = parsed.arguments ?? parsed.args ?? {};
    const args =
      typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {};
    if (repaired) {
      process.stderr.write(`[reika] repaired malformed JSON in <tool_call> for ${parsed.name}\n`);
    }
    calls.push({
      id: `xml-${Math.random().toString(36).slice(2, 10)}`,
      name: parsed.name,
      args,
    });
  }
  const cleanedContent = content.replace(TOOL_CALL_RE, '').trim();
  return { calls, cleanedContent };
}
