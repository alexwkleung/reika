import { expandPastes, type PastedText } from '../ui/pastes.js';
import type { Skill } from '../skills/skills.js';
import type { Mode } from '../types.js';

// The slash commands that end in a model turn: /implement, /compact, /search and a skill's
// /<name>. This module decides whether the command can run, which mode the turn runs in, what the
// model receives and what each scrollback line says. A front end echoes, switches mode and submits.

export type CommandNotice = {
  content: string;
  tone?: 'info' | 'warn';
  emphasis?: 'line' | 'lead';
};

export type TurnCommand =
  // The command cannot run here; the line says why.
  | { kind: 'refuse'; content: string }
  | {
      kind: 'submit';
      modelText: string;
      // The mode this one turn runs in, when that is not simply the current one.
      mode?: Mode;
      // The session moves to this mode for good (/implement out of plan mode).
      switchTo?: Mode;
      // Lines that go into the scrollback before the turn starts.
      before: CommandNotice[];
      // Receipts that follow the turn's user bubble.
      after: CommandNotice[];
      // The turn emits no user message, so the typed command is echoed by hand.
      echo: boolean;
      skill?: string;
      manualCompact?: boolean;
    };

export type TurnCommandContext = {
  mode: Mode;
  // /implement's picker answer, when it was asked (#561).
  implementMode?: ImplementMode;
  // Whether a turn in this mode has the `search` tool, read off the session's own tool lists.
  searchAvailable: (mode: Mode) => boolean;
  offline: () => boolean;
};

// `/name args`: the name lowercased, the args as typed after the first space.
export function parseCommand(raw: string): { name: string; args: string } {
  const rest = raw.slice(1);
  const space = rest.indexOf(' ');
  return {
    name: (space === -1 ? rest : rest.slice(0, space)).toLowerCase(),
    args: space === -1 ? '' : rest.slice(space + 1),
  };
}

// Null when `name` is not one of the three built-ins. A skill is resolved apart
// (`resolveSkillCommand`), after every built-in, since a built-in shadows a skill of its name.
export function resolveTurnCommand(
  name: string,
  args: string,
  ctx: TurnCommandContext,
): TurnCommand | null {
  const { mode } = ctx;
  if (name === 'implement') {
    if (mode === 'shell' || mode === 'chat') {
      return {
        kind: 'refuse',
        content: `/implement isn't available in ${mode} mode — use it from plan mode (or agent mode) to execute a plan.`,
      };
    }
    // From plan mode the picker chose the target (#561). Otherwise 'agent' for every mode but
    // minimal and grind, which stay themselves — handing either the full tool list and agent
    // prompt for one turn would undo the only thing the mode does, and silently.
    const target: ImplementMode =
      mode === 'plan'
        ? (ctx.implementMode ?? 'agent')
        : mode === 'minimal' || mode === 'grind'
          ? mode
          : 'agent';
    const label = target.charAt(0).toUpperCase() + target.slice(1);
    return {
      kind: 'submit',
      modelText: buildImplementPrompt(args),
      // Always explicit: a front end's own mode may not have caught up with `switchTo` yet.
      mode: target,
      ...(mode === 'plan' ? { switchTo: target } : {}),
      before: mode === 'plan' ? [{ content: `${label} mode — implementing the plan above.` }] : [],
      after: [],
      echo: false,
    };
  }
  if (name === 'compact') {
    // Manual compaction (#481). Not on the chat side (an isolated minibuffer is compacted by /new,
    // not by context pressure) or shell (no model history at all); vibe routes to an agent turn
    // the way /implement does, since its plan phase would otherwise claim the turn.
    if (mode === 'chat' || mode === 'shell') {
      return { kind: 'refuse', content: `/compact isn't available in ${mode} mode.` };
    }
    return {
      kind: 'submit',
      // Never reaches the loop: a manual compaction drops the user message.
      modelText: 'compact',
      ...(mode === 'vibe' ? { mode: 'agent' as const } : {}),
      before: [{ content: 'Compacting context…', tone: 'info', emphasis: 'line' }],
      after: [],
      echo: true,
      manualCompact: true,
    };
  }
  if (name === 'search') {
    // `/search <query>` (#829): the direct road to the search tool. A mode's own prompt says to
    // use `search` only when the answer needs current information, which leaves the decision to
    // the model; this makes it the user's.
    const query = args.trim();
    if (!query) {
      return {
        kind: 'refuse',
        content:
          'Usage: /search <query> — the model runs one web search and answers from the results.',
      };
    }
    const refusal = searchModeRefusal(mode);
    if (refusal) return { kind: 'refuse', content: refusal };
    // Vibe plans before it acts, and a search is a question, not a task: it runs as an agent turn,
    // the same one-turn override /implement and /compact take out of vibe.
    const target: Mode = mode === 'vibe' ? 'agent' : mode;
    if (!ctx.searchAvailable(target)) {
      return { kind: 'refuse', content: searchUnavailableNotice(ctx.offline()) };
    }
    return {
      kind: 'submit',
      modelText: buildSearchPrompt(query),
      ...(target === mode ? {} : { mode: target }),
      before: [],
      after: [],
      echo: false,
    };
  }
  return null;
}

