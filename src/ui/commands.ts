import type { Message } from '../types.js';
import { parsePlanSteps } from '../agent/plantrack.js';

export type CommandSpec = {
  name: string;
  desc: string;
};

export const COMMANDS: CommandSpec[] = [
  { name: 'help', desc: 'show this list' },
  { name: 'new', desc: 'reset conversation, tokens, mode' },
  { name: 'clear', desc: 'alias of /new' },
  { name: 'cd', desc: 'change cwd (re-indexes repo map)' },
  { name: 'shell', desc: 'enter shell mode (raw bash, no model)' },
  { name: 'chat', desc: 'enter chat mode (no filesystem/shell tools; isolated context)' },
  {
    name: 'plan',
    desc: 'enter plan mode (read-only exploration; ends with a written plan — send another message to refine it)',
  },
  { name: 'vibe', desc: 'enter vibe mode (every prompt plans first, then implements the plan)' },
  {
    name: 'minimal',
    desc: 'enter minimal mode (shell only; no repo map, project summary, or AGENTS.md loaded)',
  },
  {
    name: 'grind',
    desc: 'enter grind mode (works through a verify-everything procedure; bash, read, edit)',
  },
  { name: 'agent', desc: 'return to agent mode' },
  {
    name: 'implement',
    desc: 'execute the plan above (from plan mode: pick agent, minimal, or grind to run it in)',
  },
  { name: 'compact', desc: 'fold older context into a recap now (compaction note, then fold)' },
  {
    name: 'model',
    desc: 'pick a model/profile interactively (/model <name> switches directly, even to a model not in your config)',
  },
  {
    name: 'approvals',
    desc: 'toggle session auto-approve (on|off; bare command opens the picker)',
  },
  {
    name: 'unattended',
    desc: 'toggle unattended — decline instead of prompting while you are away (on|off; bare command opens the picker)',
  },
  {
    name: 'anon',
    desc: 'toggle anonymized display — hides your name, email, and account slugs (on|off; bare command opens the picker)',
  },
  { name: 'cwd', desc: 'show working directory' },
  { name: 'tokens', desc: 'show token usage this session' },
  { name: 'skills', desc: 'list available skills (loaded from skills dirs)' },
  {
    name: 'mcp',
    desc: 'list MCP servers and their tools (each tool is also a /<server>:<tool> command)',
  },
  {
    name: 'search',
    desc: 'search the web for a query (needs a search provider; the model runs it and answers from the results)',
  },
  { name: 'stats', desc: 'show full session summary' },
  {
    name: 'save',
    desc: 'save the full conversation to ~/.config/reika/history, even mid-turn (--raw skips redaction)',
  },
  {
    name: 'resume',
    desc: 'resume a saved session — this project auto-saves as you go (chat mode: chats; all; root: the /save files)',
  },
  { name: 'exit', desc: 'exit Reika' },
  { name: 'quit', desc: 'alias of /exit' },
];

// Whether a turn produced a plan worth acting on. The `planFinal` marker alone is not that:
// loop.ts stamps it on ANY final plan-mode message, including a force-write that ended a spiral,
// so "the plan turn finished" and "there is a plan" are different claims (#126). Requiring at
// least one parsed step is the same 0-step definition `seedPlanProgress` has always used — a
// message with no steps yields no checklist, and it should not yield an implementation either.
//
// Deliberately no stricter than that (a step naming no file is still a step): a plan can be
// legitimate without quoting paths, and the failure this guards is a spiral's output, which has
// no numbered steps at all.
export function planWritten(messages: Message[]): boolean {
  return messages.some(
    m => m.role === 'assistant' && !!m.planFinal && parsePlanSteps(m.content ?? '').length > 0,
  );
}

// Whether a submitted line is `/save` (with or without its `--raw` flag). App routes exactly this
// command past the busy queue (#226); it is a whole-word match so `/saved` or a skill named
// `/save-notes` still queue like anything else.
export function isSaveCommand(input: string): boolean {
  return /^\/save(?:\s|$)/i.test(input.trim());
}
