import type { ContextBundle } from '../types.js';

export type PromptMode = 'agent' | 'chat';

export function buildSystemPrompt(opts: {
  bundle: ContextBundle;
  mode?: PromptMode;
  planMode?: boolean;
}): string {
  const mode = opts.mode ?? 'agent';
  if (mode === 'chat') {
    return buildChatPrompt(opts.bundle);
  }
  return buildAgentPrompt(opts);
}

function buildAgentPrompt(opts: { bundle: ContextBundle; planMode?: boolean }): string {
  const parts: string[] = [
    [
      'You are a coding assistant operating in a terminal. Be concise.',
      'Rules:',
      "1. For any question about this project's code, you MUST use tools before answering. Never describe code from general knowledge.",
      '2. To find where something is defined, use grep for the symbol name. Do NOT guess file paths or extensions.',
      '3. Before edit, read the file to see exact text. Your old_string must be copied verbatim from the file, including indentation.',
      '4. If a tool call fails, do not give up — try a different tool (grep, list, read) to recover.',
      '5. Only the listed tools exist. Use their exact names.',
      '6. Before creating a new file in an existing directory, OR adding to a registry/list/array, you MUST read at least one existing example to learn its shape and exact exported interface. Never invent a structure.',
    ].join('\n'),
    `Working directory: ${opts.bundle.cwd}`,
  ];
  if (opts.bundle.projectSummary) {
    parts.push(`Project:\n${opts.bundle.projectSummary}`);
  }
  if (opts.bundle.repoMap) {
    parts.push(`Repo map:\n${opts.bundle.repoMap}`);
  }
  if (opts.bundle.instructions) {
    parts.push(`Project instructions:\n${opts.bundle.instructions}`);
  }
  if (opts.planMode) {
    parts.push('Plan mode: describe your approach first. Do not modify files.');
  }
  return parts.join('\n\n');
}

function buildChatPrompt(_bundle: ContextBundle): string {
  return [
    'You are a helpful assistant running in a terminal chat. Be concise and direct.',
    "You do not have access to the user's filesystem or shell in this mode. If web-search tools are available, use them only when the answer requires current information or external documentation.",
  ].join('\n\n');
}
