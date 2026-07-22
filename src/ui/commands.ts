import type { Message } from '../types.js';

export type Mode = 'agent' | 'shell' | 'chat' | 'plan' | 'vibe';

// Shift+Tab cycling order: the model-driven modes first (agent → plan → vibe), then the
// isolated ones (chat → shell), wrapping back to agent.
export const MODE_CYCLE: Mode[] = ['agent', 'plan', 'vibe', 'chat', 'shell'];

export function nextMode(current: Mode): Mode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
}

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
  { name: 'plan', desc: 'enter plan mode (read-only exploration; ends with a written plan)' },
  { name: 'vibe', desc: 'enter vibe mode (every prompt plans first, then implements the plan)' },
  { name: 'agent', desc: 'return to agent mode' },
  { name: 'implement', desc: 'switch to agent mode and execute the plan above' },
  {
    name: 'model',
    desc: 'pick a model/profile interactively (/model <name> switches directly, even to a model not in your config)',
  },
  { name: 'approvals', desc: 'show/toggle session auto-approve (on|off)' },
  { name: 'cwd', desc: 'show working directory' },
  { name: 'tokens', desc: 'show token usage this session' },
  { name: 'skills', desc: 'list available skills (loaded from skills dirs)' },
  { name: 'stats', desc: 'show full session summary' },
  {
    name: 'save',
    desc: 'save the full conversation to ~/.config/reika/history (--raw skips redaction)',
  },
  { name: 'exit', desc: 'exit Reika' },
  { name: 'quit', desc: 'alias of /exit' },
];

// The model-facing prompt for /implement. Kept short and directive — the target is small local
// models, and the plan it refers to ("the plan above") is already in history (kept verbatim by the
// plan→agent handoff distillation), so this only has to point at it and set the working style.
// Any trailing /implement args become explicit additional guidance.
export function buildImplementPrompt(extra: string): string {
  const base =
    'Implement the plan above. Work through it step by step, making the edits to the files it names.';
  const trimmed = extra.trim();
  return trimmed ? `${base}\n\nAdditional guidance: ${trimmed}` : base;
}

// Whether a turn produced a finalized plan — the marker loop.ts stamps on a plan-mode turn's
// closing assistant message. Vibe mode gates its implement phase on this, so an aborted or
// dead-ended plan turn never chains into edits.
export function planWritten(messages: Message[]): boolean {
  return messages.some(m => m.role === 'assistant' && !!m.planFinal);
}
