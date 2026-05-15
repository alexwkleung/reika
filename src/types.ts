export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type Message =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      reasoning?: string;
    }
  | { role: 'tool'; callId: string; summary: string; payload?: string; payloadId?: string }
  | { role: 'error'; content: string };

export type ToolResult = {
  summary: string;
  payload?: string;
  display?: string;
};

export type ApprovalRequest = {
  tool: string;
  subject: string;
  preview: string;
};

export type ToolContext = {
  cwd: string;
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
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
};

export type Config = {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  repoMapBudget: number;
  autoApprove: boolean;
};
