import type { Message, Mode } from '../types.js';
import { parsePlanSteps } from '../agent/plantrack.js';

// Defined in types.ts (messages carry it) and re-exported here, where the mode machinery lives.
export type { Mode };

// Shift+Tab cycling order: the model-driven modes first (agent → plan → minimal → vibe → grind),
// then the isolated ones (chat → shell), wrapping back to agent. Minimal sits right after plan
// (#400): the three single-turn modes are adjacent, and vibe — the plan→implement chain — follows.
// Grind (#556) closes the group: it is the slowest mode, so a stray Shift+Tab from agent should not
// land on it first.
export const MODE_CYCLE: Mode[] = ['agent', 'plan', 'minimal', 'vibe', 'grind', 'chat', 'shell'];

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

// Which tool list and system prompt a mode's turn gets. Extracted from App, where both were
// three-armed ternaries duplicated across the warm path and the submit path — a fourth mode made
// four places to keep in agreement, and the two paths MUST agree or a warm request builds a prefix
// the submit then misses on (#69/#81).
//
// `vibe` maps to plan here because its first internal phase is a plan turn; its implement phase
// submits with an explicit 'agent' override, the same way /implement does.
export function turnTools<T>(
  mode: Mode,
  lists: { agent: T; plan: T; chat: T; minimal: T; grind: T },
): T {
  if (mode === 'chat') return lists.chat;
  if (mode === 'plan' || mode === 'vibe') return lists.plan;
  if (mode === 'minimal') return lists.minimal;
  if (mode === 'grind') return lists.grind;
  return lists.agent;
}

// The PromptMode a mode's turn runs under. Minimal is deliberately absent from the result type: it
// runs as an 'agent' turn and carries its difference in the prompt's `minimal` flag, so that every
// `promptMode === 'agent'` branch in the loop — plan-handoff distill, plan progress, the done-gates
// — keeps working for it. See agent/prompt.ts.
export function turnPromptMode(mode: Mode): 'agent' | 'plan' | 'chat' {
  if (mode === 'chat') return 'chat';
  if (mode === 'plan' || mode === 'vibe') return 'plan';
  return 'agent';
}

// Whether a mode's turn uses the minimal (no upfront context, shell-only) system prompt.
export function isMinimalPrompt(mode: Mode): boolean {
  return mode === 'minimal';
}

// Whether a mode's turn uses the grind (#556) system prompt. Same shape as minimal: an 'agent' turn
// with a different prompt and tool list.
export function isGrindPrompt(mode: Mode): boolean {
  return mode === 'grind';
}

// Whether this turn may refine the plan above (#46). Vibe never refines: vibe's plan phase is a NEW
// task — it chains its own implementation off the same prompt, so a revision framing would carry
// the previous chain's steps into it. Keyed on the RECORDED mode because, as far as the loop is
// concerned, vibe's plan phase is an ordinary plan turn (turnPromptMode maps it to 'plan') and
// cannot tell the two apart itself — see RunTurnOptions.allowRefine in agent/loop.ts.
export function turnRefines(mode: Mode): boolean {
  return mode !== 'vibe';
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
  { name: 'implement', desc: 'switch to agent mode and execute the plan above' },
  { name: 'compact', desc: 'fold older context into a recap now (compaction note, then fold)' },
  {
    name: 'model',
    desc: 'pick a model/profile interactively (/model <name> switches directly, even to a model not in your config)',
  },
  { name: 'approvals', desc: 'show/toggle session auto-approve (on|off)' },
  {
    name: 'unattended',
    desc: 'show/toggle unattended — decline instead of prompting while you are away (on|off)',
  },
  {
    name: 'anon',
    desc: 'show/toggle anonymized display — hides your name, email, and account slugs (on|off)',
  },
  { name: 'cwd', desc: 'show working directory' },
  { name: 'tokens', desc: 'show token usage this session' },
  { name: 'skills', desc: 'list available skills (loaded from skills dirs)' },
  { name: 'stats', desc: 'show full session summary' },
  {
    name: 'save',
    desc: 'save the full conversation to ~/.config/reika/history, even mid-turn (--raw skips redaction)',
  },
  {
    name: 'resume',
    desc: 'resume a saved session — this project auto-saves as you go (root: the /save files)',
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

// Whether a submitted line is `/save` (with or without its `--raw` flag). App routes exactly this
// command past the busy queue (#226); it is a whole-word match so `/saved` or a skill named
// `/save-notes` still queue like anything else.
export function isSaveCommand(input: string): boolean {
  return /^\/save(?:\s|$)/i.test(input.trim());
}
