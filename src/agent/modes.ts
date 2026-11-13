import type { Mode } from '../types.js';

// What a mode is to the harness: its place in the cycle, the history side it lives on, the tool
// list and prompt its turns get, and what switching to it by command comes to. A front end holds
// the current mode and carries a switch out.

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

// Chat keeps a history of its own; every other mode shares the agent side's, which is how a plan
// carries into its implementation.
export function modeSide(mode: Mode): 'agent' | 'chat' {
  return mode === 'chat' ? 'chat' : 'agent';
}

// The line a mode command prints once the switch is made.
export const MODE_BANNERS: Record<Mode, string> = {
  agent: 'Agent mode.',
  shell: 'Shell mode. Commands run directly in cwd. /agent to return.',
  chat: 'Chat mode. Filesystem and shell tools disabled. Conversation isolated from agent. /agent to return.',
  plan: 'Plan mode — read-only exploration; will end with a written plan. Send another message to refine that plan, or /implement (agent, minimal or grind) to execute it.',
  vibe: 'Vibe mode — each prompt is planned first (read-only), then the plan is implemented automatically. Approvals apply as usual. /agent to return.',
  minimal:
    'Minimal mode — shell only, and no repo map, project summary, or AGENTS.md in the prompt. The model works from what commands show it. /agent to return.',
  grind:
    'Grind mode — the model works through a fixed procedure: pin down the task, explore, choose, change, prove it by running checks, review the diff, report what was verified. Tools: bash, read, edit. /agent to return.',
};

export type ModeCommand =
  | { kind: 'refuse'; content: string }
  | { kind: 'switch'; to: Mode; banner: string };

// `/agent`, `/plan` and the rest: null when `name` is not a mode. A mode picks the running turn's
// tools and prompt, so a switch waits for the turn to end.
export function resolveModeCommand(
  name: string,
  ctx: { mode: Mode; busy: boolean },
): ModeCommand | null {
  const to = MODE_CYCLE.find(m => m === name);
  if (!to) return null;
  if (to === ctx.mode) return { kind: 'refuse', content: `Already in ${to} mode.` };
  if (ctx.busy) {
    return { kind: 'refuse', content: 'Cannot switch modes while busy. Wait or ctrl-c to abort.' };
  }
  return { kind: 'switch', to, banner: MODE_BANNERS[to] };
}
