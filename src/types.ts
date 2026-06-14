import type { Ignore } from 'ignore';
import type { Skill } from './skills.js';

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type Message =
  | { role: 'user'; content: string; display?: string; nested?: boolean }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      reasoning?: string;
      durationMs?: number;
      sources?: string[];
      nested?: boolean;
    }
  | {
      role: 'tool';
      callId: string;
      summary: string;
      payload?: string;
      payloadId?: string;
      diff?: { text: string; path: string; added: number; removed: number };
      command?: { text: string; outputTail: string; outputTruncated: boolean };
      nested?: boolean;
    }
  | { role: 'error'; content: string; nested?: boolean }
  // `tone` styles the scrollback marker: undefined = default (accent ❯), 'info' = a routine
  // automatic event (compaction), 'warn' = an automatic recovery the user should notice
  // (truncation retry). Distinguishes harness-generated notices from each other and from
  // the user's own input.
  | { role: 'system'; content: string; tone?: 'info' | 'warn'; nested?: boolean }
  // A deterministic recap that replaces an older span of history once context nears the
  // window. Lives only in the model-facing history (merged into the system prompt by
  // messagesToOpenAI); the UI keeps the full scrollback separately.
  | { role: 'compaction'; content: string; nested?: boolean }
  | { role: 'header'; model: string; cwd: string; nested?: boolean }
  | { role: 'shell'; command: string; output: string; nested?: boolean };

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  // Prompt tokens served from the provider's cache. Populated when the provider
  // reports it (OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
  // `prompt_cache_hit_tokens`); undefined means the provider didn't report it.
  cachedTokens?: number;
};

export type ToolResult = {
  summary: string;
  payload?: string;
  display?: string;
  diff?: { text: string; path: string; added: number; removed: number };
  command?: { text: string; outputTail: string; outputTruncated: boolean };
};

export type ApprovalRequest = {
  tool: string;
  subject: string;
  preview: string;
  warnings?: string[];
};

export type WebBudget = {
  searches: { used: number; max: number };
  fetches: { used: number; max: number };
};

export type ToolContext = {
  cwd: string;
  ignore?: Ignore;
  webBudget?: WebBudget;
  // Tools push successfully-fetched URLs here; the loop stamps them onto the
  // final assistant message as `sources`, rendered deterministically in scrollback.
  fetchedUrls?: Set<string>;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  onProgress?: (chunk: string) => void;
  spawnSubagent?: (opts: { task: string }) => Promise<ToolResult>;
  // Wall-clock timeout for a bash command, ms. Threaded from Config so a long build/test/
  // install isn't killed prematurely. Undefined falls back to the bash tool's own default.
  bashTimeoutMs?: number;
};

export type ToolParameters = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type Tool = {
  name: string;
  description: string;
  parameters: ToolParameters;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

export type ContextBundle = {
  projectSummary: string;
  repoMap: string;
  instructions: string;
  cwd: string;
  hash: string;
  fileIndex: string[];
  ignore: Ignore;
  skills: Skill[];
};

export type Profile = {
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens?: number;
  // Total context window of the model, used as the denominator for the context-fill
  // gauge. Undefined when unknown (the gauge then shows absolute tokens, no percentage).
  contextWindow?: number;
  // Generation room reserved from the window, in tokens. Drives the per-turn max_tokens
  // backstop, the fit-to-window payload reserve, and the compaction trigger. Undefined =
  // use DEFAULT_MIN_GEN_TOKENS. See provider/budget.ts.
  minGenTokens?: number;
};

export type Config = {
  baseURL: string;
  apiKey: string;
  model: string;
  // Models served by the default base URL (parsed from a comma-separated REIKA_MODEL).
  // model === models[0]. When more than one is listed, each is also registered as an
  // auto-profile keyed by its lowercased name so /model <name> can switch between them.
  models: string[];
  maxTurns: number;
  repoMapBudget: number;
  autoApprove: boolean;
  subagentModel?: string;
  subagentBaseURL?: string;
  subagentApiKey?: string;
  subagentMaxTurns: number;
  tavilyApiKey?: string;
  searxngUrl?: string;
  profiles: Record<string, Profile>;
  maxTokens?: number;
  contextWindow?: number;
  // Generation room reserved from the window, in tokens (REIKA_MIN_GEN_TOKENS). Drives
  // the per-turn max_tokens backstop, the fit-to-window payload reserve, and the
  // compaction trigger — one number, three call sites. See provider/budget.ts.
  minGenTokens: number;
  // How many recent tool-call rounds keep their reasoning_content in context. Older
  // reasoning is pruned. 1 = only the active roundtrip (leanest); higher keeps the
  // model's chain-of-thought so it doesn't re-derive across rounds, at a token cost.
  reasoningRounds: number;
  maxSearchesPerTurn: number;
  maxFetchesPerTurn: number;
  // Wall-clock timeout for a single bash command, ms (REIKA_BASH_TIMEOUT_MS). Builds, installs
  // and full test suites routinely exceed the old 120s; 5 min covers them without letting a
  // hung command hold the agent loop too long.
  bashTimeoutMs: number;
};
