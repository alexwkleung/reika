import type { Message, Mode } from '../types.js';
import { parsePlanSteps } from '../agent/plantrack.js';

// Defined in types.ts (messages carry it) and re-exported here, where the mode machinery lives.
export type { Mode };

// Shift+Tab cycling order: the model-driven modes first (agent → plan → vibe), then the
// isolated ones (chat → shell), wrapping back to agent.
export const MODE_CYCLE: Mode[] = ['agent', 'plan', 'vibe', 'chat', 'shell'];

export function nextMode(current: Mode): Mode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
}

// The mode a turn is recorded under (stamped on its prompt, then summarized by /save). Normally
// the mode the turn runs with — including a one-turn override like /implement's, which really is
// an agent turn taken from plan mode. Vibe is the exception: it drives its two phases through
// 'plan' and 'agent' overrides, but the session was in vibe mode throughout, and a transcript
// reading "plan turn, agent turn" would misdescribe how the work was done.
export function turnMode(current: Mode, active: Mode): Mode {
  return current === 'vibe' ? 'vibe' : active;
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
