import type {
  ApprovalRequest,
  Config,
  ContextBundle,
  Message,
  Tool,
  ToolResult,
  Usage,
  WebBudget,
} from '../types.js';
import { buildSystemPrompt, type PromptMode } from './prompt.js';
import { callModel } from '../provider/client.js';
import { estimateRequestTokens } from '../provider/tokens.js';
import { compactHistory, shouldCompact } from './compaction.js';
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
  // Pre-send estimate of the next request's prompt tokens. Fires before each model
  // call so the UI can show context fill before the provider's real count arrives.
  onContextEstimate?: (tokens: number) => void;
  // Calibration of the char-based estimate against the provider's real token count,
  // threaded across turns (each turn re-seeds the full history, so the learned factor
  // must persist for the first call's compaction decision to be accurate).
  priorCalibration?: number;
  onCalibration?: (factor: number) => void;
  onToolProgress?: (chunk: string) => void;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  promptMode?: PromptMode;
}): Promise<void> {
  const userMsg: Message = {
    role: 'user',
    content: opts.userInput,
    ...(opts.userDisplay ? { display: opts.userDisplay } : {}),
  };
  opts.history.push(userMsg);
  opts.onMessage(userMsg);

  const system = buildSystemPrompt({ bundle: opts.bundle, mode: opts.promptMode });
  const turnStart = Date.now();
  // One budget per user turn — caps total search + fetch calls across all
  // internal model→tool rounds. Subagent calls get their own budget.
  const webBudget: WebBudget = {
    searches: { used: 0, max: opts.config.maxSearchesPerTurn },
    fetches: { used: 0, max: opts.config.maxFetchesPerTurn },
  };
  // Track URLs successfully fetched this turn. Stamped onto the final assistant
  // message as `sources` for deterministic citation rendering (no model recall).
  const fetchedUrls = new Set<string>();
  // Notify the user at most once per turn that compaction kicked in, even if it runs
  // again across the turn's tool rounds.
  let notifiedCompaction = false;

  const window = opts.config.contextWindow;
  // The char-based estimate systematically diverges from a model's real tokenizer (code,
  // JSON and CJK tokenize denser). Calibrate it against the provider's reported
  // promptTokens so the compaction trigger fires at the *real* threshold, not a heuristic
  // one. Seeded from the prior turn's learned factor since each turn re-seeds the full
  // history from the UI scrollback.
  let calibration = opts.priorCalibration && opts.priorCalibration > 0 ? opts.priorCalibration : 1;
  const rawEstimate = (): number =>
    estimateRequestTokens(system, opts.history, opts.tools, { contextWindow: window, calibration });

  for (let i = 0; i < opts.config.maxTurns; i++) {
    if (opts.signal?.aborted) {
      commitAborted(opts, '', turnStart, fetchedUrls);
      return;
    }
    opts.onPhase?.('thinking');

    // Keep the request under the window: if the calibrated estimate crosses the threshold,
    // collapse the oldest turns into a recap before calling. Compaction mutates this turn's
    // history copy; the UI scrollback is untouched, so the user keeps the full log.
    if (window && shouldCompact(rawEstimate() * calibration, window)) {
      const removed = compactHistory(opts.history, window, calibration);
      if (removed > 0 && !notifiedCompaction) {
        notifiedCompaction = true;
        opts.onMessage({
          role: 'system',
          content: `Context compacted — folded ${removed} earlier message${
            removed === 1 ? '' : 's'
          } into a recap (older tool output still re-readable).`,
        });
      }
    }
    const sentEstimate = rawEstimate();
    opts.onContextEstimate?.(Math.round(sentEstimate * calibration));
    const response = await callModel({
      system,
      history: opts.history,
      tools: opts.tools,
      config: opts.config,
      onContentDelta: opts.onContentDelta,
      onReasoningDelta: opts.onReasoningDelta,
      signal: opts.signal,
      calibration,
    });

    if (response.usage) opts.onUsage?.(response.usage);

    // Recalibrate from what the provider actually counted vs. what we estimated for the
    // request we just sent. Clamped to a sane band to ignore one-off outliers.
    if (response.usage?.promptTokens && sentEstimate > 0) {
      const factor = response.usage.promptTokens / sentEstimate;
      if (factor > 0.2 && factor < 8) {
        calibration = factor;
        opts.onCalibration?.(calibration);
      }
    }

    if (opts.signal?.aborted) {
      commitAborted(opts, response.content, turnStart, fetchedUrls);
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
      ...(isFinal && fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
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
      let diff: ToolResult['diff'];
      let command: ToolResult['command'];
      if (!tool) {
        summary = `Unknown tool: ${call.name}`;
      } else {
        try {
          const result = await tool.run(call.args, {
            cwd: opts.bundle.cwd,
            ignore: opts.bundle.ignore,
            webBudget,
            fetchedUrls,
            requestApproval: opts.requestApproval,
            onProgress: opts.onToolProgress,
            spawnSubagent: makeSpawnSubagent(opts),
          });
          summary = result.summary;
          payload = result.payload;
          diff = result.diff;
          command = result.command;
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
        ...(diff ? { diff } : {}),
        ...(command ? { command } : {}),
      };
      opts.history.push(toolMsg);
      opts.onMessage(toolMsg);
    }
  }

  const exhausted: Message = {
    role: 'assistant',
    content: `(reached max turns of ${opts.config.maxTurns}; ask me to continue or raise the turn limit)`,
    durationMs: Date.now() - turnStart,
    ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
  };
  opts.history.push(exhausted);
  opts.onMessage(exhausted);
}

function commitAborted(
  opts: { history: Message[]; onMessage: (m: Message) => void },
  partial: string,
  turnStart: number,
  fetchedUrls: Set<string>,
): void {
  const content = partial ? `${partial}\n\n(aborted)` : '(aborted)';
  const m: Message = {
    role: 'assistant',
    content,
    durationMs: Date.now() - turnStart,
    ...(fetchedUrls.size > 0 ? { sources: [...fetchedUrls] } : {}),
  };
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
