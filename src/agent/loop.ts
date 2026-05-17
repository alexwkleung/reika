import type {
  ApprovalRequest,
  Config,
  ContextBundle,
  Message,
  Tool,
  ToolResult,
  Usage,
} from '../types.js';
import { buildSystemPrompt } from './prompt.js';
import { callModel } from '../provider/client.js';
import type { PayloadStore } from '../store/payloads.js';

export async function runTurn(opts: {
  userInput: string;
  userDisplay?: string;
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
  const userMsg: Message = {
    role: 'user',
    content: opts.userInput,
    ...(opts.userDisplay ? { display: opts.userDisplay } : {}),
  };
  opts.history.push(userMsg);
  opts.onMessage(userMsg);

  const system = buildSystemPrompt({ bundle: opts.bundle });
  const turnStart = Date.now();

  for (let i = 0; i < opts.config.maxTurns; i++) {
    if (opts.signal?.aborted) {
      commitAborted(opts, '', turnStart);
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
      commitAborted(opts, response.content, turnStart);
      return;
    }

    const toolCalls = response.toolCalls ?? [];
    const isFinal = toolCalls.length === 0;
    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
      reasoning: response.reasoning,
      ...(isFinal ? { durationMs: Date.now() - turnStart } : {}),
    };
    opts.history.push(assistantMsg);
    opts.onMessage(assistantMsg);

    if (isFinal) return;

    opts.onPhase?.('tool');
    for (const call of toolCalls) {
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
            ignore: opts.bundle.ignore,
            requestApproval: opts.requestApproval,
            onProgress: opts.onToolProgress,
            spawnSubagent: makeSpawnSubagent(opts),
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
    content: `(reached max turns of ${opts.config.maxTurns}; ask me to continue or raise the turn limit)`,
    durationMs: Date.now() - turnStart,
  };
  opts.history.push(exhausted);
  opts.onMessage(exhausted);
}

function commitAborted(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  partial: string,
  turnStart: number,
): void {
  const content = partial ? `${partial}\n\n(aborted)` : '(aborted)';
  const m: Message = { role: 'assistant', content, durationMs: Date.now() - turnStart };
  opts.history.push(m);
  opts.onMessage(m);
}

type RunTurnOpts = Parameters<typeof runTurn>[0];

function makeSpawnSubagent(parent: RunTurnOpts) {
  return async (sub: { task: string }): Promise<ToolResult> => {
    const subConfig: Config = {
      ...parent.config,
      model: parent.config.subagentModel ?? parent.config.model,
      baseURL: parent.config.subagentBaseURL ?? parent.config.baseURL,
      apiKey: parent.config.subagentApiKey ?? parent.config.apiKey,
      maxTurns: parent.config.subagentMaxTurns,
    };
    const subTools = parent.tools.filter(t => t.name !== 'subagent');
    const subHistory: Message[] = [];

    await runTurn({
      userInput: sub.task,
      history: subHistory,
      bundle: parent.bundle,
      config: subConfig,
      tools: subTools,
      payloads: parent.payloads,
      signal: parent.signal,
      requestApproval: parent.requestApproval,
      onUsage: parent.onUsage,
      onMessage: msg => parent.onMessage({ ...msg, nested: true } as Message),
      // streaming + phase callbacks are intentionally not forwarded so the parent's
      // live region stays clean; subagent activity is visible via nested committed messages
    });

    const finalAssistant = [...subHistory].reverse().find(m => m.role === 'assistant') as
      | (Message & { role: 'assistant' })
      | undefined;
    const result = finalAssistant?.content ?? '';
    const usedDifferentModel = subConfig.model !== parent.config.model;
    return {
      summary: usedDifferentModel
        ? `Subagent (${subConfig.model}) completed (${result.length} chars)`
        : `Subagent completed (${result.length} chars)`,
      payload: result || '(no output)',
    };
  };
}
