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
  | { role: 'system'; content: string; nested?: boolean }
  | { role: 'header'; model: string; cwd: string; nested?: boolean }
  | { role: 'shell'; command: string; output: string; nested?: boolean };

export type Usage = {
  promptTokens: number;
  completionTokens: number;
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
};

export type Config = {
  baseURL: string;
  apiKey: string;
  model: string;
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
  maxSearchesPerTurn: number;
  maxFetchesPerTurn: number;
};
