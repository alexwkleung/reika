import type {
  ApprovalRequest,
  Config,
  ContextBundle,
  Message,
  Tool,
  Usage,
} from '../types.js';
import { buildSystemPrompt } from './prompt.js';
import { callModel } from '../provider/client.js';
import type { PayloadStore } from '../store/payloads.js';

export async function runTurn(opts: {
  userInput: string;
  history: Message[];
  bundle: ContextBundle;
  config: Config;
  tools: Tool[];
  payloads: PayloadStore;
  onMessage: (msg: Message) => void;
  onContentDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onPhase?: (phase: 'thinking' | 'tool') => void;
  onUsage?: (usage: Usage) => void;
  onToolProgress?: (chunk: string) => void;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<void> {
  const userMsg: Message = { role: 'user', content: opts.userInput };
  opts.history.push(userMsg);
  opts.onMessage(userMsg);

  const system = buildSystemPrompt({ bundle: opts.bundle });

  for (let i = 0; i < opts.config.maxTurns; i++) {
    if (opts.signal?.aborted) {
      commitAborted(opts, '');
      return;
    }
    opts.onPhase?.('thinking');
    const response = await callModel({
      system,
      history: opts.history,
      tools: opts.tools,
      config: opts.config,
      onContentDelta: opts.onContentDelta,
      onReasoningDelta: opts.onReasoningDelta,
      signal: opts.signal,
    });

    if (response.usage) opts.onUsage?.(response.usage);

    if (opts.signal?.aborted) {
      commitAborted(opts, response.content);
      return;
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      reasoning: response.reasoning,
    };
    opts.history.push(assistantMsg);
    opts.onMessage(assistantMsg);

    if (!response.toolCalls || response.toolCalls.length === 0) return;

    opts.onPhase?.('tool');
    for (const call of response.toolCalls) {
      if (opts.signal?.aborted) return;
      const tool = opts.tools.find(t => t.name === call.name);
      let summary: string;
      let payload: string | undefined;
      if (!tool) {
        summary = `Unknown tool: ${call.name}`;
      } else {
        try {
          const result = await tool.run(call.args, {
            cwd: opts.bundle.cwd,
            requestApproval: opts.requestApproval,
            onProgress: opts.onToolProgress,
          });
          summary = result.summary;
          payload = result.payload;
        } catch (e) {
          summary = `Tool error: ${(e as Error).message}`;
        }
      }
      const payloadId = payload ? opts.payloads.put(payload) : undefined;
      const toolMsg: Message = {
        role: 'tool',
        callId: call.id,
        summary,
        payload,
        payloadId,
      };
      opts.history.push(toolMsg);
      opts.onMessage(toolMsg);
    }
  }

  const exhausted: Message = {
    role: 'assistant',
    content: `(reached max turns of ${opts.config.maxTurns}; ask me to continue or raise REIKA_MAX_TURNS)`,
  };
  opts.history.push(exhausted);
  opts.onMessage(exhausted);
}

function commitAborted(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  partial: string,
): void {
  const content = partial ? `${partial}\n\n(aborted)` : '(aborted)';
  const m: Message = { role: 'assistant', content };
  opts.history.push(m);
  opts.onMessage(m);
}
