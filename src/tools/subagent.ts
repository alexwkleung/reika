import type { Tool } from '../types.js';

export const subagentTool: Tool = {
  name: 'subagent',
  description:
    "Spawn a subagent to handle a focused exploration or task in an isolated conversation. Use this when the task requires reading many files (>3) or chasing a long chain of references — the subagent's exploration stays out of your context. The subagent has its own conversation history (no parent context) and runs with read/grep/list/edit/write/bash. It cannot spawn its own subagents. Returns the subagent's final response.",
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          "A specific, self-contained task description. The subagent has no parent context, so include any relevant file paths, symbols, or constraints explicitly.",
      },
    },
    required: ['task'],
  },
  async run(args, ctx) {
    if (!ctx.spawnSubagent) {
      return { summary: 'Subagent not available in this context' };
    }
    const task = String(args.task ?? '').trim();
    if (!task) return { summary: 'Subagent failed: empty task' };
    return await ctx.spawnSubagent({ task });
  },
};
