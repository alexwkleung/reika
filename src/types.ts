import type { Ignore } from 'ignore';
import type { Skill } from './skills.js';

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type Message =
  // `meta` marks a UI-only echo of a slash command (e.g. `/model`, `/stats`): shown in the
  // scrollback as the user's input but never sent to the model — its system response is
  // already dropped, so a bare command turn would just be redundant context.
  | { role: 'user'; content: string; display?: string; nested?: boolean; meta?: boolean }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      reasoning?: string;
      durationMs?: number;
      sources?: string[];
      nested?: boolean;
      // Set only on the plan-mode force-write final message — the verbatim anchor the
      // agent-handoff distillation pins on (agent/compaction.ts distillPlanHandoff). Never
      // set in agent or chat mode.
      planFinal?: boolean;
    }
  | {
      role: 'tool';
      callId: string;
      summary: string;
      payload?: string;
      payloadId?: string;
      diff?: { text: string; path: string; added: number; removed: number; startLine?: number };
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
  // Hash of the whole file the read covered. Set only by `read`; lets the loop's ReadTrace
  // tell a re-read of unchanged content from a legitimate refetch after the file changed,
  // without a second disk read. Keyed on the full file (not the slice) so a window-varying
  // re-read of the same region still hashes identically. See agent/readtrace.ts.
  contentHash?: string;
  // A user-facing receipt for a harness side effect the tool performed (e.g. URL grounding fetching
  // a link). The loop emits it as a standalone `system` scrollback line AFTER the tool's own chip,
  // so it reads as a follow-on to the action rather than being stuffed in front of it. `warn` for an
  // outcome worth noticing (a dead link), `info` for a quiet "this ran".
  notice?: { tone: 'info' | 'warn'; content: string };
};

export type ApprovalRequest = {
  tool: string;
  subject: string;
  preview: string;
  // 1-based file line number of the first line in `preview`, when it's a diff.
  // Lets the diff view render an editor-style line-number gutter.
  startLine?: number;
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
  // Dependency package names whose installed type surface has already been injected into a
  // tool result this turn (see tools/_deps.ts). edit/write consult and extend it so each
  // imported dep is grounded at most once per turn — bounded bloat, no re-injection.
  resolvedDeps?: Set<string>;
  // http(s) URLs already grounded (fetched on the model's behalf) this turn (see tools/_urls.ts).
  // Same per-turn dedupe contract as resolvedDeps: each URL a write/edit introduces is fetched at
  // most once, so a follow-up edit to the same file doesn't re-fetch it.
  groundedUrls?: Set<string>;
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

// How much runs without a confirmation prompt.
//   'off'    — confirm every mutating action (the session toggle may still raise this to 'safe').
//   'safe'   — auto-approve ordinary actions, but commands flagged dangerous (see bash.ts danger
//              patterns) still prompt. The warnings break-glass.
//   'bypass' — approve everything, including dangerous commands. True yolo, no prompts at all.
export type AutoApproveMode = 'off' | 'safe' | 'bypass';

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
  autoApprove: AutoApproveMode;
  subagentModel?: string;
  subagentBaseURL?: string;
  subagentApiKey?: string;
  subagentMaxTurns: number;
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