// A skill typed as `/<name>`: its body is the prompt, with any text after the name appended. Null
// when no skill has that name. In vibe mode a skill plans then implements like any other prompt.
export function resolveSkillCommand(
  name: string,
  args: string,
  ctx: { skills: Skill[]; mode: Mode; pastes?: PastedText[] },
): Extract<TurnCommand, { kind: 'submit' }> | null {
  const skill = ctx.skills.find(s => s.name === name);
  if (!skill) return null;
  const extra = ctx.pastes ? expandPastes(args.trim(), ctx.pastes) : args.trim();
  return {
    kind: 'submit',
    modelText: extra ? `${skill.body}\n\n${extra}` : skill.body,
    ...(ctx.mode === 'vibe' ? { mode: 'vibe' as const } : {}),
    before: [],
    // The bubble echoes what was typed; only this line says the body is what the model got (#398).
    after: [
      {
        content: `Skill /${skill.name} applied — its body was sent as this prompt${extra ? ', with your text after it' : ''}.`,
        tone: 'info',
      },
    ],
    echo: false,
    skill: skill.name,
  };
}

// The modes /implement can hand a plan to from plan mode (#561), in the picker's row order. Agent
// first: it was the only target before the picker, so Enter alone keeps that. Vibe is absent — it
// would plan again — and chat/shell cannot edit.
export const IMPLEMENT_MODES = ['agent', 'minimal', 'grind'] as const;
export type ImplementMode = (typeof IMPLEMENT_MODES)[number];

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

// The model-facing prompt for /search (#829). Written like a shipped skill's body — the command
// hands over instructions, not a bare query — because the thing it exists for is the model that
// would otherwise answer a web question from memory: `search` is in every list the mode can reach,
// and a weak model uses it only when the first line says to. The rest is the discipline the search
// and fetch budgets already price: one query, the results as given, and no answer the results do not
// support. Not a bundled skill (the other option the issue raised): a skill's `requires:` is checked
// from files alone at load time (PATH, git remote) with no config in scope, so it could not be
// hidden on a machine with no provider, nor refuse in minimal mode, whose list has no web tools at
// all — it would offer a slash command whose first call cannot run.
export function buildSearchPrompt(query: string): string {
  return [
    `Search the web for: ${query.trim()}`,
    '',
    'Your first action is a `search` tool call with that query. Answer from its results, not from memory.',
    '',
    '- Give each claim the URL the results returned, verbatim.',
    '- Open the one or two most promising results with `fetch_url` before leaning on a snippet.',
    '- If the results are off-topic, say so and stop — do not re-run the query in other words.',
    '- If the search fails or is unavailable, say that in one line instead of answering from memory.',
  ].join('\n');
}

// Why /search cannot run in this mode, or undefined when it can. Checked before the provider, since
// the fix differs: shell has no model turn to hand the query to, and minimal mode's list is bash
// only — the same structural exclusions that keep the web pair out of those two modes
// (tools/index.ts).
export function searchModeRefusal(mode: Mode): string | undefined {
  const elsewhere = '/agent, /plan, /chat or /grind to search.';
  if (mode === 'shell') return `/search needs a model turn, and shell mode has none — ${elsewhere}`;
  if (mode === 'minimal')
    return `/search needs the web tools, and minimal mode carries none — ${elsewhere}`;
  return undefined;
}

// The other refusal: the mode could search, but this session registered no `search` tool. Two causes
// with two different fixes, so they are named apart — and the provider one names the switches, the
// only place the user can act (`search.ts` keeps its own remedy out of the model's context for the
// same reason).
export function searchUnavailableNotice(offline: boolean): string {
  return offline
    ? '/search is off for this session: it started with no route out, so the web tools were not loaded (#392).'
    : 'No search provider is configured, so this session has no `search` tool. Set REIKA_SEARXNG_URL to a SearXNG instance, or REIKA_CDP_SEARCH=1 to search through Chrome.';
}

export function isImplementCommand(input: string): boolean {
  return /^\/implement(?:\s|$)/i.test(input.trim());
}
